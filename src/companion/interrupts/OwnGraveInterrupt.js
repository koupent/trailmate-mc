import { Vec3 } from 'vec3';
import { isGraveCandidateBlock } from '../../world/graves.js';
import { isGroundItem } from '../../world/entities.js';
import { approachGraveForInteract, isGraveWithinInteractReach } from '../utils/graveApproach.js';
import { claimGraveBlock, resolveOwnGraveInteractRange } from '../utils/graveInteract.js';
import {
    completeDeathRecovery,
    isRecoveryEmergencyActive,
    isRecoveryTimedOut,
    markDeathReturnArrived,
    releaseHoldReflexesIfIdle,
    requestRecoveryItemCollection
} from '../deathRecovery.js';
import { needsGearRecovery, shouldDeferToCombat } from '../combatGate.js';
import { tCommand } from '../../i18n/index.js';
import {
    canProcessGraveDuringRecovery,
    findOwnGravesInContext
} from '../utils/graveAwareness.js';

/**
 * 認識範囲内でこのBot所有と明確に分かるGravesX形式の墓をスニーク＋右クリックで回収する。
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
        if (recovery && (isRecoveryEmergencyActive(ctx) || !canProcessGraveDuringRecovery(ctx))) {
            return false;
        }
        const unarmed = needsGearRecovery(ctx.bot);
        // 武装済みなら戦闘へ譲るが、未武装なら先に装備を復旧する。
        if (!recovery && shouldDeferToCombat(ctx) && !unarmed) return false;
        if (ctx.graveLoot?.active) return true;

        return findOwnGravesInContext(ctx).length > 0;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const cfg = ctx.config?.own_grave || {};
        const interactRange = resolveOwnGraveInteractRange(cfg);
        const recovery = ctx.deathRecovery;
        if (recovery?.active && isRecoveryTimedOut(ctx)) {
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
            const graves = findOwnGravesInContext(ctx);
            if (graves.length === 0) return;

            const target = graves[0];
            const pos = target.block.position;
            const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
            ctx.graveLoot.targetKey = key;
            await this._announceFound(ctx, key, pos);

            const reached = await approachGraveForInteract(ctx, pos, {
                interactRange,
                timeoutMs: 10_000
            });

            if ((!reached && !isGraveWithinInteractReach(bot, pos, interactRange)) || !bot.entity) return;

            const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z));
            if (!block || !isGraveCandidateBlock(block.name)) {
                console.warn('[companion] own grave block missing or not a grave candidate');
                return;
            }

            try {
                ctx.movement.stop();
                const preexistingItemIds = groundItemIdsNear(
                    bot,
                    pos,
                    ctx.config?.nearby_loot?.recovery_radius ?? 12
                );
                await claimGraveBlock(bot, block);
                requestRecoveryItemCollection(ctx, pos, Date.now(), 'grave', {
                    preexistingItemIds
                });
                console.log(`[companion] claimed own grave at ${key}`);
            } catch (err) {
                console.warn('[companion] grave claim failed:', err.message || err);
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
            const language = ctx.agent?.language || 'ja';
            await ctx.agent?.openChat?.(
                tCommand(language, 'own_grave_found', { x, y, z })
            );
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
