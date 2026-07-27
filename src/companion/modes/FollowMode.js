import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';

/**
 * GoalFollow only measures straight-line distance, so a loose range counts as
 * arrived through walls and floors. Keep it tight and stop from Follow instead.
 */
const FOLLOW_GOAL_RANGE = 1;
/** Above this height gap the owner is on another floor: keep pathing. */
const SAME_FLOOR_DY = 2;
/** Stop and wait once within this distance of the last-known owner position. */
const LAST_KNOWN_ARRIVE_RANGE = 3;
/** Fallback when config omits follow_distance. */
const DEFAULT_FOLLOW_DISTANCE = 3;

/**
 * Nothing solid between the two heads. Used to tell "next to the owner" from
 * "next to the owner but outside the wall".
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-entity').Entity} owner
 * @returns {boolean}
 */
function ownerInSight(bot, owner) {
    const eye = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
    const target = owner.position.offset(0, (owner.height ?? 1.8) * 0.9, 0);
    const delta = target.minus(eye);
    const dist = delta.norm();
    if (dist < 0.1) return true;
    return bot.world.raycast(eye, delta.scaled(1 / dist), dist) === null;
}

/**
 * Lock onto the first player seen in FOV and keep following.
 *
 * The lock is kept until wait / a different owner is set via dialogue.
 * When the owner entity is unloaded, walk toward the last known position;
 * after arriving, wait in place until the entity reappears.
 */
export class FollowMode extends Mode {
    constructor() {
        super({
            id: 'follow',
            description: 'Follow the owner closely and stay nearby'
        });
        /** @type {{ x: number, y: number, z: number }|null} */
        this._lastOwnerPos = null;
        /** @type {string|null} */
        this._lastOwnerDim = null;
        /** True after reaching last-known pos while owner is still missing. */
        this._waitingAtLastKnown = false;
    }

    async onEnter() {
        this._waitingAtLastKnown = false;
    }

    async onExit(ctx) {
        ctx.movement.stop();
    }

    async tick(ctx) {
        const bot = ctx.bot;
        const config = ctx.config;

        ctx.movement.tickHoldWatchdog();

        if (!ctx.ownerName) {
            this._clearLastKnown();
            await this._searchOwner(ctx);
            return;
        }

        const owner = ctx.ownerEntity;
        if (!owner) {
            this._seekLastKnown(ctx);
            return;
        }

        this._rememberOwner(ctx, owner);
        this._waitingAtLastKnown = false;

        const followDistance = config.follow_distance ?? DEFAULT_FOLLOW_DISTANCE;
        const ownerDy = owner.position.y - bot.entity.position.y;
        const horizDist = Math.hypot(
            owner.position.x - bot.entity.position.x,
            owner.position.z - bot.entity.position.z
        );

        // Skip Follow only while a climb hold is still making progress.
        if (ctx.movement.isHeld) return;

        // Close enough only counts when the owner is actually reachable from
        // here — a wall between them means the bot is parked outside the room.
        const nearOwner = horizDist < followDistance && Math.abs(ownerDy) < SAME_FLOOR_DY;
        if (nearOwner && ownerInSight(bot, owner)) {
            ctx.movement.stop();
            return;
        }

        // Always path to the owner itself. A behind-anchor point lands inside
        // walls in small rooms, which makes the bot loop outside the building.
        ctx.movement.followEntity(owner, FOLLOW_GOAL_RANGE);
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {import('prismarine-entity').Entity} owner
     */
    _rememberOwner(ctx, owner) {
        const pos = owner.position;
        this._lastOwnerPos = { x: pos.x, y: pos.y, z: pos.z };
        this._lastOwnerDim = ctx.bot.game?.dimension ?? null;
    }

    _clearLastKnown() {
        this._lastOwnerPos = null;
        this._lastOwnerDim = null;
        this._waitingAtLastKnown = false;
    }

    /**
     * Walk to last-known owner position; wait in place after arrival.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    _seekLastKnown(ctx) {
        const bot = ctx.bot;
        const dim = bot.game?.dimension ?? null;

        if (!this._lastOwnerPos || (this._lastOwnerDim != null && dim != null && this._lastOwnerDim !== dim)) {
            return;
        }

        if (this._waitingAtLastKnown) return;
        if (ctx.movement.isHeld) return;

        const target = this._lastOwnerPos;
        const dist = bot.entity.position.distanceTo(target);
        if (dist <= LAST_KNOWN_ARRIVE_RANGE) {
            this._waitingAtLastKnown = true;
            ctx.movement.stop();
            return;
        }

        ctx.movement.goToward(target, LAST_KNOWN_ARRIVE_RANGE);
    }

    async _searchOwner(ctx) {
        const candidate = ctx.worldState.visiblePlayers[0];
        if (candidate) {
            const changed = lockOwner(ctx, candidate.name);
            if (changed) {
                this._clearLastKnown();
                void notifyOwnerLocked(ctx, candidate.name).catch(() => {});
            }
            return;
        }
        if (Math.random() < 0.05) {
            await ctx.bot.look(ctx.bot.entity.yaw + (Math.random() - 0.5), 0, true);
        }
    }
}
