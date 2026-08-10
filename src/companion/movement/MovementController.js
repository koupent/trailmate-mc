import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import {
    alignPathToDoorGaps,
    createSafeMovements,
    DEFAULT_SAFE_MAX_DROP_DOWN,
    enforceSafeMovements
} from '../blockProtection.js';
import { hasLineOfSightFrom } from '../../world/lineOfSight.js';
import { analyzePassageRoute } from './passageRoute.js';

/** Climb goals may block Follow only briefly. */
const DEFAULT_CLIMB_HOLD_MS = 2000;
/** Drop a climb lock if the bot has not moved this far within STALL_MS. */
const STALL_DISTANCE = 0.4;
const STALL_MS = 1500;
/** Recheck a waiting companion's live owner route at this interval. */
export const UNREACHABLE_REPROBE_MS = 1000;
/** Owner movement that invalidates an in-flight live-route probe. */
const LIVE_ROUTE_PROBE_DRIFT = 0.75;
/** Keep each background probe slice below one companion tick budget. */
const LIVE_ROUTE_PROBE_TICK_MS = 20;
/** Allow an incremental live-route probe to span several companion ticks. */
const LIVE_ROUTE_PROBE_TIMEOUT_MS = 5000;
/** Follow only X/Z while a creative-style airborne owner is well above/below. */
export const AIRBORNE_HORIZONTAL_FOLLOW_DY = 3;
/** Limit vertical column scans while resolving the surface below an owner. */
const SURFACE_SCAN_DEPTH = 96;
const CUTOFF_PHASE = Object.freeze({
    SEARCHING: 'searching',
    FOLLOWING: 'following',
    WAITING: 'waiting'
});

/**
 * @typedef {Object} CutoffState
 * @property {'searching'|'following'|'waiting'} phase
 * @property {import('vec3').Vec3} position
 * @property {any} goal
 * @property {{position:import('vec3').Vec3,height:number}} visibilityTarget
 * @property {number} lastProbeAt
 * @property {import('vec3').Vec3|null} lastProbePosition
 */

function isFailedPathStatus(status) {
    return status === 'noPath' || status === 'timeout';
}

/**
 * Find the closest standable surface below the owner's X/Z position. This is
 * used when the owner is far above or below the bot, where targeting the
 * entity's exact Y can turn an otherwise simple horizontal route unreachable.
 * @param {import('mineflayer').Bot} bot
 * @param {{x:number,y:number,z:number}} position
 * @returns {Vec3|null}
 */
export function findSurfaceFollowTarget(bot, position) {
    if (!position || typeof bot?.blockAt !== 'function') return null;

    const x = Math.floor(position.x);
    const z = Math.floor(position.z);
    const startY = Math.floor(position.y);
    const worldMinY = Number.isFinite(bot.game?.minY) ? bot.game.minY : -64;
    const minY = Math.max(worldMinY, startY - SURFACE_SCAN_DEPTH);

    for (let feetY = startY; feetY >= minY; feetY--) {
        const floor = bot.blockAt(new Vec3(x, feetY - 1, z));
        const feet = bot.blockAt(new Vec3(x, feetY, z));
        const head = bot.blockAt(new Vec3(x, feetY + 1, z));
        if (!isStandableFloor(floor) || !isOpenBodySpace(feet) || !isOpenBodySpace(head)) {
            continue;
        }
        return new Vec3(x + 0.5, feetY, z + 0.5);
    }

    return null;
}

function isStandableFloor(block) {
    return block?.boundingBox === 'block' && !isUnsafeSurface(block?.name);
}

function isOpenBodySpace(block) {
    return block != null && block.boundingBox !== 'block';
}

function isUnsafeSurface(name = '') {
    return name === 'lava'
        || name === 'fire'
        || name === 'soul_fire'
        || name === 'magma_block'
        || name === 'cactus';
}

/**
 * Keep only a partial route prefix that makes measurable progress and does not
 * yet interact with a door. A* continues searching while the bot walks this
 * prefix; door use remains blocked until a complete route is validated.
 * @param {{status?:string,path?:Array<any>}} result
 * @param {{x:number,y:number,z:number}|null|undefined} start
 * @param {{x:number,y:number,z:number}|null|undefined} target
 * @returns {boolean}
 */
export function retainProgressingCutoffPath(result, start, target) {
    if (!['partial', 'timeout', 'noPath'].includes(result?.status)
        || !Array.isArray(result.path) || !start || !target) {
        return false;
    }

    const interactionIndex = result.path.findIndex((node) =>
        Array.isArray(node?.toPlace) && node.toPlace.length > 0
    );
    if (interactionIndex >= 0) result.path.length = interactionIndex;
    if (result.path.length === 0) return false;

    const endpoint = result.path.at(-1);
    const startDistance = Math.hypot(
        start.x - target.x,
        start.y - target.y,
        start.z - target.z
    );
    const endDistance = Math.hypot(
        endpoint.x - target.x,
        endpoint.y - target.y,
        endpoint.z - target.z
    );
    if (!Number.isFinite(endDistance) || endDistance >= startDistance - 0.25) {
        result.path.length = 0;
        return false;
    }
    return true;
}

