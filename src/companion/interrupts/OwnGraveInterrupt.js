import { Vec3 } from 'vec3';
import { findOwnGravesFromAwareness, isGraveCandidateBlock } from '../../world/graves.js';
import { approachPosition } from '../utils/approachPosition.js';
import { releaseHoldReflexesIfIdle } from '../deathRecovery.js';
import {
    allowDigAt,
    clearAllowedDig,
    canBreakBlockUnderProtection
} from '../blockProtection.js';

const DEFAULT_DIG_RANGE = 3.5;

/**
 * Break GravesX-style graves that are clearly owned by this bot within awareness radius.
 * Drop pickup is handled separately by NearbyLootInterrupt.
 * Owner work FOV does not block grave digs.
 */
export class OwnGraveInterrupt {
    constructor() {
        this.name = 'own_grave';
        /** @type {string|null} last grave key announced in chat */
        this._announcedKey = null;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    shouldRun(ctx) {
        const cfg = ctx.config?.own_grave;
        if (cfg?.enabled === false) return false;
        if (!ctx.bot?.entity) return false;
        if (ctx.graveLoot?.active) return true;

        const snap = ctx.getCompanionAwareness?.();
        if (!snap) return false;
        return findOwnGravesFromAwareness(ctx.bot, ctx.bot.username, snap).length > 0;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const cfg = ctx.config?.own_grave || {};
        const digRange = cfg.dig_range ?? DEFAULT_DIG_RANGE;

        ctx.graveLoot = ctx.graveLoot || { active: false, targetKey: null };
        ctx.graveLoot.active = true;
        ctx.holdReflexes = true;

        try {
            bot.pvp?.stop?.();
        } catch {
            /* ignore */
        }

        try {
            ctx.invalidateCompanionAwareness?.();
            const snap = ctx.getCompanionAwareness?.();
            const graves = findOwnGravesFromAwareness(bot, bot.username, snap);
            if (graves.length === 0) return;

            const target = graves[0];
            const pos = target.block.position;
            const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
            ctx.graveLoot.targetKey = key;
            await this._announceFound(ctx, key, pos);

            const reached = await approachPosition(ctx, {
                x: pos.x + 0.5,
                y: pos.y,
                z: pos.z + 0.5
            }, {
                range: digRange,
                timeoutMs: 10000
            });

            if (!reached || !bot.entity) return;

            const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
            if (!block || !isGraveCandidateBlock(block.name)) {
                console.warn('[companion] own grave block missing or not a grave candidate');
                return;
            }

            allowDigAt(block.position);
            try {
                if (!canBreakBlockUnderProtection(block)) {
                    console.warn('[companion] dig blocked by protection policy');
                    return;
                }
                await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                ctx.movement.stop();
                await bot.dig(block);
                console.log(`[companion] broke own grave at ${key}`);
            } catch (err) {
                console.warn('[companion] grave dig failed:', err.message || err);
            } finally {
                clearAllowedDig();
            }
        } finally {
            // Leave inactive so NearbyLootInterrupt can collect drops next.
            ctx.graveLoot.active = false;
            ctx.graveLoot.targetKey = null;
            releaseHoldReflexesIfIdle(ctx);
        }
    }

    /**
     * Chat once per grave coordinates so retries do not spam.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {string} key
     * @param {{ x: number, y: number, z: number }} pos
     */
    async _announceFound(ctx, key, pos) {
        if (this._announcedKey === key) return;
        this._announcedKey = key;
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        console.log(`[companion] found own grave at ${key}`);
        try {
            await ctx.agent?.openChat?.(`自分の墓を見つけたよ (${x}, ${y}, ${z})`);
        } catch {
            /* ignore */
        }
    }
}
