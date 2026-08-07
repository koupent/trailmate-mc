import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';
import { applyOwnerWorkRetreat } from '../ownerWorkMovement.js';
import { currentControlOwner } from '../ControlPriority.js';
import {
    DEFAULT_FOLLOW_MIN_DISTANCE,
    FOLLOW_GOAL_RANGE,
    LAST_KNOWN_ARRIVE_RANGE
} from '../movement/followConstants.js';
import { horizontalDistanceBetween } from '../movement/followGeometry.js';
import {
    computeTrailAnchor,
    resolveFollowPhase
} from '../movement/followPhase.js';
import {
    PLAYER_PUSH_LANE,
    wouldPathPassNearPlayer
} from '../movement/playerPathClearance.js';
import { tryOpportunisticCollect } from '../utils/opportunisticCollector.js';

/**
 * Lock onto the first player seen in FOV and keep following.
 *
 * The lock is kept until wait / a different owner is set via dialogue.
 * When the owner entity is unloaded, walk toward the last known position;
 * after arriving, wait in place until the entity reappears.
 *
 * While nearby players hold weapons or work tools, maintain a shared safe
 * position outside every equipped player's view and proximity.
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
        // FSM では combat/duty へ一瞬でも遷移するたびに呼ばれる。
        // ここで stop すると追従ゴールが毎回消え、棒立ち・duty 往復の原因になる。
        // 待機への切替は WaitMode.onEnter が stop する。
        if (!ctx.agent?.companion?.manager?.getActiveFsmId) {
            ctx.movement.stop();
        }
    }

    async tick(ctx) {
        const bot = ctx.bot;
        const config = ctx.config;

        ctx.movement.tickHoldWatchdog();
        ctx.doors?.tick?.().catch?.(() => {});

        // FSM が combat/duty を所有するときは FollowBehavior 自体が動かない。
        // ここではラッチ中の wantsCombat で追従を止めない（二重ループ時代の名残）。
        const fsmId = ctx.agent?.companion?.manager?.getActiveFsmId?.();
        if (!fsmId && currentControlOwner(ctx, 'follow') !== 'follow') {
            const owner = ctx.ownerEntity;
            if (owner) this._rememberOwner(ctx, owner);
            return;
        }
        if (fsmId && fsmId !== 'follow') {
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

        const followMinDistance = config.follow_min_distance ?? DEFAULT_FOLLOW_MIN_DISTANCE;

        // Skip Follow only while a climb hold is still making progress.
        if (ctx.movement.isHeld) return;

        if (applyOwnerWorkRetreat(ctx)) {
            return;
        }

        tryOpportunisticCollect(ctx);

        const phase = resolveFollowPhase(ctx, owner);
        const botPos = bot.entity.position;
        const horiz = horizontalDistanceBetween(botPos, owner.position);

        if (phase === 'near') {
            ctx.movement.stop();
            return;
        }

        if (phase === 'trail') {
            if (horiz <= followMinDistance || horiz <= PLAYER_PUSH_LANE) {
                ctx.movement.stop();
                return;
            }

            const anchor = computeTrailAnchor(owner, followMinDistance);
            ctx.movement.goToward(anchor, FOLLOW_GOAL_RANGE);
            return;
        }

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

        const pushGuard = createPushGuard(ctx);
        ctx.movement.goToward(target, LAST_KNOWN_ARRIVE_RANGE, {
            rejectIf: pushGuard(target)
        });
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

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @returns {(target: { x: number, y: number, z: number }) => () => boolean}
 */
function createPushGuard(ctx) {
    return (target) => () => wouldPathPassNearPlayer(ctx, target);
}
