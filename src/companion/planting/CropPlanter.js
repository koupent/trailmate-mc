/**
 * Plant seeds the bot carries on empty farmland near the owner.
 *
 * Planting is its own state (`planting`): walking to a farm can take many
 * ticks, and when combat or a door takes over it should resume afterwards.
 * `findWork` is evaluated once per tick by the orchestrator and decides
 * whether the state is wanted; the tree below performs one step of it.
 */

import { Vec3 } from 'vec3';
import { currentControlOwner } from '../ControlPriority.js';
import { canPlaceUnderProtection } from '../blockProtection.js';
import { action, condition, selector, sequence } from '../behaviorTree/bt.js';

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

export class CropPlanter {
    constructor() {
        /** @type {{ item: any, farmland: any, key: string, cropPosition: any }|null} This tick's job. */
        this.work = null;
        /** @type {string|null} Farmland a walk was issued for. */
        this._targetKey = null;
        /** @type {Map<string, number>} */
        this._unreachableUntil = new Map();
    }

    /**
     * Decide whether there is planting work this tick and remember it.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    findWork(ctx) {
        this.work = this._findWork(ctx);
        if (!this.work) this._targetKey = null;
        return this.work;
    }

    _findWork(ctx) {
        const bot = ctx.bot;
        const owner = ctx.ownerEntity;
        if (ctx.config?.crop_replant?.enabled === false) return null;
        if (!ctx.ownerName || !owner || !bot?.entity) return null;
        // A climb hold still making progress keeps the follow state.
        if (ctx.movement?.isHeld) return null;
        if (ctx.agent?.companion?.manager?.targets?._dutyPending) return null;
        if (currentControlOwner(ctx, 'follow') !== 'follow') return null;
        if (bot.entity.position.distanceTo(owner.position) > CROP_OWNER_MAX_DISTANCE) return null;

        const item = findPlantableItem(bot);
        if (!item || typeof bot.findBlock !== 'function') return null;

        const now = Date.now();
        for (const [key, until] of this._unreachableUntil) {
            if (until <= now) this._unreachableUntil.delete(key);
        }
        if (this._targetKey && routeFailed(ctx.movement)) {
            this._unreachableUntil.set(this._targetKey, now + UNREACHABLE_CROP_RETRY_MS);
            this._targetKey = null;
        }

        const farmland = findNearestEmptyFarmland(bot, this._unreachableUntil, now, owner.position);
        if (!farmland) return null;
        if (!canPlaceUnderProtection(CROP_BY_ITEM.get(item.name))) return null;
        return {
            item,
            farmland,
            key: blockKey(farmland.position),
            cropPosition: farmland.position.offset(0, 1, 0)
        };
    }

    /** @param {import('../CompanionContext.js').CompanionContext} ctx */
    isFar(ctx) {
        return ctx.bot.entity.position.distanceTo(this.work.cropPosition) > CROP_PLACE_DISTANCE;
    }

    /** @param {import('../CompanionContext.js').CompanionContext} ctx */
    approach(ctx) {
        this._targetKey = this.work.key;
        ctx.movement.goToward(this.work.cropPosition, CROP_APPROACH_RANGE);
        return true;
    }

    /**
     * Place one crop. Re-checks the farm and the owner right before placing.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @returns {Promise<boolean>} false when the re-check rejected the farm
     */
    async plant(ctx) {
        const bot = ctx.bot;
        const { item, farmland, key, cropPosition } = this.work;
        this._targetKey = null;
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
            this._unreachableUntil.set(key, Date.now() + UNREACHABLE_CROP_RETRY_MS);
        }
        return true;
    }

    /** Forget the walk target, e.g. when the state is left. */
    release() {
        this._targetKey = null;
    }
}

/**
 * One step of planting, using the work `planter.findWork` chose this tick.
 * @param {CropPlanter} planter
 */
export function createPlantingTree(planter) {
    return sequence('作物を植える', [
        condition('種と空いた畑がある', () => Boolean(planter.work)),
        selector('植える手順', [
            sequence('畑が遠い', [
                condition('手が届かない', (ctx) => planter.isFar(ctx)),
                action('畑へ歩く', (ctx) => planter.approach(ctx))
            ]),
            action('種を植える', (ctx) => planter.plant(ctx))
        ])
    ]);
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

function routeFailed(movement) {
    return movement?.isBlocked
        || movement?.isUnreachable
        || movement?.status === 'partial';
}

function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}
