import { pickupNearbyItems } from '../utils/pickupItems.js';
import { isOwnerWorkDeferring } from '../ownerWorkTracker.js';
import {
    completeDeathRecovery,
    isRecoveryEmergencyActive,
    observeRecoveryItemCollection,
    releaseHoldReflexesIfIdle,
    requestRecoveryItemCollection,
    trackRecoveryItem
} from '../deathRecovery.js';
import {
    hasEssentialWeaponEquipped,
    hasProtectThreats,
    needsGearRecovery,
    shouldDeferToCombat
} from '../combatGate.js';

const DEFAULT_AWARENESS_RADIUS = 10;
const DEFAULT_MAX_MS = 15000;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_GRACE_MS = 2500;
const DEFAULT_RECOVERY_RADIUS = 12;
const DEFAULT_RECOVERY_QUIET_MS = 750;

/**
 * Pick up ground-item entities near the bot.
 * Independent from grave digging / death-return travel — those only get the bot near loot.
 * Suspended while the owner is working (deferring / post-work cooldown).
 * Yields to escort combat (never freezes self-defense).
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
        const recovery = ctx.deathRecovery;
        if (recovery?.active) {
            if (isRecoveryEmergencyActive(ctx)) return false;
            return recovery.phase === 'items';
        }
        if (Date.now() < (ctx.nearbyLoot?.suppressUntil || 0)) return false;
        if (shouldDeferToCombat(ctx) || hasProtectThreats(ctx)) return false;

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
        const recovery = ctx.deathRecovery;
        const recovering = Boolean(recovery?.active && recovery.phase === 'items');
        const radius = recovering
            ? (cfg.recovery_radius ?? Math.max(cfg.radius ?? DEFAULT_AWARENESS_RADIUS, DEFAULT_RECOVERY_RADIUS))
            : (ctx.config?.awareness_radius ?? DEFAULT_AWARENESS_RADIUS);
        const maxMs = cfg.max_ms ?? DEFAULT_MAX_MS;
        const quietMs = cfg.quiet_ms ?? DEFAULT_QUIET_MS;
        const graceMs = cfg.grace_ms ?? DEFAULT_GRACE_MS;

        if (recovering && !recovery.collectionDeadlineAt) {
            // Backward-compatible initialization for an in-flight recovery from
            // an older state shape or a test fixture.
            requestRecoveryItemCollection(
                ctx,
                recovery.collectionOrigin || recovery.deathPos,
                recovery.collectionStartedAt || Date.now(),
                recovery.collectionSource || 'death-site'
            );
        }

        const recoveryQuietMs = cfg.recovery_quiet_ms ?? DEFAULT_RECOVERY_QUIET_MS;
        const deadlineRemainingMs = recovering
            ? Math.max(1, recovery.collectionDeadlineAt - Date.now())
            : maxMs;
        const durationMs = recovering ? Math.min(maxMs, deadlineRemainingMs) : maxMs;
        const recoveryCandidate = recovering
            ? (entity) => {
                const id = Number(entity?.id);
                if (!Number.isFinite(id)) return false;
                if (recovery.ownedItemIdsFrozen) return recovery.ownedItemIds.includes(id);
                return !(recovery.preexistingItemIds || []).includes(id);
            }
            : undefined;

        ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
        ctx.nearbyLoot.active = true;
        // Soft hold: torch / idle chores only. Combat reflexes still tick.
        ctx.holdReflexes = true;

        try {
            await pickupNearbyItems(ctx, {
                radius,
                durationMs,
                // Recovery has its own capture/quiet/deadline completion rule.
                untilClear: !recovering,
                quietMs: recovering ? Math.max(quietMs, recoveryQuietMs) : quietMs,
                graceMs: recovering
                    ? Math.max(graceMs, Math.max(0, recovery.collectionCaptureUntil - Date.now()))
                    : graceMs,
                ownerClearance: 0,
                around: recovering ? (recovery.collectionOrigin || recovery.deathPos) : undefined,
                onItemSeen: recovering ? (entity) => trackRecoveryItem(ctx, entity) : undefined,
                candidateFilter: recoveryCandidate,
                shouldStop: recovering
                    ? () => {
                        const status = observeRecoveryItemCollection(ctx);
                        if (!status) return true;
                        if (status.deadlineReached) return true;
                        return status.captureComplete
                            && status.remainingIds.length === 0
                            && status.quietForMs >= recoveryQuietMs
                            && !needsGearRecovery(bot);
                    }
                    : undefined,
                shouldAbort: recovering
                    ? () => isRecoveryEmergencyActive(ctx) || !ctx.deathRecovery?.active
                    : () => isOwnerWorkDeferring(ctx)
                        || shouldDeferToCombat(ctx)
                        || hasProtectThreats(ctx)
            });

            if (recovering && ctx.deathRecovery?.active && !isRecoveryEmergencyActive(ctx)) {
                const status = observeRecoveryItemCollection(ctx);
                if (!status) return;
                const earlyReady = status.captureComplete
                    && status.remainingIds.length === 0
                    && status.quietForMs >= recoveryQuietMs
                    && !needsGearRecovery(bot);
                if (!earlyReady && !status.deadlineReached) return;

                ctx.deathRecovery.phase = 'equip';
                await ctx.agent?.companion?.autoEquip?.equipBest?.();
                const weaponEquipped = hasEssentialWeaponEquipped(bot);
                if (!status.deadlineReached && !weaponEquipped) {
                    ctx.deathRecovery.phase = 'items';
                    return;
                }
                completeDeathRecovery(
                    ctx,
                    status.deadlineReached
                        ? (status.remainingIds.length > 0
                            ? 'owned-items-unreachable-deadline'
                            : weaponEquipped
                                ? 'collection-deadline-equipped'
                                : 'essential-gear-missing-deadline')
                        : 'owned-items-collected-equipped'
                );
            }
        } finally {
            ctx.nearbyLoot.active = false;
            releaseHoldReflexesIfIdle(ctx);
        }
    }
}
