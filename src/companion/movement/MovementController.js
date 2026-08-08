import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import {
    alignPathToDoorGaps,
    createSafeMovements,
    DEFAULT_SAFE_MAX_DROP_DOWN,
    enforceSafeMovements
} from '../blockProtection.js';
import { hasLineOfSightFrom } from '../../world/lineOfSight.js';

/** Climb goals may block Follow only briefly. */
const DEFAULT_CLIMB_HOLD_MS = 2000;
/** Drop a climb lock if the bot has not moved this far within STALL_MS. */
const STALL_DISTANCE = 0.4;
const STALL_MS = 1500;
/** Keep still while A* looks for a complete detour to the cutoff position. */
export const UNREACHABLE_SEARCH_GRACE_MS = 2000;
/** Recheck a waiting companion's live owner route at this interval. */
export const UNREACHABLE_REPROBE_MS = 1000;
/** Bound synchronous route probes so the companion loop stays responsive. */
const UNREACHABLE_REPROBE_TIMEOUT_MS = 100;

/**
 * Prevent an incomplete follow route from moving the bot toward an arbitrary
 * A* frontier while the controller is still looking for a complete detour,
 * and reject a completed route that only reaches the far side of a wall around
 * the followed player.
 *
 * The path array is shared with mineflayer-pathfinder, so clearing it here
 * prevents that route from being executed. The controller freezes the owner's
 * position at that moment, then moves along a door-free best-effort route.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{status?:string,path?:Array<{
 *   x:number,y:number,z:number
 * }>}} result
 * @param {import('prismarine-entity').Entity|null|undefined} target
 * @returns {'partial-follow-route'|'obstructed-target-endpoint'|null}
 */
export function suppressUnsafeFollowPath(bot, result, target) {
    if (!target?.position || !Array.isArray(result?.path)) return null;

    if (result.status === 'partial') {
        result.path.length = 0;
        return 'partial-follow-route';
    }

    const endpoint = result.path.at(-1);
    if (result.status !== 'success' || !endpoint) return null;

    const feet = new Vec3(
        Number.isInteger(endpoint.x) ? endpoint.x + 0.5 : endpoint.x,
        endpoint.y,
        Number.isInteger(endpoint.z) ? endpoint.z + 0.5 : endpoint.z
    );
    const visible = hasLineOfSightFrom(
        bot.world,
        { position: feet, height: bot.entity?.height ?? 1.8 },
        target
    );
    if (visible) return null;

    result.path.length = 0;
    return 'obstructed-target-endpoint';
}
/**
 * Sole owner of mineflayer-pathfinder for the companion.
 *
 * Rule: Follow is the default. Climb goals are short-lived and auto-released
 * if they make no progress, so the bot never freezes in place.
 */
export class MovementController {
    /**
     * @param {import('mineflayer').Bot} bot
     * @param {{
     *   now?: () => number,
     *   schedule?: (callback: () => void, delay: number) => any,
     *   cancelSchedule?: (handle: any) => void
     * }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.now = options.now || Date.now;
        this.schedule = options.schedule || setTimeout;
        this.cancelSchedule = options.cancelSchedule || clearTimeout;
        this.movements = buildMovements(bot);
        this.unreachableFallbackMovements = buildMovements(bot);
        this.unreachableFallbackMovements._trailmateDisableDoorOpening = true;
        this.unreachableFallbackMovements.canOpenDoors = false;
        enforceSafeMovements(bot);
        bot.pathfinder.setMovements(this.movements);

        // mineflayer-pvp otherwise installs its own dig-enabled Movements on
        // every attack. Movement stays owned by this controller.
        if (bot.pvp) bot.pvp.movements = null;

        this.status = 'idle';
        this._goalKey = null;
        this._goal = null;
        /** @type {{ x: number, y: number, z: number }|null} */
        this._lastSeekPos = null;
        this._holdUntil = 0;
        this._holdOrigin = null;
        this._holdStartedAt = 0;
        this._endpointVisibilityTarget = null;
        this._lastRouteSuppressionKey = null;
        this._unreachableFallbackActive = false;
        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackPosition = null;
        this._unreachableFallbackGoal = null;
        this._unreachableVerificationTarget = null;
        this._unreachableFallbackTimer = null;
        this._unreachableFallbackWaiting = false;
        this._lastUnreachableProbeAt = 0;

