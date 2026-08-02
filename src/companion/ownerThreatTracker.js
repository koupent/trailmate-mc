import { isHostile } from '../world/entities.js';

const OWNER_THREAT_TTL_MS = 4000;

/**
 * Track who hurt the owner so combat can prioritize that attacker.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function attachOwnerThreatTracker(ctx) {
    const bot = ctx.bot;
    if (!bot || ctx._ownerThreatAttached) return;
    ctx._ownerThreatAttached = true;

    bot.on('entityHurt', (entity, source) => {
        if (!entity || !source) return;

        if (entity === ctx.ownerEntity && isHostile(source)) {
            ctx.ownerThreat = {
                attackerId: source.id,
                seenAt: Date.now()
            };
            return;
        }

        if (entity === bot.entity && isHostile(source)) {
            ctx.lastAttackerId = source.id;
            ctx.lastAttackerSeenAt = Date.now();
        }
    });
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} [now=Date.now()]
 * @returns {{ attackerId: number, seenAt: number }|null}
 */
export function getActiveOwnerThreat(ctx, now = Date.now()) {
    const threat = ctx?.ownerThreat;
    if (!threat?.attackerId) return null;

    const attacker = resolveThreatEntity(ctx.bot, threat.attackerId);
    if (attacker && isHostile(attacker)) {
        // 襲撃者がまだ存在する間は優先度を維持する。
        if (now - threat.seenAt > OWNER_THREAT_TTL_MS) {
            threat.seenAt = now;
        }
        return threat;
    }

    if (now - threat.seenAt > OWNER_THREAT_TTL_MS) {
        ctx.ownerThreat = null;
        return null;
    }
    return threat;
}

/**
 * Resolve a live entity for a stored attacker id.
 * @param {import('mineflayer').Bot} bot
 * @param {number|null|undefined} attackerId
 */
export function resolveThreatEntity(bot, attackerId) {
    if (attackerId == null) return null;
    const entity = bot.entities?.[attackerId];
    if (!entity || entity.isValid === false) return null;
    return entity;
}
