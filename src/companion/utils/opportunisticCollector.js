import {
    findNearestDrop,
    scanCompanionAwareness
} from '../../world/companionAwareness.js';
import { isPositionInOwnerWorkFov } from '../ownerWorkMovement.js';
import {
    isProtectedPlayerDrop,
    isWithinMagnetPickup,
    PICKUP_MAGNET_RANGE
} from './pickupItems.js';
import {
    beginPickupSettle,
    clearPickupSettleWhenTargetMissing,
    pickupNeedsCloseApproach,
    pickupTargetKey
} from './pickupSettle.js';
import { canOpportunisticCollect } from '../combatGate.js';

const DEFAULT_COLLECTOR_RADIUS = 4;

/**
 * Lightweight nearby pickup while following — magnet range only, no pathfinder.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {number} [now]
 * @returns {boolean} true while the one-time settle pause owns this tick
 */
export function tryOpportunisticCollect(ctx, now = Date.now()) {
    const cfg = ctx.config?.nearby_loot || {};
    if (cfg.collector_enabled === false) return false;
    if (!canOpportunisticCollect(ctx)) return false;

    const bot = ctx.bot;
    if (!bot?.entity) return false;
    if (ctx.nearbyLoot?.active || ctx.deathRecovery?.active) return false;

    let emptySlots = 0;
    try {
        emptySlots = bot.inventory.emptySlotCount?.() ?? 0;
    } catch {
        return false;
    }
    if (emptySlots <= 0) return false;

    const radius = cfg.collector_radius ?? DEFAULT_COLLECTOR_RADIUS;
    const snap = scanCompanionAwareness(bot, radius, bot.entity.position);
    const candidates = snap.dropItems.filter((entity) => {
        if (!entity?.position) return false;
        if (isProtectedPlayerDrop(ctx, entity, now)) return false;
        if (isPositionInOwnerWorkFov(ctx, entity.position)) return false;
        return isWithinMagnetPickup(bot.entity.position, entity.position, PICKUP_MAGNET_RANGE);
    });
    clearPickupSettleWhenTargetMissing(ctx, candidates);
    if (candidates.length === 0) return false;

    const nearest = findNearestDrop(snap, bot.entity.position, candidates);
    if (!nearest?.position) return false;

    const targetKey = pickupTargetKey(nearest);
    const startingSettle = ctx.nearbyLoot?.pickupSettle?.targetKey !== targetKey;
    beginPickupSettle(ctx, nearest, now);
    if (pickupNeedsCloseApproach(ctx, nearest, now)) return false;

    if (startingSettle) {
        ctx.movement?.stop?.();
    }
    return true;
}
