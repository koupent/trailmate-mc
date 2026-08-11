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
function isFailedPathStatus(status) {
    return status === 'noPath' || status === 'timeout';
}

/**
 * Find the closest standable surface below the owner's X/Z position. This is
 * the sole owner-follow target on both the ground and in flight, so the
 * entity's unreachable airborne Y never becomes part of A*.
 * @param {import('mineflayer').Bot} bot
 * @param {{x:number,y:number,z:number}} position
 * @returns {Vec3|null}
 */
export function findSurfaceFollowTarget(bot, position) {
    if (!position || typeof bot?.blockAt !== 'function') return null;

    const x = Math.floor(position.x);
    const z = Math.floor(position.z);
    // Grounded entities may have a fractional feet Y on slabs and other
    // partial-height blocks. Start above their feet so the support block is
    // inspected as the floor instead of being mistaken for occupied body space.
    const startY = Math.ceil(position.y);
    const worldMinY = Number.isFinite(bot.game?.minY) ? bot.game.minY : -64;

    for (let feetY = startY; feetY >= worldMinY; feetY--) {
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
 * Prevent an incomplete follow route from moving the bot toward an arbitrary
 * A* frontier, and reject a completed route that ends across an obstruction
 * from its projected ground target.
 *
 * The path array is shared with mineflayer-pathfinder, so clearing it here
 * prevents unsafe movement and door actions from being executed.
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
        this._goalRole = null;
        /** @type {Vec3|null} */
        this._activeFollowTarget = null;
        this._activeFollowKey = null;
        /** @type {Vec3|null} */
        this._lastReachableFollowTarget = null;
        this._blockedFollowKey = null;
        this._blockedFollowAt = 0;
        this._followOwnerId = null;
        this._followDimension = null;

        bot.on('path_update', (result) => this._handlePathUpdate(result));

        bot.on('goal_reached', () => {
            this.status = this._goalRole === 'follow-fallback' ? 'unreachable' : 'arrived';
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
        return active === this._goal;
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
        return this._blockedFollowKey !== null;
    }

    get isTryingToMove() {
        return this.isMoving;
    }

    get isHeld() {
        return this.now() < this._holdUntil;
    }

    _handlePathUpdate(result) {
        if (result?.status === 'success' && Array.isArray(result.path)) {
            const passageRoute = analyzePassageRoute(this.bot, result.path);
            if (!passageRoute.valid) {
                result.path.length = 0;
                this._markActiveRouteFailed();
                return;
            }
        }

        if (this._goalRole === 'follow' || this._goalRole === 'follow-fallback') {
            if (result.status === 'partial') {
                if (Array.isArray(result.path)) result.path.length = 0;
                this.status = this._goalRole === 'follow' ? 'searching' : 'unreachable';
                return;
            }

            if (isFailedPathStatus(result.status)) {
                if (Array.isArray(result.path)) result.path.length = 0;
                this._markActiveRouteFailed();
                return;
            }

            const suppressed = suppressUnsafeFollowPath(
                this.bot,
                result,
                this._endpointVisibilityTarget
            );
            if (suppressed) {
                this._markActiveRouteFailed();
                return;
            }

            if (result.status === 'success') {
                if (this._goalRole === 'follow' && this._activeFollowTarget) {
                    this._lastReachableFollowTarget = this._activeFollowTarget.clone();
                    this._clearBlockedFollow();
                    this.status = 'success';
                } else {
                    this.status = 'unreachable';
                }
                alignPathToDoorGaps(this.bot, result.path);
            }
            return;
        }

        const suppressed = suppressUnsafeFollowPath(this.bot, result, this._endpointVisibilityTarget);
        if (suppressed) {
            this.status = result.status === 'partial' ? 'searching' : 'noPath';
            return;
        }
        if (this._endpointVisibilityTarget?.position
            && isFailedPathStatus(result.status)) {
            if (Array.isArray(result.path)) result.path.length = 0;
            this.status = 'unreachable';
            return;
        }

        this.status = result.status;
        alignPathToDoorGaps(this.bot, result.path);
    }

    /**
     * Follow the standable surface directly below an entity. The entity's Y is
     * never used as a path goal, which keeps ground and airborne follow identical.
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
        this._prepareFollowOwner(entity);

        const surfaceTarget = findSurfaceFollowTarget(this.bot, entity.position);
        if (!surfaceTarget) {
            this.status = 'unreachable';
            this._ensureLastReachableGoal(range);
            return false;
        }

        const key = followTargetKey(entity.id, surfaceTarget, range);
        if (this._blockedFollowKey !== null && this._blockedFollowKey !== key) {
            this._clearBlockedFollow();
        }
        const retryPending = this._blockedFollowKey === key
            && this.now() - this._blockedFollowAt < UNREACHABLE_REPROBE_MS;
        if (retryPending) {
            this._ensureLastReachableGoal(range);
            return false;
        }

        if (this._goalRole === 'follow'
            && this._activeFollowKey === key
            && this.hasGoal
            && !this.isBlocked) {
            return false;
        }

        const goal = new pf.goals.GoalNear(
            surfaceTarget.x,
            surfaceTarget.y,
            surfaceTarget.z,
            range
        );
        this._goalKey = key;
        this._activeFollowKey = key;
        this._activeFollowTarget = surfaceTarget.clone();
        this._setGoal(goal, {
            role: 'follow',
            visibilityTarget: surfaceVisibilityTarget(surfaceTarget),
            dynamic: true
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
        this._holdUntil = this.now() + holdMs;
        this._holdOrigin = this.bot.entity.position.clone();
        this._holdStartedAt = this.now();
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
        this._goalKey = null;
        this._goal = null;
        this._goalRole = null;
        this._activeFollowKey = null;
        this._activeFollowTarget = null;
        this._clearBlockedFollow();
        this._lastSeekPos = null;
        this._endpointVisibilityTarget = null;
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

    _prepareFollowOwner(entity) {
        const dimension = this.bot.game?.dimension ?? null;
        if (this._followOwnerId === entity.id && this._followDimension === dimension) return;

        this._followOwnerId = entity.id;
        this._followDimension = dimension;
        this._activeFollowKey = null;
        this._activeFollowTarget = null;
        this._lastReachableFollowTarget = null;
        this._clearBlockedFollow();
    }

    _clearBlockedFollow() {
        this._blockedFollowKey = null;
        this._blockedFollowAt = 0;
    }

    _markActiveRouteFailed() {
        if (this._goalRole === 'follow') {
            this._blockedFollowKey = this._activeFollowKey;
            this._blockedFollowAt = this.now();
            this.status = 'unreachable';
            return;
        }
        this.status = this._goalRole === 'follow-fallback' ? 'unreachable' : 'noPath';
    }

    _ensureLastReachableGoal(range) {
        const target = this._lastReachableFollowTarget;
        if (!target) {
            this._holdUnreachable();
            return false;
        }

        const botPosition = this.bot.entity?.position;
        if (botPosition && botPosition.distanceTo(target) <= range) {
            this._holdUnreachable();
            return false;
        }

        const key = `follow-fallback:${target.x}:${target.y}:${target.z}:${range}`;
        if (this._goalRole === 'follow-fallback'
            && this._activeFollowKey === key
            && this.hasGoal) {
            return false;
        }

        this._goalKey = key;
        this._activeFollowKey = key;
        this._activeFollowTarget = target.clone();
        this._setGoal(
            new pf.goals.GoalNear(target.x, target.y, target.z, range),
            {
                role: 'follow-fallback',
                visibilityTarget: surfaceVisibilityTarget(target),
                dynamic: true
            }
        );
        return true;
    }

    _holdUnreachable() {
        this._goalKey = null;
        this._goal = null;
        this._goalRole = 'follow-fallback';
        this._activeFollowKey = null;
        this._activeFollowTarget = null;
        this._endpointVisibilityTarget = null;
        this.status = 'unreachable';
        try {
            this.bot.pathfinder.setGoal(null);
        } catch {
            // Pathfinder may not be ready yet.
        }
    }

    _setGoal(goal, options = {}) {
        // Re-apply after combat/legacy modes may have overwritten pathfinder movements.
        this._endpointVisibilityTarget = options.visibilityTarget || null;
        this._goalRole = options.role || 'other';
        this.bot.pathfinder.setMovements(this.movements);
        this.status = 'searching';
        this._goal = goal;
        this.bot.pathfinder.setGoal(goal, options.dynamic === true);
    }
}

function followTargetKey(ownerId, target, range) {
    return `follow:${ownerId}:${Math.floor(target.x)}:${Math.floor(target.y)}:${Math.floor(target.z)}:${range}`;
}

function surfaceVisibilityTarget(target) {
    return { position: target.clone(), height: 1.8 };
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
