/**
 * Read an open container window the way mineflayer actually exposes it.
 *
 * While a container is open the server streams `set_slot` into
 * `bot.currentWindow`; `bot.inventory` is only re-synchronised by
 * `closeWindow`. Anything that wants to observe deposit progress therefore has
 * to read the window, in window coordinates, and translate back.
 */

import {
    ARMOR_AND_OFFHAND_SLOTS,
    PLAYER_INVENTORY_SLOT_RANGE
} from './itemRetention.js';

/**
 * @param {{ slot: number, type: number, metadata?: number|null, nbt?: object|null, count: number, name: string, attackDamage?: number }} item
 * @param {number} slot
 */
function toStack(item, slot) {
    return {
        slot,
        type: item.type,
        metadata: item.metadata ?? null,
        nbt: item.nbt ?? null,
        count: item.count,
        name: item.name,
        attackDamage: item.attackDamage || 0
    };
}

/**
 * Whether this container exposes enough of a window to be read live.
 * Simplified test doubles and unexpected server payloads do not, and callers
 * fall back to a `bot.inventory` snapshot for those.
 * @param {object|null} container
 */
export function isReadableContainerWindow(container) {
    return Array.isArray(container?.slots)
        && Number.isInteger(container?.inventoryStart)
        && Number.isInteger(container?.inventoryEnd)
        && container.inventoryEnd > container.inventoryStart;
}

/**
 * Window slot number minus the offset that maps it onto a normal player
 * inventory slot. A single chest offsets by 18, a large chest by 45.
 * @param {import('mineflayer').Bot} bot
 * @param {object} container
 */
export function windowSlotOffset(bot, container) {
    const playerStart = Number.isInteger(bot?.inventory?.inventoryStart)
        ? bot.inventory.inventoryStart
        : PLAYER_INVENTORY_SLOT_RANGE.start;
    return container.inventoryStart - playerStart;
}

/**
 * Live player-side contents of an open container, in normal slot numbers.
 *
 * Armor and the off-hand are not part of any container window, and nothing
 * writes them while one is open, so `bot.inventory` is still accurate there.
 * They are included because retention limits count worn gear, and marked as
 * not depositable because `deposit` cannot reach them.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} container
 * @returns {{ stacks: ReturnType<typeof toStack>[], depositable: Set<number> }|null}
 */
export function readOpenContainerInventory(bot, container) {
    if (!isReadableContainerWindow(container)) return null;
    const offset = windowSlotOffset(bot, container);
    const stacks = [];
    const depositable = new Set();
    for (let windowSlot = container.inventoryStart; windowSlot < container.inventoryEnd; windowSlot += 1) {
        const item = container.slots[windowSlot];
        if (!item?.name) continue;
        const slot = windowSlot - offset;
        depositable.add(slot);
        stacks.push(toStack(item, slot));
    }
    for (const slot of ARMOR_AND_OFFHAND_SLOTS) {
        const item = bot?.inventory?.slots?.[slot];
        if (!item?.name) continue;
        stacks.push(toStack(item, slot));
    }
    return { stacks, depositable };
}

/**
 * How many items of one type are still on the player side of the window.
 * @param {object} container
 * @param {number} type
 */
export function countTypeInWindowInventory(container, type) {
    if (!isReadableContainerWindow(container)) return null;
    let total = 0;
    for (let slot = container.inventoryStart; slot < container.inventoryEnd; slot += 1) {
        const item = container.slots[slot];
        if (item && item.type === type) total += item.count;
    }
    return total;
}

/**
 * Whether the container still has a slot a deposit could land in.
 * Unknown (`null`) for containers that cannot be read.
 * @param {object} container
 * @returns {boolean|null}
 */
export function containerHasRoom(container) {
    if (!isReadableContainerWindow(container)) return null;
    for (let slot = 0; slot < container.inventoryStart; slot += 1) {
        const item = container.slots[slot];
        if (!item) return true;
        if (item.count < (item.stackSize ?? 64)) return true;
    }
    return false;
}

/**
 * Classify why `container.deposit` threw.
 *
 * - `full`: the container has no slot left for this item; the rest of the
 *   inventory must stay in hand rather than be dropped.
 * - `stale`: the planned source stack is no longer where the window says;
 *   skip this item type and keep going.
 * - `other` / `unknown`: anything else, including a thrown non-Error.
 *
 * @param {unknown} err
 * @returns {'full'|'stale'|'other'|'unknown'}
 */
export function classifyDepositError(err) {
    if (err == null) return 'unknown';
    const message = typeof err === 'object' && 'message' in err
        ? String(err.message ?? '')
        : String(err);
    if (!message) return 'unknown';
    if (message.includes('destination full')) return 'full';
    if (message.startsWith("Can't find ") && message.includes(' in slots [')) return 'stale';
    return 'other';
}
