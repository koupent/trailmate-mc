import pf from 'mineflayer-pathfinder';
import { createSafeMovements, DEFAULT_SAFE_MAX_DROP_DOWN } from '../blockProtection.js';
import { computeArriveRange, computeFollowAnchor } from './followPosition.js';

/** Climb goals may block Follow only briefly. */
const DEFAULT_CLIMB_HOLD_MS = 2000;
/** Drop a climb lock if the bot has not moved this far within STALL_MS. */
const STALL_DISTANCE = 0.4;
const STALL_MS = 1500;
/** Default minimum spacing from the owner while following behind. */
const DEFAULT_FOLLOW_MIN_DISTANCE = 2;

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
        bot.pathfinder.setMovements(this.movements);

        this.status = 'idle';
        this._goalKey = null;
        this._holdUntil = 0;
        this._holdOrigin = null;
        this._holdStartedAt = 0;

        bot.on('path_update', (result) => {
            this.status = result.status;
        });
        bot.on('goal_reached', () => {
            this.status = 'arrived';
            this._clearHold();
            if (this._goalKey && (this._goalKey.startsWith('climb:') || this._goalKey.startsWith('seek:'))) {
                this._goalKey = null;
            }
        });
    }

    get hasGoal() {
        return !!this.bot.pathfinder.goal;
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

    get isHeld() {
        return Date.now() < this._holdUntil;
    }

    /**
     * Follow a moving entity. Always clears climb holds so chasing never sticks.
     * Used while climbing where a tight GoalFollow is safer than a behind-anchor.
     * @param {import('prismarine-entity').Entity} entity
     * @param {number} range
     */
    followEntity(entity, range) {
        this._releaseClimbHold();
        const key = `follow:${entity.id}:${range}`;
        if (this._goalKey === key && this.hasGoal) return false;
        this._goalKey = key;
        this._setGoal(new pf.goals.GoalFollow(entity, range));
        return true;
    }

    /**
     * Stay behind the owner at followDistance, never closer than minDistance.
     * Path target is a behind-anchor GoalNear whose arrive range keeps spacing.
     * @param {import('prismarine-entity').Entity} entity
     * @param {number} followDistance
     * @param {number} [minDistance]
     */
    followEntityBehind(entity, followDistance, minDistance = DEFAULT_FOLLOW_MIN_DISTANCE) {
        this._releaseClimbHold();

        const safeMin = Math.max(0, minDistance);
        const safeFollow = Math.max(safeMin, followDistance);
        const arriveRange = computeArriveRange(safeFollow, safeMin);
        const anchor = computeFollowAnchor(entity, safeFollow);

        const key = `follow-behind:${entity.id}:${Math.floor(anchor.x)}:${Math.floor(anchor.y)}:${Math.floor(anchor.z)}:${arriveRange}`;
        if (this._goalKey === key && this.hasGoal) return false;

        this._goalKey = key;
        this._setGoal(new pf.goals.GoalNear(anchor.x, anchor.y, anchor.z, arriveRange));
        return true;
    }

    /**
     * Walk toward a fixed world position (last-known owner, etc.). No climb hold.
     * @param {{x: number, y: number, z: number}} pos
     * @param {number} [range=2]
     */
    goToward(pos, range = 2) {
        this._releaseClimbHold();
        const key = `seek:${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}:${range}`;
        if (this._goalKey === key && this.hasGoal) return false;
        this._goalKey = key;
        this._setGoal(new pf.goals.GoalNear(pos.x, pos.y, pos.z, range));
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
        this._clearHold();
        try {
            this.bot.pathfinder.setGoal(null);
        } catch {
            // pathfinder may not be ready yet
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

    _setGoal(goal) {
        // Re-apply after combat/legacy modes may have overwritten pathfinder movements.
        this.bot.pathfinder.setMovements(this.movements);
        this.status = 'searching';
        this.bot.pathfinder.setGoal(goal, true);
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
