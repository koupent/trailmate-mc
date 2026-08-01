import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';
import { hasLineOfSight } from '../../world/lineOfSight.js';
import { applyOwnerWorkRetreat } from '../ownerWorkMovement.js';
import { currentControlOwner } from '../ControlPriority.js';
import {
    DEFAULT_FOLLOW_DISTANCE,
    FOLLOW_GOAL_RANGE,
    LAST_KNOWN_ARRIVE_RANGE
} from '../movement/followConstants.js';
import { isNearOwnerHorizontally } from '../movement/followGeometry.js';

/**
 * Lock onto the first player seen in FOV and keep following.
 *
 * The lock is kept until wait / a different owner is set via dialogue.
 * When the owner entity is unloaded, walk toward the last known position;
 * after arriving, wait in place until the entity reappears.
 *
 * While the owner is mining/placing (ownerWork deferring/cooldown), path to a
 * behind-the-owner anchor so the companion stays out of the owner's view.
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

        // 目的地はRecoveryが供給し、Followはownerコンテキストだけを保持する。
        if (currentControlOwner(ctx, 'follow') !== 'follow') {
            const owner = ctx.ownerEntity;
            if (owner) this._rememberOwner(ctx, owner);
            return;
        }

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

        // Skip Follow only while a climb hold is still making progress.
        if (ctx.movement.isHeld) return;

        if (applyOwnerWorkRetreat(ctx)) {
            return;
        }

        // Close enough only counts when the owner is actually reachable from
        // here — a wall between them means the bot is parked outside the room.
        const nearOwner = isNearOwnerHorizontally(
            bot.entity.position,
            owner.position,
            followDistance
        );
        if (nearOwner && hasLineOfSight(bot, owner)) {
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
