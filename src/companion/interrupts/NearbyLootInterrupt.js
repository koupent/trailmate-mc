import { countGroundItemsNear, pickupNearbyItems } from '../utils/pickupItems.js';
import { releaseHoldReflexesIfIdle } from '../deathRecovery.js';

const DEFAULT_RADIUS = 8;
const DEFAULT_MAX_MS = 15000;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_GRACE_MS = 2500;

/**
 * Pick up ground-item entities near the bot.
 * Independent from grave digging / death-return travel — those only get the bot near loot.
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

        const radius = cfg?.radius ?? DEFAULT_RADIUS;
        return countGroundItemsNear(ctx.bot, radius, ctx.bot.entity.position) > 0;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const cfg = ctx.config?.nearby_loot || {};
        const radius = cfg.radius ?? DEFAULT_RADIUS;
        const maxMs = cfg.max_ms ?? DEFAULT_MAX_MS;
        const quietMs = cfg.quiet_ms ?? DEFAULT_QUIET_MS;
        const graceMs = cfg.grace_ms ?? DEFAULT_GRACE_MS;

        ctx.nearbyLoot = ctx.nearbyLoot || { active: false };
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
