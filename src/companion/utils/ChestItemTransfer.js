/**
 * Deposit surplus inventory into a chest deliberately placed in front of the
 * companion by its current follow owner.
 *
 * The deposit is a converging process, not a one-shot replay of a snapshot:
 * every step re-reads the open window, re-plans, and checks that the last
 * deposit actually moved something. Nothing left in hand is ever dropped
 * silently — a full chest, a failure, or an interruption all end with the
 * remainder still on the companion and the owner told about it.
 */

import { currentControlOwner } from '../ControlPriority.js';
import { isPlayerEligible } from '../ownerLock.js';
import { approachPosition } from './approachPosition.js';
import { DEFAULT_GIVE_SUPPRESS_MS } from './nearbyLootConstants.js';
import {
    DEFAULT_RETENTION,
    isPlayerInventorySlot,
    equippedItemSlots,
    listChestDepositPlan,
    planDepositByType
} from './itemRetention.js';
import {
    classifyDepositError,
    containerHasRoom,
    countTypeInWindowInventory,
    readOpenContainerInventory
} from './containerWindow.js';

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

/** Hard stop for the per-window deposit loop; 36 slots cannot need more. */
const MAX_DEPOSIT_STEPS = 128;
/** Unclassified failures in a row before this container is given up on. */
const MAX_CONSECUTIVE_DEPOSIT_ERRORS = 3;
const RESUME_APPROACH_RANGE = 2.5;
const RESUME_APPROACH_TIMEOUT_MS = 8000;

