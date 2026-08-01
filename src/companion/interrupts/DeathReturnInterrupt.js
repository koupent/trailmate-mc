import {
    completeDeathRecovery,
    isRecoveryEmergencyActive,
    markDeathReturnArrived,
    requestRecoveryItemCollection
} from '../deathRecovery.js';
import { hasReachedRecoveryDeathSite } from '../utils/graveAwareness.js';

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_GRAVE_WAIT_MS = 2500;

/**
 * After respawn, walk back to the death coordinates.
 * 地面のドロップは共通NearbyLoot/ItemCollection Capabilityで回収する。
 * 戦略目標はRecoveryが所有し、上限付きの緊急生存行動だけ一時停止できる。
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
        if (isRecoveryEmergencyActive(ctx)) return false;

        const dim = ctx.bot.game?.dimension ?? null;
        if (dr.deathDim != null && dim != null && dr.deathDim !== dim) {
            // Wait until the bot is in the same dimension; do not consume the tick.
            return false;
        }

        // Prefer in-progress dig / loot over travel this tick.
        if (ctx.graveLoot?.active || ctx.nearbyLoot?.active) return false;

        return dr.phase === 'travel' || dr.phase === 'grave';
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const dr = ctx.deathRecovery;
        const cfg = ctx.config?.death_return || {};

        // pvp停止や戦闘抑制は行わない。Follow側が isControllingMovement で譲る。

        if (!dr?.deathPos || !bot.entity) {
            completeDeathRecovery(ctx, 'missing-death-position');
            return;
        }

        const timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        if (Date.now() - (dr.startedAt || Date.now()) > timeoutMs) {
            console.log('[companion] death return timed out');
            ctx.movement.stop();
            completeDeathRecovery(ctx, 'timeout');
            return;
        }

        if (dr.phase === 'grave') {
            const graveWaitMs = cfg.grave_wait_ms ?? DEFAULT_GRAVE_WAIT_MS;
            if (Date.now() - (dr.arrivedAt || Date.now()) >= graveWaitMs) {
                requestRecoveryItemCollection(ctx, dr.deathPos);
                console.log('[companion] no grave appeared; using common item collection at death site');
            }
            return;
        }

        if (hasReachedRecoveryDeathSite(ctx)) {
            ctx.movement.stop();
            markDeathReturnArrived(ctx);
            console.log('[companion] death return arrived; waiting for grave/item recovery');
            return;
        }

        const arriveRange = cfg.arrive_range ?? 3;
        ctx.movement.goToward(dr.deathPos, arriveRange);
    }
}
