import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import {
    alignPathToDoorGaps,
    createSafeMovements,
    DEFAULT_SAFE_MAX_DROP_DOWN,
    enforceSafeMovements
} from '../blockProtection.js';
import { hasLineOfSightFrom } from '../../world/lineOfSight.js';
import {
    isCloseablePassage,
    isPassageRequiredForOwner
} from './DoorTracker.js';

/** Climb goals may block Follow only briefly. */
const DEFAULT_CLIMB_HOLD_MS = 2000;
/** Drop a climb lock if the bot has not moved this far within STALL_MS. */
const STALL_DISTANCE = 0.4;
const STALL_MS = 1500;
/** Nearby partial follow routes stay paused until A* produces a final result. */
const GUARDED_PARTIAL_DISTANCE = 32;

/**
 * Prevent a nearby partial route from moving the bot toward an arbitrary A*
 * frontier, and reject a completed route that only reaches the far side of a
 * wall around the followed player.
 *
 * The path array is shared with mineflayer-pathfinder, so clearing it here
 * prevents that route from being executed. The controller then returns to the
 * last owner position confirmed by a successful route and waits there.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{status?:string,path?:Array<{
 *   x:number,y:number,z:number,
 *   toPlace?:Array<{x:number,y:number,z:number,useOne?:boolean}>
 * }>}} result
 * @param {import('prismarine-entity').Entity|null|undefined} target
 * @returns {'unrelated-passage-route'|'partial-nearby-target'|'obstructed-target-endpoint'|null}
 */