        bot.on('path_update', (result) => {
            if (this._unreachableFallbackActive) {
                this.status = result.status;
                alignPathToDoorGaps(bot, result.path);
                if (result.status === 'noPath' || result.status === 'timeout') {
                    if (Array.isArray(result.path)) result.path.length = 0;
                    this._markUnreachableWaiting('fallback-no-path');
                }
                return;
            }

            const rejectedEndpoint = result.path?.at(-1) || null;
            const suppressed = suppressUnsafeFollowPath(
                bot,
                result,
                this._endpointVisibilityTarget
            );
            if (suppressed) {
                this.status = 'searching';
                this._logRouteSuppression(suppressed, result, rejectedEndpoint);
                this._scheduleCutoffFallback(this._endpointVisibilityTarget?.position);
                return;
            }

            if (this._endpointVisibilityTarget?.position
                && (result.status === 'noPath' || result.status === 'timeout')) {
                if (Array.isArray(result.path)) result.path.length = 0;
                this.status = 'unreachable';
                this._logRouteSuppression(`follow-${result.status}`, result, rejectedEndpoint);
                if (this._unreachableFallbackScheduled) {
                    this._cancelPendingCutoffFallback();
                }
                this._scheduleCutoffFallback(this._endpointVisibilityTarget.position, 0);
                return;
            }

            if (this._unreachableFallbackScheduled
                && result.status === 'success'
                && this._goal === this._unreachableFallbackGoal) {
                this._cancelPendingCutoffFallback();
                this._unreachableFallbackActive = true;
                this._unreachableFallbackWaiting = false;
                this.status = 'success';
                this._lastRouteSuppressionKey = null;
                alignPathToDoorGaps(bot, result.path);
                console.log(`[companion] follow-route-fallback ${JSON.stringify({
                    strategy: 'complete-route-to-cutoff-position',
                    phase: 'catching-up',
                    position: this._unreachableFallbackPosition
                })}`);
                return;
            }

            this._cancelPendingCutoffFallback();
            this._lastRouteSuppressionKey = null;
            this.status = result.status;
            alignPathToDoorGaps(bot, result.path);
        });

