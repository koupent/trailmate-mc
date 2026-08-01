/**
 * Periodically give surplus inventory (beyond retention policy) to the locked owner.
 */

import { isPlayerEligible } from '../ownerLock.js';
import { currentControlOwner } from '../ControlPriority.js';
import { listGiveableStacks, DEFAULT_RETENTION } from './itemRetention.js';
import { giveStacksToPlayer } from './giveAllItems.js';
import { DEFAULT_GIVE_SUPPRESS_MS } from './nearbyLootConstants.js';

export const DEFAULT_ITEM_SHARE_CONFIG = {
    enabled: true,
    interval_ms: 60_000,
    keep_torch_stacks: DEFAULT_RETENTION.keep_torch_stacks,
    keep_food_stacks: DEFAULT_RETENTION.keep_food_stacks,
    keep_equipment_sets: DEFAULT_RETENTION.keep_equipment_sets
};

/**
 * @param {object} [config]
 */
export function createItemShareConfig(config = {}) {
    return {
        ...DEFAULT_ITEM_SHARE_CONFIG,
        ...(config || {})
    };
}

/**
 * Whether periodic transfer is safe to run right now.
 * Pure guard for tests / callers.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ dialogueBusy?: boolean, now?: number, lastRunAt?: number, intervalMs?: number, enabled?: boolean }} [opts]
 */
export function shouldTransferNow(ctx, opts = {}) {
    const enabled = opts.enabled !== false;
    if (!enabled) return false;
    if (!ctx?.bot?.entity) return false;
    if (!ctx.ownerName) return false;
    if (opts.dialogueBusy) return false;
    if (ctx.itemTransfer?.active) return false;
    if (ctx.graveLoot?.active) return false;
    if (ctx.nearbyLoot?.active) return false;
    if (!['follow', 'wait'].includes(currentControlOwner(ctx))) return false;
    if (!isPlayerEligible(ctx, ctx.ownerName)) return false;

    const now = opts.now ?? Date.now();
    const lastRunAt = opts.lastRunAt ?? 0;
    const intervalMs = opts.intervalMs ?? DEFAULT_ITEM_SHARE_CONFIG.interval_ms;
    if (now - lastRunAt < intervalMs) return false;

    return true;
}

export class PeriodicItemTransfer {
    /**
     * @param {object} [config]
     * @param {{ manager?: object, autoEquip?: object, dialogue?: object }} [deps]
     */
    constructor(config = {}, deps = {}) {
        this.config = createItemShareConfig(config);
        this.manager = deps.manager || null;
        this.autoEquip = deps.autoEquip || null;
        this.dialogue = deps.dialogue || null;
        this._lastRunAt = 0;
        this._busy = false;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    /**
     * @returns {{ keep_torch_stacks: number, keep_food_stacks: number, keep_equipment_sets: number }}
     */
    _retentionPolicy() {
        return {
            keep_torch_stacks: this.config.keep_torch_stacks,
            keep_food_stacks: this.config.keep_food_stacks,
            keep_equipment_sets: this.config.keep_equipment_sets
        };
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async maybeRun(ctx) {
        if (this._busy) return;
        if (!shouldTransferNow(ctx, {
            enabled: this.config.enabled,
            dialogueBusy: Boolean(this.dialogue?.isActionBusy),
            now: Date.now(),
            lastRunAt: this._lastRunAt,
            intervalMs: this.config.interval_ms
        })) {
            return;
        }

        const stacks = listGiveableStacks(ctx.bot, this._retentionPolicy());
        if (stacks.length === 0) {
            this._lastRunAt = Date.now();
            return;
        }

        const result = await this._transfer(ctx, stacks);
        // 戦闘による中断は受け渡し完了ではない。通常間隔を待たず、
        // 戦術所有権ラッチの解除後に再試行する。
        if (result !== 'deferred') this._lastRunAt = Date.now();
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {Array<{ slot: number, type: number, count: number, name: string }>} stacks
     */
    async _transfer(ctx, stacks) {
        this._busy = true;
        ctx.itemTransfer = ctx.itemTransfer || { active: false };
        ctx.itemTransfer.active = true;
        this.manager?.pause?.();
        this.autoEquip?.pause?.();
        ctx.movement?.stop?.();

        try {
            try {
                ctx.bot.pvp?.stop?.();
            } catch {
                /* ignore */
            }

            const result = await giveStacksToPlayer(ctx, ctx.ownerName, stacks, {
                shouldAbort: () => currentControlOwner(ctx) !== 'transfer'
            });
            if (result === 'ok') {
                console.log(
                    `[companion] item-share: gave ${stacks.length} stack(s) to ${ctx.ownerName}`
                );
                const ms = ctx.config?.nearby_loot?.give_suppress_ms ?? DEFAULT_GIVE_SUPPRESS_MS;
                ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
                ctx.nearbyLoot.suppressUntil = Date.now() + ms;
            } else if (result === 'deferred') {
                console.log('[companion] item-share: deferred for combat');
            } else if (result !== 'empty') {
                console.warn(`[companion] item-share: transfer result=${result}`);
            }
            return result;
        } catch (err) {
            console.warn('[companion] item-share failed:', err.message || err);
        } finally {
            this.autoEquip?.resume?.();
            this.manager?.resume?.();
            ctx.itemTransfer.active = false;
            this._busy = false;
        }
    }
}