/**
 * Prevent an incomplete follow route from moving the bot toward an arbitrary
 * A* frontier while the controller is still looking for a complete detour,
 * and reject a completed route that only reaches the far side of a wall around
 * the followed player.
 *
 * The path array is shared with mineflayer-pathfinder, so clearing it here
 * prevents that route from being executed. The controller then freezes the
 * owner's movement target and runs one guarded search to that position.
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
     *   now?: () => number
     * }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.now = options.now || Date.now;
        this.movements = buildMovements(bot);
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
        /** @type {{x:number,y:number,z:number}|null} */
        this._fallbackTargetPosition = null;
        /** @type {CutoffState|null} */
        this._cutoff = null;
        /** @type {{iterator:Iterator<any>,position:Vec3,goalKind:string}|null} */
        this._liveRouteProbe = null;

        bot.on('path_update', (result) => this._handlePathUpdate(result));

        bot.on('goal_reached', (goal) => {
            if (this._cutoff && (!goal || goal === this._cutoff.goal)) {
                this._markUnreachableWaiting();
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
        return this.now() < this._holdUntil;
    }

    _handlePathUpdate(result) {
        const isCutoffPath = this._cutoff
            && this._goal === this._cutoff.goal
            && this.bot.pathfinder.goal === this._cutoff.goal;

        if (result?.status === 'success' && Array.isArray(result.path)) {
            const passageRoute = analyzePassageRoute(this.bot, result.path);
            if (!passageRoute.valid) {
                result.path.length = 0;
                if (isCutoffPath) {
                    this._markUnreachableWaiting();
                } else if (this._endpointVisibilityTarget?.position) {
                    this.status = 'searching';
                    this._beginCutoffSearch(this._fallbackTargetPosition);
                } else {
                    this.status = 'noPath';
                }
                return;
            }
        }

        if (isCutoffPath) {
            if (result.status === 'success') {
                const rejected = suppressUnsafeFollowPath(
                    this.bot,
                    result,
                    this._cutoff.visibilityTarget
                );
                if (rejected) {
                    this._markUnreachableWaiting();
                    return;
                }
                this._cutoff.phase = CUTOFF_PHASE.FOLLOWING;
                this.status = 'success';
                alignPathToDoorGaps(this.bot, result.path);
                return;
            }

            const retained = retainProgressingCutoffPath(
                result,
                this.bot.entity?.position,
                this._cutoff.position
            );
            alignPathToDoorGaps(this.bot, result.path);
            if (result.status === 'partial') {
                this.status = 'searching';
                return;
            }
            if (isFailedPathStatus(result.status) && retained) {
                this._cutoff.phase = CUTOFF_PHASE.FOLLOWING;
                this.status = 'searching';
                return;
            }
            this._markUnreachableWaiting();
            return;
        }

        const suppressed = suppressUnsafeFollowPath(
            this.bot,
            result,
            this._endpointVisibilityTarget
        );
        if (suppressed) {
            this.status = 'searching';
            this._beginCutoffSearch(this._fallbackTargetPosition);
            return;
        }

        if (this._endpointVisibilityTarget?.position
            && isFailedPathStatus(result.status)) {
            if (Array.isArray(result.path)) result.path.length = 0;
            this.status = 'unreachable';
            const cutoffPosition = this._fallbackTargetPosition;
            this._clearCutoffState();
            this._beginCutoffSearch(cutoffPosition);
            return;
        }

        this._clearCutoffState();
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
        const botY = this.bot.entity?.position?.y;
        const hasLargeHeightGap = Number.isFinite(botY)
            && Math.abs(entity.position.y - botY) >= AIRBORNE_HORIZONTAL_FOLLOW_DY;
        const surfaceTarget = hasLargeHeightGap
            ? findSurfaceFollowTarget(this.bot, entity.position)
            : null;
        const goal = surfaceTarget
            ? new pf.goals.GoalNear(surfaceTarget.x, surfaceTarget.y, surfaceTarget.z, range)
            : hasLargeHeightGap
                ? new pf.goals.GoalNearXZ(entity.position.x, entity.position.z, range)
                : new pf.goals.GoalFollow(entity, range);
        const fallbackPosition = surfaceTarget || entity.position;
        if (this.isUnreachableFallback
            && !this._resumeFromUnreachableIfReachable(
                goal,
                visibilityTarget,
                fallbackPosition
            )) {
            return false;
        }
        const targetCell = hasLargeHeightGap
            ? `:${Math.floor(entity.position.x)}:${Math.floor(surfaceTarget?.y ?? entity.position.y)}:${Math.floor(entity.position.z)}`
            : '';
        const followKind = surfaceTarget ? '-surface' : hasLargeHeightGap ? '-xz' : '';
        const key = `follow${followKind}:${entity.id}:${range}${targetCell}:${visibilityTarget ? 'guarded' : 'plain'}`;
        if (this._goalKey === key && this.hasGoal && !this.isBlocked) return false;
        this._goalKey = key;
        this._setGoal(goal, {
            visibilityTarget,
            fallbackPosition
        });
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
            && !this._resumeFromUnreachableIfReachable(goal, visibilityTarget, pos)) {
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
        this._setGoal(goal, { visibilityTarget, fallbackPosition: pos });
        return true;
    }

    /**
     * Walk toward a fixed ledge. Hold is short and watchdog-cleared on stall.
     * @param {{x: number, y: number, z: number}} pos
     * @param {number} holdMs
     */
    climbTo(pos, holdMs = DEFAULT_CLIMB_HOLD_MS) {
        const key = `climb:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`;
        this._holdUntil = this.now() + holdMs;
        this._holdOrigin = this.bot.entity.position.clone();
        this._holdStartedAt = this.now();
        if (this._goalKey === key && this.hasGoal) return false;
        this._goalKey = key;
        this._setGoal(new pf.goals.GoalNear(pos.x, pos.y, pos.z, 1), {
            fallbackPosition: pos
        });
        return true;
    }

    /**
     * Call every companion tick. Releases climb locks that are not progressing.
     */
    tickHoldWatchdog() {
        this._tickCutoffLifecycle();
        if (!this.isHeld || !this._holdOrigin || !this._holdStartedAt) return;

        const pos = this.bot.entity.position;
        if (this._holdOrigin.distanceTo(pos) >= STALL_DISTANCE) {
            this._holdOrigin = pos.clone();
            this._holdStartedAt = this.now();
            return;
        }

        if (this.now() - this._holdStartedAt < STALL_MS) return;

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
        this._fallbackTargetPosition = null;
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
        this._clearCutoffState();
        this._endpointVisibilityTarget = options.visibilityTarget || null;
        this._fallbackTargetPosition = options.fallbackPosition || null;
        this.bot.pathfinder.setMovements(this.movements);
        this.status = 'searching';
        this._goal = goal;
        this.bot.pathfinder.setGoal(goal, true);
    }

    /**
     * Freeze the owner's movement target at the first incomplete route. The
     * normal door-capable A* search remains active, but incomplete routes are
     * trimmed before every interaction. A passage can therefore open only
     * after a complete crossing route has been validated.
     * @param {{x:number,y:number,z:number}|null|undefined} position
     */
    _beginCutoffSearch(position) {
        if (this._cutoff || !this._goal || !position) return;

        const cutoffPosition = new Vec3(position.x, position.y, position.z);
        const liveVisibilityTarget = this._endpointVisibilityTarget;
        const visibilityPosition = liveVisibilityTarget?.position || cutoffPosition;
        const visibilityTarget = {
            position: new Vec3(
                visibilityPosition.x,
                visibilityPosition.y,
                visibilityPosition.z
            ),
            height: liveVisibilityTarget?.height ?? 1.8
        };
        const cutoffGoal = new pf.goals.GoalNear(
            cutoffPosition.x,
            cutoffPosition.y,
            cutoffPosition.z,
            1
        );
        const cutoff = {
            phase: CUTOFF_PHASE.SEARCHING,
            position: cutoffPosition,
            goal: cutoffGoal,
            visibilityTarget,
            lastProbeAt: 0,
            lastProbePosition: null
        };
        this._cutoff = cutoff;
        queueMicrotask(() => {
            if (this._cutoff !== cutoff || cutoff.phase !== CUTOFF_PHASE.SEARCHING) return;
            this._goalKey = `cutoff:${cutoffPosition.x}:${cutoffPosition.y}:${cutoffPosition.z}`;
            this._goal = cutoffGoal;
            this._endpointVisibilityTarget = visibilityTarget;
            this._fallbackTargetPosition = cutoffPosition;
            this.bot.pathfinder.setMovements(this.movements);
            this.bot.pathfinder.setGoal(cutoffGoal, false);
        });
    }

    _tickCutoffLifecycle() {
        const cutoff = this._cutoff;
        if (!cutoff || cutoff.phase !== CUTOFF_PHASE.FOLLOWING) return;
        if (this.bot.pathfinder.goal !== cutoff.goal || this.isMoving) return;
        this._markUnreachableWaiting();
    }

    _clearCutoffState() {
        this._cutoff = null;
        this._liveRouteProbe = null;
    }

    _markUnreachableWaiting() {
        if (!this._cutoff) return;
        this._cutoff.phase = CUTOFF_PHASE.WAITING;
        this.status = 'unreachable';
        this._cutoff.lastProbeAt = this.now() - UNREACHABLE_REPROBE_MS;
    }

    _resumeFromUnreachableIfReachable(goal, visibilityTarget, targetPosition) {
        const cutoff = this._cutoff;
        if (!cutoff) return false;

        // Keep the main cutoff A* intact. A separate incremental probe checks
        // the live owner position, so leaving an enclosure resumes follow
        // without making fast owner movement starve the main route search.
        const fallbackWasInterrupted = this.bot.pathfinder.goal !== cutoff.goal;
        if (fallbackWasInterrupted) {
            this._clearCutoffState();
            this._goalKey = null;
            return true;
        }

        if (!targetPosition) return false;
        const probePosition = new Vec3(
            targetPosition.x,
            targetPosition.y,
            targetPosition.z
        );
        const goalKind = goal?.constructor?.name === 'GoalNearXZ' ? 'xz' : 'xyz';
        this._discardProbeForChangedTarget(probePosition, goalKind);

        if (!this._liveRouteProbe
            && this._shouldStartLiveRouteProbe(visibilityTarget, probePosition)) {
            this._startLiveRouteProbe(goal, probePosition, goalKind);
        }
        if (!this._liveRouteProbe) return false;

        const result = this._advanceLiveRouteProbe();
        if (result?.status !== 'success') return false;
        if (!analyzePassageRoute(this.bot, result.path).valid) return false;
        if (suppressUnsafeFollowPath(this.bot, result, visibilityTarget)) return false;

        this._clearCutoffState();
        this._goalKey = null;
        return true;
    }

    _discardProbeForChangedTarget(position, goalKind) {
        const probe = this._liveRouteProbe;
        if (!probe) return;
        if (probe.goalKind !== goalKind
            || probe.position.distanceTo(position) >= LIVE_ROUTE_PROBE_DRIFT) {
            this._liveRouteProbe = null;
        }
    }

    _shouldStartLiveRouteProbe(visibilityTarget, position) {
        const cutoff = this._cutoff;
        if (!cutoff) return false;

        const liveTargetMoved = visibilityTarget?.position
            ? cutoff.visibilityTarget.position.distanceTo(visibilityTarget.position)
                >= LIVE_ROUTE_PROBE_DRIFT
            : cutoff.position.distanceTo(position) >= LIVE_ROUTE_PROBE_DRIFT;
        const targetChangedSinceLastProbe = !cutoff.lastProbePosition
            || cutoff.lastProbePosition.distanceTo(position) >= LIVE_ROUTE_PROBE_DRIFT;
        const waitingRetryDue = cutoff.phase === CUTOFF_PHASE.WAITING
            && this.now() - cutoff.lastProbeAt >= UNREACHABLE_REPROBE_MS;

        return (liveTargetMoved && targetChangedSinceLastProbe) || waitingRetryDue;
    }

    _startLiveRouteProbe(goal, position, goalKind) {
        const cutoff = this._cutoff;
        if (!cutoff) return;
        const range = Math.sqrt(Number.isFinite(goal?.rangeSq) ? goal.rangeSq : 1);
        const probeGoal = goalKind === 'xz'
            ? new pf.goals.GoalNearXZ(position.x, position.z, range)
            : new pf.goals.GoalNear(position.x, position.y, position.z, range);
        try {
            this._liveRouteProbe = {
                iterator: this.bot.pathfinder.getPathFromTo(
                    this.movements,
                    this.bot.entity.position,
                    probeGoal,
                    {
                        timeout: LIVE_ROUTE_PROBE_TIMEOUT_MS,
                        tickTimeout: LIVE_ROUTE_PROBE_TICK_MS,
                        resetEntityIntersects: false
                    }
                ),
                position,
                goalKind
            };
            cutoff.lastProbeAt = this.now();
            cutoff.lastProbePosition = position.clone();
        } catch {
            this._liveRouteProbe = null;
        }
    }

    _advanceLiveRouteProbe() {
        const probe = this._liveRouteProbe;
        if (!probe) return null;
        try {
            const step = probe.iterator.next();
            const result = step.value?.result || null;
            if (step.done || result?.status !== 'partial') {
                this._liveRouteProbe = null;
            }
            return result;
        } catch {
            this._liveRouteProbe = null;
            return null;
        }
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
