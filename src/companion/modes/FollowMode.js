import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';
import { applyOwnerWorkRetreat } from '../ownerWorkMovement.js';
import { currentControlOwner } from '../ControlPriority.js';
import {
    FOLLOW_GOAL_RANGE,
    LAST_KNOWN_ARRIVE_RANGE
} from '../movement/followConstants.js';
import { resolveFollowPhase } from '../movement/followPhase.js';
import { ColumnClimber } from '../movement/climbColumn.js';
import { wouldPathPassNearPlayer } from '../movement/playerPathClearance.js';
import { tryOpportunisticCollect } from '../utils/opportunisticCollector.js';
import { canPlaceUnderProtection } from '../blockProtection.js';
import { Vec3 } from 'vec3';

const CROP_SEARCH_RADIUS = 16;
const CROP_OWNER_MAX_DISTANCE = 32;
const CROP_PLACE_DISTANCE = 4;
const CROP_APPROACH_RANGE = 2;
const UNREACHABLE_CROP_RETRY_MS = 5000;

const CROP_BY_ITEM = new Map([
    ['wheat_seeds', 'wheat'],
    ['beetroot_seeds', 'beetroots'],
    ['pumpkin_seeds', 'pumpkin_stem'],
    ['melon_seeds', 'melon_stem'],
    ['torchflower_seeds', 'torchflower_crop'],
    ['pitcher_pod', 'pitcher_crop'],
    ['carrot', 'carrots'],
    ['potato', 'potatoes']
]);

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
        /** @type {string|null} */
        this._plantingTargetKey = null;
        /** @type {Map<string, number>} */
        this._unreachableFarmlandUntil = new Map();
        /** Manual ladder / vine climb; pathfinder never moves vertically here. */
        this._climb = new ColumnClimber();
        this._climbConsulted = false;
    }

    async onEnter() {
        this._waitingAtLastKnown = false;
    }

    async onExit(ctx) {
        this._plantingTargetKey = null;
        this._climb.release(ctx);
        // FSM では combat/duty へ一瞬でも遷移するたびに呼ばれる。
        // ここで stop すると追従ゴールが毎回消え、棒立ち・duty 往復の原因になる。
        // 待機への切替は WaitMode.onEnter が stop する。
        if (!ctx.agent?.companion?.manager?.getActiveFsmId) {
            ctx.movement.stop();
        }
    }

    async tick(ctx) {
        this._climbConsulted = false;
        try {
            await this._runTick(ctx);
        } finally {
            // Every early return above the climb branch — combat taking over,
            // the owner disappearing, a pickup pause — must let go of forward.
            if (!this._climbConsulted) this._climb.release(ctx);
        }
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async _runTick(ctx) {
        const bot = ctx.bot;

        ctx.movement.tickHoldWatchdog();

        // FSM が combat/duty を所有するときは FollowBehavior 自体が動かない。
        // ここではラッチ中の wantsCombat で追従を止めない（二重ループ時代の名残）。
        const fsmId = ctx.agent?.companion?.manager?.getActiveFsmId?.();
        if (!fsmId && currentControlOwner(ctx, 'follow') !== 'follow') {
            this._plantingTargetKey = null;
            const owner = ctx.ownerEntity;
            if (owner) this._rememberOwner(ctx, owner);
            return;
        }
        if (fsmId && fsmId !== 'follow') {
            this._plantingTargetKey = null;
            const owner = ctx.ownerEntity;
            if (owner) this._rememberOwner(ctx, owner);
            return;
        }

        if (!ctx.ownerName) {
            this._plantingTargetKey = null;
            this._clearLastKnown();
            await this._searchOwner(ctx);
            return;
        }

        const owner = ctx.ownerEntity;
        if (!owner) {
            this._plantingTargetKey = null;
            this._seekLastKnown(ctx);
            return;
        }

        this._rememberOwner(ctx, owner);
        this._waitingAtLastKnown = false;

        if (ctx.boatPassenger?.tryBoard?.(owner)) {
            this._plantingTargetKey = null;
            return;
        }

        // Skip Follow only while a climb hold is still making progress.
        if (ctx.movement.isHeld) {
            this._plantingTargetKey = null;
            return;
        }

        if (applyOwnerWorkRetreat(ctx)) {
            this._plantingTargetKey = null;
            return;
        }

        if (tryOpportunisticCollect(ctx)) {
            this._plantingTargetKey = null;
            return;
        }

        const dutyPending = Boolean(
            ctx.agent?.companion?.manager?.targets?._dutyPending
        );
        if (!dutyPending
            && currentControlOwner(ctx, 'follow') === 'follow'
            && bot.entity.position.distanceTo(owner.position) <= CROP_OWNER_MAX_DISTANCE
            && await this._tryPlantNearbyCrop(ctx)) {
            return;
        }
        this._plantingTargetKey = null;

        // A* plans no usable upward move over vines, so the wall is climbed by
        // hand. The follow route never reaches the foot of it either — it stops
        // beside the column, or fails outright on the owner's cell up on top —
        // so the climb owns the walk into the column as well, and holds the
        // tick for it. Everything below stays untouched when it does not apply.
        this._climbConsulted = true;
        if (this._climb.tick(ctx)) return;

        const phase = resolveFollowPhase(ctx, owner);

        if (phase === 'near') {
            ctx.movement.stop();
            return;
        }

        ctx.movement.followEntity(owner, FOLLOW_GOAL_RANGE, {
            endpointVisibilityTarget: owner
        });
    }

    /**
     * Plant at most one crop, or reserve this tick while approaching farmland.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @returns {Promise<boolean>}
     */
    async _tryPlantNearbyCrop(ctx) {
        const bot = ctx.bot;
        const item = findPlantableItem(bot);
        if (!item || typeof bot.findBlock !== 'function') return false;

        const now = Date.now();
        for (const [key, until] of this._unreachableFarmlandUntil) {
            if (until <= now) this._unreachableFarmlandUntil.delete(key);
        }

        if (this._plantingTargetKey && plantingRouteFailed(ctx.movement)) {
            this._unreachableFarmlandUntil.set(
                this._plantingTargetKey,
                now + UNREACHABLE_CROP_RETRY_MS
            );
            this._plantingTargetKey = null;
        }

        const farmland = findNearestEmptyFarmland(
            bot,
            this._unreachableFarmlandUntil,
            now,
            ctx.ownerEntity.position
        );
        if (!farmland) return false;

        const cropName = CROP_BY_ITEM.get(item.name);
        if (!canPlaceUnderProtection(cropName)) return false;

        const key = blockKey(farmland.position);
        const cropPosition = farmland.position.offset(0, 1, 0);
        if (bot.entity.position.distanceTo(cropPosition) > CROP_PLACE_DISTANCE) {
            this._plantingTargetKey = key;
            ctx.movement.goToward(cropPosition, CROP_APPROACH_RANGE);
            return true;
        }

        this._plantingTargetKey = null;
        ctx.movement.stop();
        try {
            await bot.equip(item, 'hand');
            const currentFarmland = bot.blockAt(farmland.position);
            const currentCrop = bot.blockAt(cropPosition);
            const owner = ctx.ownerEntity;
            if (currentFarmland?.name !== 'farmland'
                || currentCrop?.name !== 'air'
                || !owner
                || bot.entity.position.distanceTo(owner.position) > CROP_OWNER_MAX_DISTANCE
                || farmland.position.distanceTo(owner.position) > CROP_OWNER_MAX_DISTANCE
                || currentControlOwner(ctx, 'follow') !== 'follow') {
                return false;
            }
            await bot.placeBlock(currentFarmland, new Vec3(0, 1, 0));
        } catch {
            this._unreachableFarmlandUntil.set(
                key,
                Date.now() + UNREACHABLE_CROP_RETRY_MS
            );
        }
        return true;
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

function findPlantableItem(bot) {
    try {
        return bot.inventory?.items?.().find((item) => CROP_BY_ITEM.has(item.name)) || null;
    } catch {
        return null;
    }
}

function findNearestEmptyFarmland(bot, excludedUntil, now, ownerPosition) {
    try {
        return bot.findBlock({
            matching: (block) => block?.name === 'farmland',
            maxDistance: CROP_SEARCH_RADIUS,
            useExtraInfo: (block) => {
                if (bot.entity.position.distanceTo(block.position) > CROP_SEARCH_RADIUS) return false;
                if (block.position.distanceTo(ownerPosition) > CROP_OWNER_MAX_DISTANCE) return false;
                if ((excludedUntil.get(blockKey(block.position)) || 0) > now) return false;
                return bot.blockAt(block.position.offset(0, 1, 0))?.name === 'air';
            }
        });
    } catch {
        return null;
    }
}

function plantingRouteFailed(movement) {
    return movement?.isBlocked
        || movement?.isUnreachable
        || movement?.status === 'partial';
}

function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}