export const DEFAULT_CHEST_TRANSFER_CONFIG = {
    enabled: true,
    placement_swing_window_ms: 1500,
    trigger_max_distance: 4.5,
    owner_place_reach: 6,
    front_dot_min: 0.25,
    /** Re-open an interrupted chest once control comes back. */
    resume_enabled: true,
    /** How long an interrupted chest stays worth returning to. */
    resume_expire_ms: 120000,
    /** Wait between resume attempts. */
    resume_retry_ms: 3000,
    /** Resume attempts per chest before it is dropped. */
    resume_max_attempts: 5,
    /** Open/close cycles per chest placement. */
    max_open_passes: 4,
    /** Tell the owner what happened to the deposit. */
    notify_enabled: true,
    /**
     * Abort while the damage latch is up. Default keeps today's behaviour:
     * a single point of damage hands control to combat for ~4s.
     */
    abort_on_recent_damage: true,
    keep_torch_stacks: DEFAULT_RETENTION.keep_torch_stacks,
    keep_food_stacks: DEFAULT_RETENTION.keep_food_stacks,
    keep_weapon_stacks: DEFAULT_RETENTION.keep_weapon_stacks,
    keep_equipment_sets: DEFAULT_RETENTION.keep_equipment_sets
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
 * @param {{
 *   now?: number,
 *   lastOwnerSwingAt?: number,
 *   config?: object,
 *   manager?: object,
 *   allowTransferControl?: boolean
 * }} [options]
 */
export function isOwnerHandoffChestPlacement(ctx, oldBlock, newBlock, options = {}) {
    const config = createChestTransferConfig(options.config);
    if (config.enabled === false || !ctx?.bot?.entity?.position || !ctx.ownerName) return false;
    if (!newBlock?.position || !CHEST_NAMES.has(String(newBlock.name || ''))) return false;
    if (!oldBlock || !REPLACEABLE_NAMES.has(String(oldBlock.name || ''))) return false;

    const manager = options.manager || ctx.agent?.companion?.manager;
    if (manager?.getCurrentModeId?.() !== 'follow') return false;
    const controlOwner = currentControlOwner(ctx, 'follow');
    const transferCanQueue = options.allowTransferControl === true
        && controlOwner === 'transfer';
    if (controlOwner !== 'follow' && !transferCanQueue) return false;
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
        this._queuedPlacements = [];
        this._busy = false;
        this._dispose = null;
        /**
         * Chest left unfinished by an interruption, retried from the companion
         * loop once control comes back.
         * @type {{
         *   position: { x: number, y: number, z: number },
         *   key: string,
         *   queued: Array<{ key: string, placedBlock: object }>,
         *   expiresAt: number,
         *   nextAttemptAt: number
         * }|null}
         */
        this._resume = null;
        this._resumeAttemptKey = null;
        this._resumeAttempts = 0;
    }

    /** Chest waiting to be finished, or null. Read-only view for callers/tests. */
    get pendingResume() {
        return this._resume;
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
                manager: this.manager,
                allowTransferControl: this._busy
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
        this._queuedPlacements = [];
        this._resume = null;
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
        const transferInProgress = this._busy;
        if (!transferInProgress && this.dialogue?.isActionBusy) return 'deferred';
        if (!isOwnerHandoffChestPlacement(ctx, oldBlock, newBlock, {
            now,
            lastOwnerSwingAt: this._lastOwnerSwingAt,
            config: this.config,
            manager: this.manager,
            allowTransferControl: transferInProgress
        })) return transferInProgress ? 'busy' : 'ignored';

        // Consume the placement gesture so a second unrelated block update from
        // a double chest cannot trigger another transfer.
        this._lastOwnerSwingAt = 0;
        if (transferInProgress) {
            this._enqueuePlacement(newBlock);
            return 'queued';
        }
        if (this._depositPlan(ctx.bot).length === 0) return 'empty';
        return this._runDepositQueue(ctx, { placedBlock: newBlock });
    }

    /**
     * Retry a chest an interruption cut short. Driven by the companion loop.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {number} [now]
     * @returns {Promise<string>}
     */
    async maybeResume(ctx, now = Date.now()) {
        if (this.config.resume_enabled === false) {
            if (this._resume) this._clearResume();
            return 'disabled';
        }
        const resume = this._resume;
        if (!resume) return 'idle';
        if (this._busy || this.dialogue?.isActionBusy) return 'busy';
        if (!ctx?.bot?.entity) return 'waiting';
        if (now > resume.expiresAt) {
            this._clearResume();
            return 'expired';
        }
        if (now < resume.nextAttemptAt) return 'waiting';

        const upperMode = this.manager?.getCurrentModeId?.() === 'wait' ? 'wait' : 'follow';
        if (!['follow', 'wait'].includes(currentControlOwner(ctx, upperMode))) {
            resume.nextAttemptAt = now + this.config.resume_retry_ms;
            return 'waiting';
        }
        if (this._resumeAttempts >= this.config.resume_max_attempts) {
            console.warn('[companion] chest item-share gave up resuming the owner chest');
            this._clearResume();
            return 'exhausted';
        }

        const block = ctx.bot.blockAt?.(resume.position);
        if (!block || !CHEST_NAMES.has(String(block.name || ''))) {
            this._clearResume();
            return 'gone';
        }
        if (this._depositPlan(ctx.bot).length === 0) {
            this._clearResume();
            return 'empty';
        }

        this._resumeAttempts += 1;
        resume.nextAttemptAt = now + this.config.resume_retry_ms;
        this._resume = null;
        this._queuedPlacements = (resume.queued || []).slice();
        await this._notify('chest_deposit_resume');
        return this._runDepositQueue(ctx, {
            placedBlock: { name: block.name, position: resume.position },
            approach: true
        });
    }

    _enqueuePlacement(placedBlock) {
        const key = blockPositionKey(placedBlock);
        if (this._queuedPlacements.some((pending) => pending.key === key)) return;
        this._queuedPlacements.push({ key, placedBlock });
    }

    /**
     * Ownership is checked before every step, so a deposit never keeps the bot
     * standing still while something more urgent wants control.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    _shouldAbort(ctx) {
        const owner = currentControlOwner(ctx, 'follow');
        if (owner === 'transfer') return false;
        if (owner === 'combat' && this.config.abort_on_recent_damage === false) {
            // Only real combat, not the post-damage latch, takes the chest away.
            const reflexes = ctx?.agent?.reflexes;
            return Boolean(
                ctx?.agent?.companion?.manager?.getActiveFsmId?.() === 'combat'
                || reflexes?.isControllingMovement
                || ctx?.bot?.pvp?.target
            );
        }
        return true;
    }

    /**
     * Surplus still worth depositing, read from `bot.inventory`. Only valid
     * while no container window is open.
     * @param {import('mineflayer').Bot} bot
     */
    _depositPlan(bot) {
        return listChestDepositPlan(bot, this.config);
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ placedBlock: object, approach?: boolean }} initialTransfer
     */
    async _runDepositQueue(ctx, initialTransfer) {
        this._busy = true;
        ctx.itemTransfer = ctx.itemTransfer || { active: false };
        ctx.itemTransfer.active = true;
        this.manager?.pause?.();
        this.autoEquip?.pause?.();
        ctx.movement?.stop?.();
        const summary = {
            deposited: 0,
            chestFull: false,
            failed: false,
            interrupted: false,
            /** @type {object|null} */
            chest: null
        };
        try {
            try {
                ctx.bot.pvp?.stop?.();
            } catch {
                /* ignore */
            }

            let nextTransfer = initialTransfer;
            if (this._shouldAbort(ctx)) {
                summary.interrupted = true;
                summary.chest = initialTransfer.placedBlock;
                nextTransfer = null;
            }
            while (nextTransfer) {
                const outcome = await this._depositIntoChest(ctx, nextTransfer);
                summary.deposited += outcome.deposited;
                if (outcome.chestFull) summary.chestFull = true;
                if (outcome.failed) summary.failed = true;
                if (outcome.interrupted) {
                    summary.interrupted = true;
                    summary.chest = nextTransfer.placedBlock;
                    break;
                }
                nextTransfer = this._takeNextQueuedTransfer(ctx);
            }
            return await this._finishQueue(ctx, summary);
        } finally {
            this._queuedPlacements = [];
            this.autoEquip?.resume?.();
            this.manager?.resume?.();
            ctx.itemTransfer.active = false;
            this._busy = false;
        }
    }

    _takeNextQueuedTransfer(ctx) {
        const pending = this._queuedPlacements.shift();
        if (!pending) return null;
        if (this._depositPlan(ctx.bot).length === 0) return null;
        return { placedBlock: pending.placedBlock };
    }

    /**
     * Record what happened, tell the owner, and decide whether the chest is
     * worth coming back to. Runs with every container closed, so
     * `bot.inventory` is trustworthy again.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ deposited: number, chestFull: boolean, failed: boolean, interrupted: boolean, chest: object|null }} summary
     */
    async _finishQueue(ctx, summary) {
        const remaining = this._depositPlan(ctx.bot).length;

        if (summary.deposited > 0) {
            const ms = ctx.config?.nearby_loot?.give_suppress_ms ?? DEFAULT_GIVE_SUPPRESS_MS;
            ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
            ctx.nearbyLoot.suppressUntil = Date.now() + ms;
            console.log(
                `[companion] item-share: deposited ${summary.deposited} stack(s) into owner chest`
            );
        }

        if (summary.interrupted && remaining > 0 && summary.chest) {
            this._rememberResume(summary.chest);
        } else {
            this._clearResume();
        }

        if (this._resume) {
            await this._notify('chest_deposit_later');
        } else if (summary.chestFull && remaining > 0) {
            await this._notify('chest_full');
        } else if (remaining > 0 && summary.deposited > 0) {
            await this._notify('chest_deposit_partial');
        } else if (remaining === 0 && summary.deposited > 0) {
            await this._notify('chest_deposit_done');
        }

        if (summary.deposited > 0) return remaining === 0 ? 'ok' : 'partial';
        if (summary.interrupted) return 'deferred';
        return 'failed';
    }

    /** @param {object} placedBlock */
    _rememberResume(placedBlock) {
        if (this.config.resume_enabled === false) {
            this._clearResume();
            return;
        }
        const position = placedBlock?.position;
        if (!position || typeof position.x !== 'number') {
            this._clearResume();
            return;
        }
        const key = blockPositionKey(placedBlock);
        if (this._resumeAttemptKey !== key) {
            this._resumeAttemptKey = key;
            this._resumeAttempts = 0;
        }
        const now = Date.now();
        this._resume = {
            position,
            key,
            queued: this._queuedPlacements.slice(),
            expiresAt: now + this.config.resume_expire_ms,
            nextAttemptAt: now + this.config.resume_retry_ms
        };
        console.log(
            `[companion] item-share: chest deposit interrupted, will resume at ${key}`
        );
    }

    _clearResume() {
        this._resume = null;
        this._resumeAttemptKey = null;
        this._resumeAttempts = 0;
    }

    /**
     * @param {string} key
     * @param {Record<string, string|number>} [vars]
     */
    async _notify(key, vars = {}) {
        if (this.config.notify_enabled === false) return false;
        if (typeof this.dialogue?.speakNotice !== 'function') return false;
        try {
            return await this.dialogue.speakNotice(key, vars);
        } catch (err) {
            console.warn('[companion] chest item-share notice failed:', err?.message || err);
            return false;
        }
    }

    /**
     * Open, drain, close — repeat while the closed-window view still shows
     * surplus this chest has not been offered yet.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ placedBlock: object, approach?: boolean }} transfer
     */
    async _depositIntoChest(ctx, transfer) {
        const total = { deposited: 0, chestFull: false, failed: false, interrupted: false };
        const maxPasses = Math.max(1, Math.trunc(Number(this.config.max_open_passes) || 1));
        for (let pass = 0; pass < maxPasses; pass += 1) {
            const outcome = await this._runOpenPass(
                ctx,
                transfer.placedBlock,
                pass === 0 && transfer.approach === true
            );
            total.deposited += outcome.deposited;
            if (outcome.chestFull) total.chestFull = true;
            if (outcome.failed) total.failed = true;
            if (outcome.interrupted) {
                total.interrupted = true;
                break;
            }
            if (outcome.chestFull || outcome.roomLeft === false) break;
            // Nothing was even offered: walking up to the chest or opening it
            // failed, and another identical attempt will not do better.
            if (outcome.failed && outcome.deposited === 0 && outcome.skipped.size === 0) break;
            // Anything the pass already gave up on will fail the same way again.
            const leftovers = this._depositPlan(ctx.bot);
            if (!leftovers.some((entry) => !outcome.skipped.has(entry.type))) break;
        }
        return total;
    }

    /**
     * One open/close cycle.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ position: { x: number, y: number, z: number } }} placedBlock
     * @param {boolean} approach
     */
    async _runOpenPass(ctx, placedBlock, approach) {
        let container = null;
        try {
            if (approach && !(await this._approachChest(ctx, placedBlock.position))) {
                return emptyPassOutcome({ interrupted: this._shouldAbort(ctx), failed: true });
            }
            await ctx.bot.lookAt?.(blockCenter(placedBlock.position));
            if (this._shouldAbort(ctx)) return emptyPassOutcome({ interrupted: true });

            const liveBlock = ctx.bot.blockAt?.(placedBlock.position) || placedBlock;
            container = await ctx.bot.openContainer(liveBlock);
            const drained = await this._drainIntoContainer(ctx, container);
            return { ...drained, roomLeft: containerHasRoom(container) };
        } catch (err) {
            console.warn('[companion] chest item-share failed:', err?.message || err);
            return emptyPassOutcome({ failed: true });
        } finally {
            try {
                container?.close?.();
            } catch {
                /* ignore */
            }
        }
    }

    /**
     * Deposit until the open window shows nothing left to give. The plan is
     * recomputed from the window before every single deposit, so items picked
     * up mid-transfer are included and finished ones are not retried.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {object} container
     */
    async _drainIntoContainer(ctx, container) {
        /** Item types this container will not take; never retried in this pass. */
        const skipped = new Set();
        const outcome = {
            deposited: 0,
            chestFull: false,
            failed: false,
            interrupted: false,
            skipped
        };
        let consecutiveErrors = 0;

        for (let step = 0; step < MAX_DEPOSIT_STEPS; step += 1) {
            if (this._shouldAbort(ctx)) {
                outcome.interrupted = true;
                break;
            }
            const order = this._planFromContainer(ctx, container)
                .find((entry) => !skipped.has(entry.type));
            if (!order) break;

            const before = this._countHeld(ctx, container, order.type);
            let thrown = null;
            try {
                // metadata / nbt stay null: the plan is a per-type amount, and
                // any same-type stack in the window satisfies it.
                await container.deposit(order.type, null, order.count, null);
            } catch (err) {
                thrown = err;
                await restoreContainerCursor(ctx.bot, container);
            }
            const after = this._countHeld(ctx, container, order.type);
            if (after < before) outcome.deposited += 1;

            if (!thrown) {
                consecutiveErrors = 0;
                // No observable movement: stop offering this type rather than
                // spin on it, but keep working through everything else.
                if (after >= before) skipped.add(order.type);
                continue;
            }

            skipped.add(order.type);
            const kind = classifyDepositError(thrown);
            if (kind === 'full') {
                console.warn(
                    `[companion] chest item-share: chest is full, keeping ${order.name} and the rest`
                );
                outcome.chestFull = true;
                break;
            }
            if (kind === 'stale') {
                console.warn(
                    `[companion] chest item-share skipped stale ${order.name} stack:`,
                    thrown?.message || thrown
                );
                consecutiveErrors = 0;
                continue;
            }
            outcome.failed = true;
            consecutiveErrors += 1;
            console.warn(
                `[companion] chest item-share could not deposit ${order.name}:`,
                thrown?.message || thrown
            );
            if (consecutiveErrors >= MAX_CONSECUTIVE_DEPOSIT_ERRORS) break;
        }

        return outcome;
    }

    /**
     * Deposit orders from the live window when it can be read, otherwise from
     * the (closed-window) inventory snapshot.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {object} container
     */
    _planFromContainer(ctx, container) {
        const live = readOpenContainerInventory(ctx.bot, container);
        if (!live) return this._depositPlan(ctx.bot);
        return planDepositByType(live.stacks, this.config, {
            equippedSlots: equippedItemSlots(ctx.bot),
            foodsByName: ctx.bot?.registry?.foodsByName || {},
            isDepositable: (slot) => live.depositable.has(slot)
        });
    }

    /**
     * How much of one type is still on the player side.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {object} container
     * @param {number} type
     */
    _countHeld(ctx, container, type) {
        const live = countTypeInWindowInventory(container, type);
        if (live != null) return live;
        let total = 0;
        for (const item of ctx.bot?.inventory?.slots || []) {
            if (item && item.type === type && isPlayerInventorySlot(item.slot)) total += item.count;
        }
        return total;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     */
    async _approachChest(ctx, position) {
        const botPos = ctx.bot?.entity?.position;
        const center = blockCenter(position);
        if (!botPos) return false;
        if (distance(botPos, center) <= this.config.trigger_max_distance) return true;
        return approachPosition(ctx, center, {
            range: RESUME_APPROACH_RANGE,
            pathRange: RESUME_APPROACH_RANGE,
            timeoutMs: RESUME_APPROACH_TIMEOUT_MS,
            abort: () => this._shouldAbort(ctx)
        });
    }
}