        bot.on('goal_reached', () => {
            if (this._unreachableFallbackActive) {
                this._markUnreachableWaiting('cutoff-endpoint-reached');
                return;
            }
            this.status = 'arrived';
            this._clearHold();
            if (this._goalKey && (this._goalKey.startsWith('climb:') || this._goalKey.startsWith('seek:'))) {
                this._goalKey = null;
            }
        });
    }

    /**
     * True only while the pathfinder is still running OUR goal. Plugins such as
     * mineflayer-pvp replace the goal to chase mobs; treat that as "no goal" so
     * the next tick re-asserts the companion goal.
     */
    get hasGoal() {
        const active = this.bot.pathfinder.goal;
        if (!active) return false;
        return active === this._goal || active === this._unreachableFallbackGoal;
    }

    get isMoving() {
        try {
            return this.bot.pathfinder.isMoving();
        } catch {
            return false;
        }
    }

    get isBlocked() {
        return this.status === 'noPath' || this.status === 'timeout';
    }

    get isUnreachable() {
        return this.status === 'unreachable';
    }

    get isRoutePending() {
        return this.status === 'searching';
    }

    get isUnreachableFallback() {
        return this._unreachableFallbackActive || this._unreachableFallbackScheduled;
    }

    get isTryingToMove() {
        return this.isMoving;
    }

    get isHeld() {
        return Date.now() < this._holdUntil;
    }

    /**
     * Follow a moving entity. Always clears climb holds so chasing never sticks.
     * Used while climbing where a tight GoalFollow is safer than a behind-anchor.
     * @param {import('prismarine-entity').Entity} entity
     * @param {number} range
     * @param {{
     *   rejectIf?: () => boolean,
     *   endpointVisibilityTarget?: import('prismarine-entity').Entity|null
     * }} [options]
     */
    followEntity(entity, range, options = {}) {
        const rejected = typeof options.rejectIf === 'function' && options.rejectIf();
        if (rejected) {
            return false;
        }
        this._releaseClimbHold();
        const visibilityTarget = options.endpointVisibilityTarget || null;
        const goal = new pf.goals.GoalFollow(entity, range);
        if (this.isUnreachableFallback
            && !this._resumeFromUnreachableIfReachable(goal, visibilityTarget)) {
            return false;
        }
        const key = `follow:${entity.id}:${range}:${visibilityTarget ? 'guarded' : 'plain'}`;
        if (this._goalKey === key && this.hasGoal && !this.isBlocked) return false;
        this._goalKey = key;
        this._setGoal(goal, { visibilityTarget });
        return true;
    }

    /**
     * Walk toward a fixed world position (last-known owner, etc.). No climb hold.
     * @param {{x: number, y: number, z: number}} pos
     * @param {number} [range=2]
     * @param {{
     *   rejectIf?: () => boolean,
     *   endpointVisibilityTarget?: import('prismarine-entity').Entity|null
     * }} [options]
     */
    goToward(pos, range = 2, options = {}) {
        if (typeof options.rejectIf === 'function' && options.rejectIf()) {
            return false;
        }
        this._releaseClimbHold();
        const visibilityTarget = options.endpointVisibilityTarget || null;
        const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, range);
        if (this.isUnreachableFallback
            && !this._resumeFromUnreachableIfReachable(goal, visibilityTarget)) {
            return false;
        }
        const key = `seek:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}:${range}:${visibilityTarget ? 'guarded' : 'plain'}`;
        const last = this._lastSeekPos;
        const drifted = !last
            || Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) > 0.5;
        // Refresh when the continuous target drifts, even if the floor key is unchanged.
        if (this._goalKey === key && this.hasGoal && !drifted) return false;
        this._goalKey = key;
        this._lastSeekPos = { x: pos.x, y: pos.y, z: pos.z };
        this._setGoal(goal, { visibilityTarget });
        return true;
    }

    /**
     * Walk toward a fixed ledge. Hold is short and watchdog-cleared on stall.
     * @param {{x: number, y: number, z: number}} pos
     * @param {number} holdMs
     */
    climbTo(pos, holdMs = DEFAULT_CLIMB_HOLD_MS) {
        const key = `climb:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
        this._holdUntil = Date.now() + holdMs;
        this._holdOrigin = this.bot.entity.position.clone();
        this._holdStartedAt = Date.now();
        if (this._goalKey === key && this.hasGoal) return false;
        this._goalKey = key;
        this._setGoal(new pf.goals.GoalNear(pos.x, pos.y, pos.z, 1));
        return true;
    }

    /**
     * Call every companion tick. Releases climb locks that are not progressing.
     */
    tickHoldWatchdog() {
        if (!this.isHeld || !this._holdOrigin || !this._holdStartedAt) return;

        const pos = this.bot.entity.position;
        if (this._holdOrigin.distanceTo(pos) >= STALL_DISTANCE) {
            this._holdOrigin = pos.clone();
            this._holdStartedAt = Date.now();
            return;
        }

        if (Date.now() - this._holdStartedAt < STALL_MS) return;

        this._clearHold();
        if (this._goalKey && this._goalKey.startsWith('climb:')) {
            this._goalKey = null;
        }
    }

    stop() {
        this._cancelPendingCutoffFallback();
        this._goalKey = null;
        this._goal = null;
        this._lastSeekPos = null;
        this._endpointVisibilityTarget = null;
        this._lastRouteSuppressionKey = null;
        this._unreachableFallbackActive = false;
        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackPosition = null;
        this._unreachableFallbackGoal = null;
        this._unreachableVerificationTarget = null;
        this._unreachableFallbackWaiting = false;
        this._lastUnreachableProbeAt = 0;
        this.status = 'idle';
        this._clearHold();
        try {
            this.bot.pathfinder.setGoal(null);
        } catch {
            // pathfinderがまだ準備できていない場合がある
        }
    }

    /**
     * pathfinderのダッシュを切り替える。Followは歩行を維持し、戦闘退避時だけ有効にする。
     * @param {boolean} allowed
     */
    setSprintAllowed(allowed) {
        const next = allowed === true;
        if (this.movements.allowSprinting === next) return;
        this.movements.allowSprinting = next;
        try {
            const activeMovements = this._unreachableFallbackActive
                ? this.unreachableFallbackMovements
                : this.movements;
            this.bot.pathfinder.setMovements(activeMovements);
            if (this._unreachableFallbackActive) {
                this.unreachableFallbackMovements.canOpenDoors = false;
            }
        } catch {
            // pathfinderがまだ準備できていない場合がある
        }
    }

    _clearHold() {
        this._holdUntil = 0;
        this._holdOrigin = null;
        this._holdStartedAt = 0;
    }

    /** Drop climb holds so follow / seek can take over immediately. */
    _releaseClimbHold() {
        this._clearHold();
        if (this._goalKey && this._goalKey.startsWith('climb:')) {
            this._goalKey = null;
        }
    }

    _setGoal(goal, options = {}) {
        // Re-apply after combat/legacy modes may have overwritten pathfinder movements.
        this._cancelPendingCutoffFallback();
        this._endpointVisibilityTarget = options.visibilityTarget || null;
        this._lastRouteSuppressionKey = null;
        this._unreachableFallbackActive = false;
        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackGoal = null;
        this._unreachableVerificationTarget = null;
        this._unreachableFallbackPosition = null;
        this._unreachableFallbackWaiting = false;
        this.bot.pathfinder.setMovements(this.movements);
        this.status = 'searching';
        this._goal = goal;
        this.bot.pathfinder.setGoal(goal, true);
    }

    /**
     * Freeze the owner's position at the first incomplete route. A* keeps its
     * current search for a short grace period while the emitted partial path is
     * held stationary. If no complete route appears, follow a door-free partial
     * route toward this frozen cutoff position.
     * @param {{x:number,y:number,z:number}|null|undefined} position
     * @param {number} [delayMs]
     */
    _scheduleCutoffFallback(position, delayMs = UNREACHABLE_SEARCH_GRACE_MS) {
        if (this._unreachableFallbackActive || this._unreachableFallbackScheduled
            || !this._goal || !position) return;

        this._unreachableFallbackPosition = new Vec3(position.x, position.y, position.z);
        this._unreachableVerificationTarget = {
            position: this._unreachableFallbackPosition.clone(),
            height: this._endpointVisibilityTarget?.height ?? 1.8
        };
        this._unreachableFallbackGoal = new pf.goals.GoalNear(
            this._unreachableFallbackPosition.x,
            this._unreachableFallbackPosition.y,
            this._unreachableFallbackPosition.z,
            1
        );
        this._unreachableFallbackScheduled = true;
        this._unreachableFallbackTimer = this.schedule(() => {
            this._unreachableFallbackTimer = null;
            if (!this._unreachableFallbackScheduled) return;
            this._startCutoffFallback();
        }, delayMs);
        queueMicrotask(() => {
            if (!this._unreachableFallbackScheduled || !this._unreachableFallbackGoal) return;
            this._goalKey = `cutoff:${this._unreachableFallbackPosition.x}:${this._unreachableFallbackPosition.y}:${this._unreachableFallbackPosition.z}`;
            this._goal = this._unreachableFallbackGoal;
            this._endpointVisibilityTarget = this._unreachableVerificationTarget;
            this.bot.pathfinder.setMovements(this.movements);
            this.bot.pathfinder.setGoal(this._unreachableFallbackGoal, false);
        });
        console.log(`[companion] follow-route-cutoff ${JSON.stringify({
            phase: 'verifying',
            graceMs: delayMs,
            position: this._unreachableFallbackPosition
        })}`);
    }

    _startCutoffFallback() {
        const cutoff = this._unreachableFallbackPosition;
        if (!cutoff || !this._goal) return;

        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackActive = true;
        this._unreachableFallbackWaiting = false;
        this._goal = this._unreachableFallbackGoal;
        this._endpointVisibilityTarget = this._unreachableVerificationTarget;
        this.status = 'searching';
        this.unreachableFallbackMovements.canOpenDoors = false;
        this.bot.pathfinder.setMovements(this.unreachableFallbackMovements);
        // The safety wrapper re-applies defaults to the same object.
        this.unreachableFallbackMovements.canOpenDoors = false;
        this.bot.pathfinder.setGoal(this._unreachableFallbackGoal, false);
        console.log(`[companion] follow-route-fallback ${JSON.stringify({
            strategy: 'best-effort-to-cutoff-position',
            phase: 'catching-up',
            position: cutoff
        })}`);
    }

    _cancelPendingCutoffFallback() {
        if (this._unreachableFallbackTimer != null) {
            this.cancelSchedule(this._unreachableFallbackTimer);
            this._unreachableFallbackTimer = null;
        }
        this._unreachableFallbackScheduled = false;
    }

    _markUnreachableWaiting(reason) {
        if (!this._unreachableFallbackActive || this._unreachableFallbackWaiting) return;
        this._unreachableFallbackWaiting = true;
        this.status = 'unreachable';
        this._lastUnreachableProbeAt = this.now() - UNREACHABLE_REPROBE_MS;
        console.log(`[companion] follow-route-fallback ${JSON.stringify({
            strategy: 'best-effort-to-cutoff-position',
            phase: 'waiting',
            reason,
            position: this._unreachableFallbackPosition,
            bot: this.bot.entity?.position || null
        })}`);
    }

    _resumeFromUnreachableIfReachable(goal, visibilityTarget) {
        if (!this._unreachableFallbackWaiting) return false;
        const now = this.now();
        if (now - this._lastUnreachableProbeAt < UNREACHABLE_REPROBE_MS) return false;
        this._lastUnreachableProbeAt = now;

        let result = null;
        try {
            const probe = this.bot.pathfinder.getPathFromTo(
                this.movements,
                this.bot.entity.position,
                goal,
                {
                    timeout: UNREACHABLE_REPROBE_TIMEOUT_MS,
                    tickTimeout: UNREACHABLE_REPROBE_TIMEOUT_MS
                }
            );
            result = probe.next().value?.result || null;
        } catch {
            return false;
        }
        if (result?.status !== 'success') return false;

        const rejected = suppressUnsafeFollowPath(this.bot, result, visibilityTarget);
        if (rejected) return false;

        console.log(`[companion] follow-route-fallback ${JSON.stringify({
            strategy: 'best-effort-to-cutoff-position',
            phase: 'resumed',
            position: this._unreachableFallbackPosition,
            target: visibilityTarget?.position || null
        })}`);
        this._unreachableFallbackActive = false;
        this._unreachableFallbackWaiting = false;
        this._unreachableFallbackGoal = null;
        this._unreachableVerificationTarget = null;
        this._unreachableFallbackPosition = null;
        this._goalKey = null;
        return true;
    }

    _logRouteSuppression(reason, result, endpoint = null) {
        const target = this._endpointVisibilityTarget;
        const targetCell = target?.position
            ? `${Math.floor(target.position.x)},${Math.floor(target.position.y)},${Math.floor(target.position.z)}`
            : 'none';
        const key = `${reason}:${targetCell}`;
        if (this._lastRouteSuppressionKey === key) return;
        this._lastRouteSuppressionKey = key;
        console.log(`[companion] follow-route-suppressed ${JSON.stringify({
            reason,
            pathStatus: result.status || null,
            bot: this.bot.entity?.position || null,
            target: target?.position || null,
            endpoint
        })}`);
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 */
function buildMovements(bot) {
    return createSafeMovements(bot, {
        allowParkour: true,
        allowSprinting: false,
        maxDropDown: DEFAULT_SAFE_MAX_DROP_DOWN
    });
}
