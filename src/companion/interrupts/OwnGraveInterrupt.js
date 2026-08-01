import { Vec3 } from 'vec3';
import { findOwnGravesFromAwareness, isGraveCandidateBlock } from '../../world/graves.js';
import { isGroundItem } from '../../world/entities.js';
import { approachGraveForDig, isGraveWithinDigReach } from '../utils/graveApproach.js';
import {
    completeDeathRecovery,
    isRecoveryEmergencyActive,
    markDeathReturnArrived,
    releaseHoldReflexesIfIdle,
    requestRecoveryItemCollection
} from '../deathRecovery.js';
import { needsGearRecovery, shouldDeferToCombat } from '../combatGate.js';
import {
    getGraveAwarenessSnapshot,
    hasReachedRecoveryDeathSite
} from '../utils/graveAwareness.js';
import {
    allowDigAt,
    clearAllowedDig,
    canBreakBlockUnderProtection
} from '../blockProtection.js';

const DEFAULT_DIG_RANGE = 3.5;

/**
 * 認識範囲内でこのBot所有と明確に分かるGravesX形式の墓を破壊する。
 * ドロップ取得はNearbyLootInterruptが別途処理し、オーナーの作業視野では墓処理を止めない。
 *
 * 武器がない場合は再武装できるよう、墓復旧を戦闘より優先する。
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
        if (recovery) {
            const phase = ctx.deathRecovery.phase;
            if (phase !== 'grave' && phase !== 'travel') return false;
            if (phase === 'travel' && !hasReachedRecoveryDeathSite(ctx)) return false;
        }
        const unarmed = needsGearRecovery(ctx.bot);
        // 武装済みなら戦闘へ譲るが、未武装なら先に装備を復旧する。
        if (!recovery && shouldDeferToCombat(ctx) && !unarmed) return false;
        if (ctx.graveLoot?.active) return true;

        const snap = getGraveAwarenessSnapshot(ctx);
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
            if (recovery?.active && recovery.phase === 'travel') {
                markDeathReturnArrived(ctx);
            }
            ctx.invalidateCompanionAwareness?.();
            const snap = getGraveAwarenessSnapshot(ctx);
            const graves = findOwnGravesFromAwareness(bot, bot.username, snap);
            if (graves.length === 0) return;

            const target = graves[0];
            const pos = target.block.position;
            const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
            ctx.graveLoot.targetKey = key;
            await this._announceFound(ctx, key, pos);

            const reached = await approachGraveForDig(ctx, pos, {
                digRange,
                timeoutMs: 10_000
            });

            if ((!reached && !isGraveWithinDigReach(bot, pos, digRange)) || !bot.entity) return;

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
                // 墓を開く前に無関係なドロップを記録する。破壊直後の短い時間内に
                // 新たに現れたIDだけをRecovery対象とする。
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
 * 使用可能なら基本的な採掘道具を装備する。採掘速度にはitem typeだけを使う。
 * このサーバーではcomponent-mapのenchantsが配列でないことがあり
 * mineflayerのdigTimeが異常終了するため、エンチャントは別処理する。
 * @param {import('mineflayer').Bot} bot
 */
async function equipDigTool(bot) {
    try {
        const tool = bot.inventory.items().find((i) =>
            /pickaxe|shovel|axe|hoe/.test(String(i.name || ''))
        );
        if (tool) await bot.equip(tool, 'hand');
    } catch {
        /* 失敗は無視する */
    }
}

/**
 * digTimeへ空のエンチャント一覧を渡して採掘する。
 *
 * 実行時の原因: prismarine-itemの `enchants` はcomponentMap上のgetterで、
 * 配列でないオブジェクトを返すことがある。するとmineflayer内の
 * `held.enchants.concat(helmet.enchants)` が「反復可能でない」と失敗する。
 * `item.enchants = []` はgetter専用のため効果がない。
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
