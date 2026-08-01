import { scanCompanionAwareness } from '../../world/companionAwareness.js';
import { resolvePickupRadius } from './pickupItems.js';

const DEFAULT_GRAVE_SCAN_RADIUS = 10;
/** Grave holograms may sit several blocks above/below the recorded death feet Y. */
export const GRAVE_VERTICAL_SCAN_DY = 8;

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function resolveGraveScanRadius(ctx) {
    const grave = ctx.config?.own_grave?.scan_radius;
    const awareness = ctx.config?.awareness_radius ?? 12;
    const pickup = resolvePickupRadius(ctx);
    if (typeof grave === 'number' && grave > 0) {
        return Math.max(grave, awareness, pickup);
    }
    return Math.max(DEFAULT_GRAVE_SCAN_RADIUS, awareness, pickup);
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function resolveGraveScanOrigin(ctx) {
    const dr = ctx.deathRecovery;
    if (dr?.active) {
        return dr.collectionOrigin || dr.deathPos || ctx.bot?.entity?.position || null;
    }
    return ctx.bot?.entity?.position || null;
}

/**
 * Scan for grave holograms around the recovery death site (not only the bot's feet).
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function getGraveAwarenessSnapshot(ctx) {
    const origin = resolveGraveScanOrigin(ctx);
    if (!origin || !ctx.bot) return null;
    return scanCompanionAwareness(ctx.bot, resolveGraveScanRadius(ctx), origin, {
        maxVerticalDy: GRAVE_VERTICAL_SCAN_DY
    });
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function hasReachedRecoveryDeathSite(ctx) {
    const dr = ctx.deathRecovery;
    const botPos = ctx.bot?.entity?.position;
    const deathPos = dr?.deathPos;
    if (!dr?.active || !botPos || !deathPos) return false;
    const arriveRange = ctx.config?.death_return?.arrive_range ?? 3;
    const horizontal = Math.hypot(botPos.x - deathPos.x, botPos.z - deathPos.z);
    const verticalGap = Math.abs(botPos.y - deathPos.y);
    return horizontal <= arriveRange && verticalGap <= GRAVE_VERTICAL_SCAN_DY;
}
