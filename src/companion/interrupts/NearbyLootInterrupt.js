import { pickupNearbyItems } from '../utils/pickupItems.js';
import { releaseHoldReflexesIfIdle } from '../deathRecovery.js';
import { isOwnerWorkDeferring } from '../ownerWorkTracker.js';

const DEFAULT_AWARENESS_RADIUS = 10;
const DEFAULT_MAX_MS = 15000;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_GRACE_MS = 2500;

/**
 * Pick up ground-item entities near the bot.
 * Independent from grave digging / death-return travel — those only get the bot near loot.
 * Suspended while the owner is working (deferring / post-work cooldown).
 */
export class NearbyLootInterrupt {
    constructor() {
        this.name = 'nearby_loot';
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    shouldRun(ctx) {
        const cfg = ctx.config?.nearby_loot;
        if (cfg?.enabled === false) return false;
        if (!ctx.bot?.entity) return false;
        if (Date.now() < (ctx.nearbyLoot?.suppressUntil || 0)) return false;

        // Stay out of the owner's work area; death/grave recovery still loots.
        if (
            isOwnerWorkDeferring(ctx)
            && !ctx.deathRecovery?.active
            && !ctx.graveLoot?.active
        ) {
            return false;
        }

        const snap = ctx.getCompanionAwareness?.();
        if (snap) return snap.dropItems.length > 0;

        const radius = ctx.config?.awareness_radius ?? DEFAULT_AWARENESS_RADIUS;
        return Object.values(ctx.bot.entities || {}).some((entity) => {
            if (!entity?.position || !entity.name) return false;
            const name = String(entity.name).toLowerCase();
            if (name !== 'item' && name !== 'item_entity') return false;
            return ctx.bot.entity.position.distanceTo(entity.position) <= radius;
        });
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const cfg = ctx.config?.nearby_loot || {};
        const radius = ctx.config?.awareness_radius ?? DEFAULT_AWARENESS_RADIUS;
        const maxMs = cfg.max_ms ?? DEFAULT_MAX_MS;
        const quietMs = cfg.quiet_ms ?? DEFAULT_QUIET_MS;
        const graceMs = cfg.grace_ms ?? DEFAULT_GRACE_MS;

        ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
        ctx.nearbyLoot.active = true;
        ctx.holdReflexes = true;

        try {
            bot.pvp?.stop?.();
        } catch {
            /* ignore */
        }

        try {
            await pickupNearbyItems(ctx, {
                radius,
                durationMs: maxMs,
                untilClear: true,
                quietMs,
                graceMs
            });
        } finally {
            ctx.nearbyLoot.active = false;
            releaseHoldReflexesIfIdle(ctx);
        }
    }
}