export function suppressUnsafeFollowPath(bot, result, target) {
    if (!target?.position || !Array.isArray(result?.path)) return null;

    const botPos = bot.entity?.position;
    if (!botPos) return null;

    // Pathfinder can report a successful route by detouring through a nearby
    // door or gate that does not actually separate the bot from its owner.
    // Reject that route before movement starts; blocking activateBlock later
    // is too late because the bot has already walked to the passage.
    for (const node of result.path) {
        for (const action of node.toPlace || []) {
            if (action?.useOne !== true) continue;
            let block = null;
            try {
                block = bot.blockAt?.(new Vec3(action.x, action.y, action.z));
            } catch {
                continue;
            }
            if (!isCloseablePassage(block)) continue;
            if (isPassageRequiredForOwner(block, botPos, target.position)) continue;

            result.path.length = 0;
            return 'unrelated-passage-route';
        }
    }

    const distance = Math.hypot(
        target.position.x - botPos.x,
        target.position.z - botPos.z
    );

    if (result.status === 'partial' && distance <= GUARDED_PARTIAL_DISTANCE) {
        result.path.length = 0;
        return 'partial-nearby-target';
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
     */
    constructor(bot) {
        this.bot = bot;
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
        this._fallbackTargetId = null;
        this._unreachableFallbackGoal = null;

        bot.on('path_update', (result) => {
            if (this._unreachableFallbackActive) {
                this.status = result.status;
                alignPathToDoorGaps(bot, result.path);
                return;
            }

            const rejectedEndpoint = result.path?.at(-1) || null;
            const suppressed = suppressUnsafeFollowPath(
                bot,
                result,
                this._endpointVisibilityTarget
            );
            if (suppressed) {
                this.status = 'unreachable';
                this._logRouteSuppression(suppressed, result, rejectedEndpoint);
                this._scheduleLastReachableFallback();
                return;
            }

            this._lastRouteSuppressionKey = null;
            this.status = result.status;
            if (result.status === 'success') {
                this._rememberAcceptedTargetPosition();
            }
            alignPathToDoorGaps(bot, result.path);
        });

        bot.on('goal_reached', () => {
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
     *   endpointVisibilityTarget?: import('prismarine-entity').Entity|null,
     *   unreachableFallbackPosition?: {x:number,y:number,z:number}|null
     * }} [options]
     */
    followEntity(entity, range, options = {}) {
        const rejected = typeof options.rejectIf === 'function' && options.rejectIf();
        if (rejected) {
            return false;
        }
        this._releaseClimbHold();
        if (this.isUnreachableFallback) return false;
        const visibilityTarget = options.endpointVisibilityTarget || null;
        const key = `follow:${entity.id}:${range}:${visibilityTarget ? 'guarded' : 'plain'}`;
        if (this._goalKey === key && this.hasGoal && !this.isBlocked) return false;
        this._goalKey = key;
        this._setGoal(new pf.goals.GoalFollow(entity, range), {
            visibilityTarget,
            fallbackPosition: options.unreachableFallbackPosition
        });
        return true;
    }

    /**
     * Walk toward a fixed world position (last-known owner, etc.). No climb hold.
     * @param {{x: number, y: number, z: number}} pos
     * @param {number} [range=2]
     * @param {{
     *   rejectIf?: () => boolean,
     *   endpointVisibilityTarget?: import('prismarine-entity').Entity|null,
     *   unreachableFallbackPosition?: {x:number,y:number,z:number}|null
     * }} [options]
     */
    goToward(pos, range = 2, options = {}) {
        if (typeof options.rejectIf === 'function' && options.rejectIf()) {
            return false;
        }
        this._releaseClimbHold();
        if (this.isUnreachableFallback) return false;
        const visibilityTarget = options.endpointVisibilityTarget || null;
        const key = `seek:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}:${range}:${visibilityTarget ? 'guarded' : 'plain'}`;
        const last = this._lastSeekPos;
        const drifted = !last
            || Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) > 0.5;
        // Refresh when the continuous target drifts, even if the floor key is unchanged.
        if (this._goalKey === key && this.hasGoal && !drifted) return false;
        this._goalKey = key;
        this._lastSeekPos = { x: pos.x, y: pos.y, z: pos.z };
        this._setGoal(new pf.goals.GoalNear(pos.x, pos.y, pos.z, range), {
            visibilityTarget,
            fallbackPosition: options.unreachableFallbackPosition
        });
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
        this._goalKey = null;
        this._goal = null;
        this._lastSeekPos = null;
        this._endpointVisibilityTarget = null;
        this._lastRouteSuppressionKey = null;
        this._unreachableFallbackActive = false;
        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackPosition = null;
        this._fallbackTargetId = null;
        this._unreachableFallbackGoal = null;
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
            this.bot.pathfinder.setMovements(this.movements);
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
        this._endpointVisibilityTarget = options.visibilityTarget || null;
        this._lastRouteSuppressionKey = null;
        this._unreachableFallbackActive = false;
        this._unreachableFallbackScheduled = false;
        this._unreachableFallbackGoal = null;
        const visibilityTarget = options.visibilityTarget || null;
        const fallbackTargetId = visibilityTarget?.id ?? null;
        if (fallbackTargetId !== this._fallbackTargetId) {
            this._fallbackTargetId = fallbackTargetId;
            this._unreachableFallbackPosition = null;
        }
        const fallback = options.fallbackPosition;
        if (!this._unreachableFallbackPosition && fallback) {
            this._unreachableFallbackPosition = new Vec3(fallback.x, fallback.y, fallback.z);
        }
        this.bot.pathfinder.setMovements(this.movements);
        this.status = 'searching';
        this._goal = goal;
        this.bot.pathfinder.setGoal(goal, true);
    }

    _scheduleLastReachableFallback() {
        if (this._unreachableFallbackActive || this._unreachableFallbackScheduled
            || !this._goal || !this._unreachableFallbackPosition) return;
        const expectedGoal = this._goal;
        const expectedTarget = this._endpointVisibilityTarget;
        const waitPosition = this._unreachableFallbackPosition.clone();
        this._unreachableFallbackScheduled = true;

        queueMicrotask(() => {
            this._unreachableFallbackScheduled = false;
            if (this._goal !== expectedGoal || this._endpointVisibilityTarget !== expectedTarget) return;

            this._unreachableFallbackActive = true;
            this._unreachableFallbackGoal = new pf.goals.GoalNear(
                waitPosition.x,
                waitPosition.y,
                waitPosition.z,
                1
            );
            this.status = 'searching';
            this.unreachableFallbackMovements.canOpenDoors = false;
            this.bot.pathfinder.setMovements(this.unreachableFallbackMovements);
            // The safety wrapper re-applies defaults to the same object.
            this.unreachableFallbackMovements.canOpenDoors = false;
            this.bot.pathfinder.setGoal(this._unreachableFallbackGoal, false);
            console.log(`[companion] follow-route-fallback ${JSON.stringify({
                strategy: 'wait-at-last-reachable-owner-position',
                position: waitPosition
            })}`);
        });
    }

    _rememberAcceptedTargetPosition() {
        const position = this._endpointVisibilityTarget?.position;
        if (!position || this._unreachableFallbackActive) return;
        this._unreachableFallbackPosition = new Vec3(position.x, position.y, position.z);
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
