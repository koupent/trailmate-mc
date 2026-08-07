/**
 * Deposit surplus inventory into a chest deliberately placed in front of the
 * companion by its current follow owner.
 */

import { currentControlOwner } from '../ControlPriority.js';
import { isPlayerEligible } from '../ownerLock.js';
import { DEFAULT_GIVE_SUPPRESS_MS } from './nearbyLootConstants.js';
import { DEFAULT_RETENTION, listChestDepositStacks } from './itemRetention.js';

const CHEST_NAMES = new Set(['chest', 'trapped_chest']);
const REPLACEABLE_NAMES = new Set([
    'air',
    'cave_air',
    'void_air',
    'grass',
    'short_grass',
    'tall_grass',
    'fern',
    'large_fern',
    'snow'
]);
const LATE_SWING_GRACE_MS = 300;

export const DEFAULT_CHEST_TRANSFER_CONFIG = {
    enabled: true,
    placement_swing_window_ms: 1500,
    trigger_max_distance: 4.5,
    owner_place_reach: 6,
    front_dot_min: 0.25,
    keep_torch_stacks: DEFAULT_RETENTION.keep_torch_stacks,
    keep_food_stacks: DEFAULT_RETENTION.keep_food_stacks,
    keep_weapon_stacks: DEFAULT_RETENTION.keep_weapon_stacks,
    keep_bow_stacks: DEFAULT_RETENTION.keep_bow_stacks,
    keep_arrow_stacks: DEFAULT_RETENTION.keep_arrow_stacks
};

/** @param {object} [config] */
export function createChestTransferConfig(config = {}) {
    return {
        ...DEFAULT_CHEST_TRANSFER_CONFIG,
        ...(config || {})
    };
}

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {number} yaw
 * @param {{ x: number, y: number, z: number }} blockPos
 */
export function frontDot(botPos, yaw, blockPos) {
    const dx = blockPos.x + 0.5 - botPos.x;
    const dz = blockPos.z + 0.5 - botPos.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) return 1;
    return ((-Math.sin(yaw || 0) * dx) + (-Math.cos(yaw || 0) * dz)) / length;
}

/**
 * Pure placement guard, exported for deterministic tests.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ name?: string }|null} oldBlock
 * @param {{ name?: string, position?: { x: number, y: number, z: number } }|null} newBlock
 * @param {{ now?: number, lastOwnerSwingAt?: number, config?: object, manager?: object }} [options]
 */
export function isOwnerHandoffChestPlacement(ctx, oldBlock, newBlock, options = {}) {
    const config = createChestTransferConfig(options.config);
    if (config.enabled === false || !ctx?.bot?.entity?.position || !ctx.ownerName) return false;
    if (!newBlock?.position || !CHEST_NAMES.has(String(newBlock.name || ''))) return false;
    if (!oldBlock || !REPLACEABLE_NAMES.has(String(oldBlock.name || ''))) return false;

    const manager = options.manager || ctx.agent?.companion?.manager;
    if (manager?.getCurrentModeId?.() !== 'follow') return false;
    if (currentControlOwner(ctx, 'follow') !== 'follow') return false;
    if (!isPlayerEligible(ctx, ctx.ownerName)) return false;

    const now = options.now ?? Date.now();
    const lastSwing = options.lastOwnerSwingAt ?? 0;
    if (lastSwing <= 0 || now - lastSwing > config.placement_swing_window_ms) return false;

    const botPos = ctx.bot.entity.position;
    const chestCenter = {
        x: newBlock.position.x + 0.5,
        y: newBlock.position.y + 0.5,
        z: newBlock.position.z + 0.5
    };
    if (distance(botPos, chestCenter) > config.trigger_max_distance) return false;
    if (Math.abs(chestCenter.y - botPos.y) > 2.5) return false;
    if (frontDot(botPos, ctx.bot.entity.yaw || 0, newBlock.position) < config.front_dot_min) return false;

    const owner = ctx.ownerEntity;
    if (!owner?.position || distance(owner.position, chestCenter) > config.owner_place_reach) return false;
    return true;
}

export class ChestItemTransfer {
    /**
     * @param {object} [config]
     * @param {{ manager?: object, autoEquip?: object, dialogue?: object }} [deps]
     */
    constructor(config = {}, deps = {}) {
        this.config = createChestTransferConfig(config);
        this.manager = deps.manager || null;
        this.autoEquip = deps.autoEquip || null;
        this.dialogue = deps.dialogue || null;
        this._lastOwnerSwingAt = 0;
        this._pendingPlacement = null;
        this._busy = false;
        this._dispose = null;
    }

