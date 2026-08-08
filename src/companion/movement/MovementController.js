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
const CUTOFF_PHASE = Object.freeze({
    VERIFYING: 'verifying',
    CATCHING_UP: 'catching-up',
    WAITING: 'waiting'
});

/**
 * @typedef {Object} CutoffState
 * @property {'verifying'|'catching-up'|'waiting'} phase
 * @property {import('vec3').Vec3} position
 * @property {any} goal
 * @property {{position:import('vec3').Vec3,height:number}} visibilityTarget
 * @property {any} timer
 * @property {number} lastProbeAt
 */

function isFailedPathStatus(status) {
    return status === 'noPath' || status === 'timeout';
}

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
        this._cutoffMovements = buildMovements(bot);
        this._cutoffMovements._trailmateDisableDoorOpening = true;
        this._cutoffMovements.canOpenDoors = false;
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
        /** @type {CutoffState|null} */
        this._cutoff = null;

        bot.on('path_update', (result) => this._handlePathUpdate(result));

        bot.on('goal_reached', () => {
            if (this._isCutoffActive()) {
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
        return active === this._goal || active === this._cutoff?.goal;
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
        return this._cutoff !== null;
    }

    get isTryingToMove() {
        return this.isMoving;
    }

    get isHeld() {
        return Date.now() < this._holdUntil;
    }

    _handlePathUpdate(result) {
        if (this._isCutoffActive()) {
            this.status = result.status;
            alignPathToDoorGaps(this.bot, result.path);
            if (isFailedPathStatus(result.status)) {
                if (Array.isArray(result.path)) result.path.length = 0;
                this._markUnreachableWaiting('fallback-no-path');
            }
            return;
        }

        const rejectedEndpoint = result.path?.at(-1) || null;
        const suppressed = suppressUnsafeFollowPath(
            this.bot,
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
            && isFailedPathStatus(result.status)) {
            if (Array.isArray(result.path)) result.path.length = 0;
            this.status = 'unreachable';
            this._logRouteSuppression(`follow-${result.status}`, result, rejectedEndpoint);
            const cutoffPosition = this._endpointVisibilityTarget.position;
            this._clearCutoffState();
            this._scheduleCutoffFallback(cutoffPosition, 0);
            return;
        }

        if (this._isCutoffVerifying()
            && result.status === 'success'
            && this._goal === this._cutoff.goal) {
            this._cancelCutoffTimer();
            this._cutoff.phase = CUTOFF_PHASE.CATCHING_UP;
            this.status = 'success';
            this._lastRouteSuppressionKey = null;
            alignPathToDoorGaps(this.bot, result.path);
            this._logCutoffFallback('complete-route-to-cutoff-position');
            return;
        }

        this._clearCutoffState();
        this._lastRouteSuppressionKey = null;
        this.status = result.status;
        alignPathToDoorGaps(this.bot, result.path);
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
        this._clearCutoffState();
        this._goalKey = null;
        this._goal = null;
        this._lastSeekPos = null;
        this._endpointVisibilityTarget = null;
        this._lastRouteSuppressionKey = null;
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
            const activeMovements = this._isCutoffActive()
                ? this._cutoffMovements
                : this.movements;
            this.bot.pathfinder.setMovements(activeMovements);
            if (this._isCutoffActive()) {
                this._cutoffMovements.canOpenDoors = false;
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
        this._clearCutoffState();
        this._endpointVisibilityTarget = options.visibilityTarget || null;
        this._lastRouteSuppressionKey = null;
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
        if (this._cutoff || !this._goal || !position) return;

        const cutoffPosition = new Vec3(position.x, position.y, position.z);
        const visibilityTarget = {
            position: cutoffPosition.clone(),
            height: this._endpointVisibilityTarget?.height ?? 1.8
        };
        const cutoffGoal = new pf.goals.GoalNear(
            cutoffPosition.x,
            cutoffPosition.y,
            cutoffPosition.z,
            1
        );
        const cutoff = {
            phase: CUTOFF_PHASE.VERIFYING,
            position: cutoffPosition,
            goal: cutoffGoal,
            visibilityTarget,
            timer: null,
            lastProbeAt: 0
        };
        this._cutoff = cutoff;
        cutoff.timer = this.schedule(() => {
            cutoff.timer = null;
            if (this._cutoff !== cutoff || !this._isCutoffVerifying()) return;
            this._startCutoffFallback();
        }, delayMs);
        queueMicrotask(() => {
            if (this._cutoff !== cutoff || !this._isCutoffVerifying()) return;
            this._goalKey = `cutoff:${cutoffPosition.x}:${cutoffPosition.y}:${cutoffPosition.z}`;
            this._goal = cutoffGoal;
            this._endpointVisibilityTarget = visibilityTarget;
            this.bot.pathfinder.setMovements(this.movements);
            this.bot.pathfinder.setGoal(cutoffGoal, false);
        });
        console.log(`[companion] follow-route-cutoff ${JSON.stringify({
            phase: CUTOFF_PHASE.VERIFYING,
            graceMs: delayMs,
            position: cutoffPosition
        })}`);
    }

    _startCutoffFallback() {
        const cutoff = this._cutoff;
        if (!cutoff || !this._isCutoffVerifying() || !this._goal) return;

        cutoff.phase = CUTOFF_PHASE.CATCHING_UP;
        this._goal = cutoff.goal;
        this._endpointVisibilityTarget = cutoff.visibilityTarget;
        this.status = 'searching';
        this._cutoffMovements.canOpenDoors = false;
        this.bot.pathfinder.setMovements(this._cutoffMovements);
        // The safety wrapper re-applies defaults to the same object.
        this._cutoffMovements.canOpenDoors = false;
        this.bot.pathfinder.setGoal(cutoff.goal, false);
        this._logCutoffFallback('best-effort-to-cutoff-position');
    }

    _isCutoffVerifying() {
        return this._cutoff?.phase === CUTOFF_PHASE.VERIFYING;
    }

    _isCutoffActive() {
        return this._cutoff?.phase === CUTOFF_PHASE.CATCHING_UP
            || this._cutoff?.phase === CUTOFF_PHASE.WAITING;
    }

    _cancelCutoffTimer() {
        if (this._cutoff?.timer != null) {
            this.cancelSchedule(this._cutoff.timer);
            this._cutoff.timer = null;
        }
    }

    _clearCutoffState() {
        this._cancelCutoffTimer();
        this._cutoff = null;
    }

    _markUnreachableWaiting(reason) {
        if (this._cutoff?.phase !== CUTOFF_PHASE.CATCHING_UP) return;
        this._cutoff.phase = CUTOFF_PHASE.WAITING;
        this.status = 'unreachable';
        this._cutoff.lastProbeAt = this.now() - UNREACHABLE_REPROBE_MS;
        console.log(`[companion] follow-route-fallback ${JSON.stringify({
            strategy: 'best-effort-to-cutoff-position',
            phase: CUTOFF_PHASE.WAITING,
            reason,
            position: this._cutoff.position,
            bot: this.bot.entity?.position || null
        })}`);
    }

    _resumeFromUnreachableIfReachable(goal, visibilityTarget) {
        const cutoff = this._cutoff;
        if (cutoff?.phase !== CUTOFF_PHASE.WAITING) return false;
        const now = this.now();
        if (now - cutoff.lastProbeAt < UNREACHABLE_REPROBE_MS) return false;
        cutoff.lastProbeAt = now;

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
            position: cutoff.position,
            target: visibilityTarget?.position || null
        })}`);
        this._clearCutoffState();
        this._goalKey = null;
        return true;
    }

    _logCutoffFallback(strategy) {
        if (!this._cutoff) return;
        console.log(`[companion] follow-route-fallback ${JSON.stringify({
            strategy,
            phase: this._cutoff.phase,
            position: this._cutoff.position
        })}`);
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