/**
 * @param {{ deposited?: number, chestFull?: boolean, failed?: boolean, interrupted?: boolean }} [overrides]
 */
function emptyPassOutcome(overrides = {}) {
    return {
        deposited: 0,
        chestFull: false,
        failed: false,
        interrupted: false,
        skipped: new Set(),
        roomLeft: null,
        ...overrides
    };
}

/** @param {{ x: number, y: number, z: number, offset?: Function }} position */
function blockCenter(position) {
    return position.offset
        ? position.offset(0.5, 0.5, 0.5)
        : { x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 };
}

function blockPositionKey(block) {
    const position = block?.position;
    return position ? `${position.x},${position.y},${position.z}` : 'unknown';
}

async function restoreContainerCursor(bot, container) {
    if (!container?.selectedItem || typeof bot?.putSelectedItemRange !== 'function') return;
    const fallbackSlot = container.firstEmptySlotRange?.(
        container.inventoryStart,
        container.inventoryEnd
    );
    if (!Number.isInteger(fallbackSlot)) {
        console.warn('[companion] chest item-share could not find a safe cursor return slot');
        return;
    }
    try {
        await bot.putSelectedItemRange(
            container.inventoryStart,
            container.inventoryEnd,
            container,
            fallbackSlot
        );
    } catch (err) {
        console.warn(
            '[companion] chest item-share could not restore cursor item:',
            err?.message || err
        );
    }
}