    /** @param {import('../CompanionContext.js').CompanionContext} ctx */
    attach(ctx) {
        this.detach();
        const onSwing = (entity) => {
            const now = Date.now();
            if (!this.noteOwnerSwing(ctx, entity, now)) return;
            const pending = this._pendingPlacement;
            if (!pending) return;
            if (now - pending.at > LATE_SWING_GRACE_MS) {
                this._pendingPlacement = null;
                return;
            }
            this._pendingPlacement = null;
            void this.handleBlockUpdate(ctx, pending.oldBlock, pending.newBlock, now).catch((err) => {
                console.warn('[companion] chest item-share event failed:', err?.message || err);
            });
        };
        const onBlockUpdate = (oldBlock, newBlock) => {
            const now = Date.now();
            const swingIsRecent = now - this._lastOwnerSwingAt <= this.config.placement_swing_window_ms;
            if (!swingIsRecent && isOwnerHandoffChestPlacement(ctx, oldBlock, newBlock, {
                now,
                // Check all non-swing placement conditions, then briefly wait in
                // case the server broadcasts the arm animation after the block.
                lastOwnerSwingAt: now,
                config: this.config,
                manager: this.manager
            })) {
                this._pendingPlacement = { oldBlock, newBlock, at: now };
                return;
            }
            void this.handleBlockUpdate(ctx, oldBlock, newBlock).catch((err) => {
                console.warn('[companion] chest item-share event failed:', err?.message || err);
            });
        };
        ctx.bot.on('entitySwingArm', onSwing);
        ctx.bot.on('blockUpdate', onBlockUpdate);
        this._dispose = () => {
            ctx.bot.off('entitySwingArm', onSwing);
            ctx.bot.off('blockUpdate', onBlockUpdate);
        };
        return this._dispose;
    }

    detach() {
        this._dispose?.();
        this._dispose = null;
        this._pendingPlacement = null;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ id?: number }} entity
     * @param {number} [now]
     */
    noteOwnerSwing(ctx, entity, now = Date.now()) {
        if (!entity?.id || entity.id !== ctx.ownerEntity?.id) return false;
        this._lastOwnerSwingAt = now;
        return true;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ name?: string }|null} oldBlock
     * @param {{ name?: string, position?: { x: number, y: number, z: number } }|null} newBlock
     * @param {number} [now]
     */
    async handleBlockUpdate(ctx, oldBlock, newBlock, now = Date.now()) {
        if (this._busy) return 'busy';
        if (this.dialogue?.isActionBusy) return 'deferred';
        if (!isOwnerHandoffChestPlacement(ctx, oldBlock, newBlock, {
            now,
            lastOwnerSwingAt: this._lastOwnerSwingAt,
            config: this.config,
            manager: this.manager
        })) return 'ignored';

        // Consume the placement gesture so a second unrelated block update from
        // a double chest cannot trigger another transfer.
        this._lastOwnerSwingAt = 0;
        const stacks = listChestDepositStacks(ctx.bot, this.config);
        if (stacks.length === 0) return 'empty';
        return this._deposit(ctx, newBlock, stacks);
    }

    _shouldAbort(ctx) {
        return currentControlOwner(ctx, 'follow') !== 'transfer';
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ position: { x: number, y: number, z: number } }} placedBlock
     * @param {Array<{ slot: number, type: number, metadata?: number|null, nbt?: object|null, count: number, name: string }>} stacks
     */
    async _deposit(ctx, placedBlock, stacks) {
        this._busy = true;
        ctx.itemTransfer = ctx.itemTransfer || { active: false };
        ctx.itemTransfer.active = true;
        this.manager?.pause?.();
        this.autoEquip?.pause?.();
        ctx.movement?.stop?.();
        let container = null;
        let deposited = 0;

        try {
            try {
                ctx.bot.pvp?.stop?.();
            } catch {
                /* ignore */
            }
            if (this._shouldAbort(ctx)) return 'deferred';

            const center = placedBlock.position.offset
                ? placedBlock.position.offset(0.5, 0.5, 0.5)
                : {
                    x: placedBlock.position.x + 0.5,
                    y: placedBlock.position.y + 0.5,
                    z: placedBlock.position.z + 0.5
                };
            await ctx.bot.lookAt?.(center);
            if (this._shouldAbort(ctx)) return 'deferred';

            const liveBlock = ctx.bot.blockAt?.(placedBlock.position) || placedBlock;
            container = await ctx.bot.openContainer(liveBlock);
            for (const stack of stacks) {
                if (this._shouldAbort(ctx)) return deposited > 0 ? 'partial' : 'deferred';
                const live = resolveLiveStack(ctx.bot, stack);
                if (!live) continue;
                try {
                    await container.deposit(
                        live.type,
                        live.metadata ?? null,
                        live.count,
                        live.nbt ?? null
                    );
                    deposited += 1;
                } catch (err) {
                    console.warn(
                        `[companion] chest item-share stopped at ${live.name}:`,
                        err?.message || err
                    );
                    break;
                }
            }

            if (deposited > 0) {
                const ms = ctx.config?.nearby_loot?.give_suppress_ms ?? DEFAULT_GIVE_SUPPRESS_MS;
                ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
                ctx.nearbyLoot.suppressUntil = Date.now() + ms;
                console.log(
                    `[companion] item-share: deposited ${deposited} stack(s) into owner chest`
                );
                return deposited === stacks.length ? 'ok' : 'partial';
            }
            return 'failed';
        } catch (err) {
            console.warn('[companion] chest item-share failed:', err?.message || err);
            return deposited > 0 ? 'partial' : 'failed';
        } finally {
            try {
                container?.close?.();
            } catch {
                /* ignore */
            }
            this.autoEquip?.resume?.();
            this.manager?.resume?.();
            ctx.itemTransfer.active = false;
            this._busy = false;
        }
    }
}

function resolveLiveStack(bot, snapshot) {
    const slots = bot?.inventory?.slots || [];
    const exact = slots[snapshot.slot];
    if (exact && exact.type === snapshot.type) return exact;
    return slots.find((item) => item && item.type === snapshot.type && item.count === snapshot.count) || null;
}
