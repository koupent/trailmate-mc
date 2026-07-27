import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';

/** Height difference that switches the bot into climbing mode. */
const CLIMB_ENTER_DY = 0.6;
/** Lower bound to leave climbing mode, so the goal does not flap on stairs. */
const CLIMB_EXIT_DY = 0.35;
/** Follow range used while climbing: loose ranges are satisfied below the owner. */
const CLIMB_RANGE = 1;
/** Stop and wait once within this distance of the last-known owner position. */
const LAST_KNOWN_ARRIVE_RANGE = 3;
/** Fallback when config omits follow_distance / follow_min_distance. */
const DEFAULT_FOLLOW_DISTANCE = 3;
const DEFAULT_FOLLOW_MIN_DISTANCE = 2;

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
        this._climbing = false;
        /** @type {{ x: number, y: number, z: number }|null} */
        this._lastOwnerPos = null;
        /** @type {string|null} */
        this._lastOwnerDim = null;
        /** True after reaching last-known pos while owner is still missing. */
        this._waitingAtLastKnown = false;
    }

    async onEnter() {
        this._climbing = false;
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
        const minDistance = config.follow_min_distance ?? DEFAULT_FOLLOW_MIN_DISTANCE;
        const ownerDy = owner.position.y - bot.entity.position.y;
        const horizDist = Math.hypot(
            owner.position.x - bot.entity.position.x,
            owner.position.z - bot.entity.position.z
        );

        this._climbing = this._climbing
            ? Math.abs(ownerDy) > CLIMB_EXIT_DY
            : Math.abs(ownerDy) > CLIMB_ENTER_DY;

        // Skip Follow only while a climb hold is still making progress.
        if (ctx.movement.isHeld) return;

        // Already inside min distance: stop so pathfinder / recovery cannot push the owner.
        if (horizDist < minDistance) {
            ctx.movement.stop();
            return;
        }

        // Climb catch-up only when still far; near the owner, prefer behind spacing.
        if (this._climbing && horizDist > followDistance) {
            ctx.movement.followEntity(owner, CLIMB_RANGE);
            return;
        }

        ctx.movement.followEntityBehind(owner, followDistance, minDistance);
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
