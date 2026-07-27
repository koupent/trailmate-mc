import { clearDeathReturn } from '../deathRecovery.js';

const DEFAULT_ARRIVE_RANGE = 3;
const DEFAULT_TIMEOUT_MS = 90000;

/**
 * After respawn, walk back to the death coordinates.
 * Ground drops are collected by NearbyLootInterrupt once the bot is nearby.
 */
export class DeathReturnInterrupt {
    constructor() {
        this.name = 'death_return';
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    shouldRun(ctx) {
        const cfg = ctx.config?.death_return;
        if (cfg?.enabled === false) return false;

        const dr = ctx.deathRecovery;
        if (!dr?.active || !dr.deathPos) return false;
        if (!ctx.bot?.entity) return false;

        const dim = ctx.bot.game?.dimension ?? null;
        if (dr.deathDim != null && dim != null && dr.deathDim !== dim) {
            // Wait until the bot is in the same dimension; do not consume the tick.
            return false;
        }

        // Prefer in-progress dig / loot over travel this tick.
        if (ctx.graveLoot?.active || ctx.nearbyLoot?.active) return false;

        return true;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const dr = ctx.deathRecovery;
        const cfg = ctx.config?.death_return || {};
        const arriveRange = cfg.arrive_range ?? DEFAULT_ARRIVE_RANGE;
        const timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;

        ctx.holdReflexes = true;
        try {
            bot.pvp?.stop?.();
        } catch {
            /* ignore */
        }

        if (!dr?.deathPos || !bot.entity) {
            clearDeathReturn(ctx);
            return;
        }

        if (Date.now() - (dr.startedAt || Date.now()) > timeoutMs) {
            console.log('[companion] death return timed out');
            ctx.movement.stop();
            clearDeathReturn(ctx);
            return;
        }

        const dist = bot.entity.position.distanceTo(dr.deathPos);
        if (dist <= arriveRange) {
            ctx.movement.stop();
            clearDeathReturn(ctx);
            console.log('[companion] death return arrived');
            return;
        }

        ctx.movement.goToward(dr.deathPos, arriveRange);
    }
}
