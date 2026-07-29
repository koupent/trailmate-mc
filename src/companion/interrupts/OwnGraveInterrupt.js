import { Vec3 } from 'vec3';
import { findOwnGravesFromAwareness, isGraveCandidateBlock } from '../../world/graves.js';
import { isGroundItem } from '../../world/entities.js';
import { approachPosition } from '../utils/approachPosition.js';
import {
    completeDeathRecovery,
    isRecoveryEmergencyActive,
    releaseHoldReflexesIfIdle,
    requestRecoveryItemCollection
} from '../deathRecovery.js';
import { needsGearRecovery, shouldDeferToCombat } from '../combatGate.js';
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
 *
 * When the bot has no weapon, grave recovery outranks combat so it can re-arm.
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
        const recovery = Boolean(ctx.deathRecovery?.active);
        if (recovery && isRecoveryEmergencyActive(ctx)) return false;
        if (recovery && ctx.deathRecovery.phase !== 'grave') return false;
        const unarmed = needsGearRecovery(ctx.bot);
        // Armed bots still yield to active combat; unarmed bots recover gear first.
        if (!recovery && shouldDeferToCombat(ctx) && !unarmed) return false;
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
        const recovery = ctx.deathRecovery;
        const recoveryTimeoutMs = ctx.config?.death_return?.timeout_ms ?? 90000;
        if (
            recovery?.active
            && Date.now() - (recovery.startedAt || Date.now()) > recoveryTimeoutMs
        ) {
            completeDeathRecovery(ctx, 'grave-unreachable-timeout');
            return;
        }

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
                await equipDigTool(bot);
                await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                ctx.movement.stop();
                // Snapshot unrelated drops before the grave opens. Only new IDs
                // appearing in the short post-break window belong to Recovery.
                const preexistingItemIds = groundItemIdsNear(
                    bot,
                    pos,
                    ctx.config?.nearby_loot?.recovery_radius ?? 12
                );
                await digBlockIgnoringBrokenEnchants(bot, block);
                requestRecoveryItemCollection(ctx, pos, Date.now(), 'grave', {
                    preexistingItemIds
                });
                console.log(`[companion] broke own grave at ${key}`);
            } catch (err) {
                console.warn('[companion] grave dig failed:', err.message || err);
            } finally {
                clearAllowedDig();
            }
        } finally {
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

function groundItemIdsNear(bot, origin, radius) {
    const ids = [];
    for (const entity of Object.values(bot.entities || {})) {
        if (!isGroundItem(entity) || !entity.position) continue;
        const distance = typeof origin.distanceTo === 'function'
            ? origin.distanceTo(entity.position)
            : Math.hypot(
                origin.x - entity.position.x,
                origin.y - entity.position.y,
                origin.z - entity.position.z
            );
        const id = Number(entity.id);
        if (distance <= radius && Number.isFinite(id)) ids.push(id);
    }
    return ids;
}

/**
 * Equip a basic dig tool when available. Dig speed uses item type only;
 * enchant handling is done separately because component-map enchants are often
 * non-arrays on this server and crash mineflayer's digTime.
 * @param {import('mineflayer').Bot} bot
 */
async function equipDigTool(bot) {
    try {
        const tool = bot.inventory.items().find((i) =>
            /pickaxe|shovel|axe|hoe/.test(String(i.name || ''))
        );
        if (tool) await bot.equip(tool, 'hand');
    } catch {
        /* ignore */
    }
}

/**
 * Dig while forcing empty enchant lists into digTime.
 *
 * Root cause (runtime): prismarine-item `enchants` is a getter over componentMap
 * data that is sometimes a non-array object. mineflayer then does
 * `held.enchants.concat(helmet.enchants)` → "enchantments is not iterable".
 * Assigning `item.enchants = []` does nothing (getter-only).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} block
 */
async function digBlockIgnoringBrokenEnchants(bot, block) {
    const previousDigTime = bot.digTime;
    bot.digTime = (target) => {
        const heldType = bot.heldItem?.type ?? null;
        const creative = bot.game?.gameMode === 'creative';
        const inWater = ['water', 'flowing_water'].includes(
            bot._getBlockAtEyeLevel?.()?.name
        );
        const notOnGround = !bot.entity?.onGround;
        return target.digTime(
            heldType,
            creative,
            inWater,
            notOnGround,
            [],
            bot.entity?.effects || {}
        );
    };
    try {
        await bot.dig(block);
    } finally {
        bot.digTime = previousDigTime;
    }
}
