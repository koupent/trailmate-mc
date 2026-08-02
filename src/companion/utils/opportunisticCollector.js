import {
    dropDistanceFrom,
    findNearestDrop,
    scanCompanionAwareness
} from '../../world/companionAwareness.js';
import { isPositionInOwnerWorkFov } from '../ownerWorkMovement.js';
import { PICKUP_MAGNET_RANGE, PICKUP_SETTLE_MS } from './pickupItems.js';
import { canOpportunisticCollect } from '../combatGate.js';

const DEFAULT_COLLECTOR_RADIUS = 4;

/**
 * Lightweight nearby pickup while following — magnet range only, no pathfinder.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @returns {boolean} true when a settle pause was started
 */
export function tryOpportunisticCollect(ctx) {
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
        if (isPositionInOwnerWorkFov(ctx, entity.position)) return false;
        return dropDistanceFrom(bot.entity.position, entity.position) <= PICKUP_MAGNET_RANGE;
    });
    if (candidates.length === 0) return false;

    const nearest = findNearestDrop(snap, bot.entity.position, candidates);
    if (!nearest?.position) return false;

    ctx.movement?.stop?.();
    const now = Date.now();
    if (!ctx._opportunisticCollectUntil || now >= ctx._opportunisticCollectUntil) {
        ctx._opportunisticCollectUntil = now + PICKUP_SETTLE_MS;
    }
    return true;
}
