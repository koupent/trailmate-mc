/**
 * A container window that behaves like the real thing.
 *
 * The production bug this guards against lives in the gap between window
 * coordinates and `bot.inventory`: while a container is open the server only
 * updates the window, and `bot.inventory` is re-synchronised by `close()`.
 * A test double without that distinction cannot see the bug, so this helper
 * keeps them apart the same way mineflayer and prismarine-windows do.
 */

const PLAYER_INVENTORY_START = 9;
const PLAYER_INVENTORY_END = 45;
const DEFAULT_STACK_SIZE = 64;

/** Container slot counts for the two chest shapes. */
export const CHEST_SLOT_COUNTS = Object.freeze({ single: 27, large: 54 });

/** @param {{ stackSize?: number }} item */
function stackSizeOf(item) {
    return item?.stackSize ?? DEFAULT_STACK_SIZE;
}

function copyItem(item, slot) {
    return { ...item, slot };
}

export class FakeContainerWindow {
    /**
     * @param {{ inventory: { slots: Array<object|null> } }} bot
     * @param {{
     *   containerSlotCount?: number,
     *   contents?: Record<number, object>,
     *   events?: string[],
     *   id?: number|string,
     *   onDeposit?: (window: FakeContainerWindow, order: { itemType: number, count: number }) => void|Promise<void>
     * }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.id = options.id ?? 1;
        this.containerSlotCount = options.containerSlotCount ?? CHEST_SLOT_COUNTS.single;
        this.inventoryStart = this.containerSlotCount;
        this.inventoryEnd = this.containerSlotCount + 36;
        this.hotbarStart = this.inventoryEnd - 9;
        this.slots = new Array(this.inventoryEnd).fill(null);
        this.selectedItem = null;
        this.closed = false;
        this.events = options.events || [];
        this.onDeposit = options.onDeposit || null;
        this.onClose = options.onClose || null;
        this.depositCalls = [];

        for (let slot = PLAYER_INVENTORY_START; slot < PLAYER_INVENTORY_END; slot += 1) {
            const item = bot.inventory.slots[slot];
            if (!item) continue;
            this.slots[this.toWindowSlot(slot)] = copyItem(item, this.toWindowSlot(slot));
        }
        for (const [slot, item] of Object.entries(options.contents || {})) {
            const index = Number(slot);
            this.slots[index] = copyItem(item, index);
        }
    }

    /** Normal inventory slot -> window slot. */
    toWindowSlot(slot) {
        return slot + (this.inventoryStart - PLAYER_INVENTORY_START);
    }

    /** Window slot -> normal inventory slot. */
    toInventorySlot(windowSlot) {
        return windowSlot - (this.inventoryStart - PLAYER_INVENTORY_START);
    }

    firstEmptySlotRange(start, end) {
        for (let slot = start; slot < end; slot += 1) {
            if (this.slots[slot] === null) return slot;
        }
        return null;
    }

    findItemRange(start, end, itemType, metadata, notFull, nbt) {
        for (let slot = start; slot < end; slot += 1) {
            const item = this.slots[slot];
            if (!item || item.type !== itemType) continue;
            if (metadata != null && item.metadata !== metadata) continue;
            if (notFull && item.count >= stackSizeOf(item)) continue;
            if (nbt != null && JSON.stringify(nbt) !== JSON.stringify(item.nbt)) continue;
            return item;
        }
        return null;
    }

    /** Items of one type still on the player side of the window. */
    countInventory(itemType) {
        let total = 0;
        for (let slot = this.inventoryStart; slot < this.inventoryEnd; slot += 1) {
            const item = this.slots[slot];
            if (item && item.type === itemType) total += item.count;
        }
        return total;
    }

    /** `{ name: count }` for everything currently stored in the container. */
    containerContents() {
        /** @type {Record<string, number>} */
        const contents = {};
        for (let slot = 0; slot < this.inventoryStart; slot += 1) {
            const item = this.slots[slot];
            if (!item) continue;
            contents[item.name] = (contents[item.name] || 0) + item.count;
        }
        return contents;
    }

    emptyContainerSlots() {
        let empty = 0;
        for (let slot = 0; slot < this.inventoryStart; slot += 1) {
            if (this.slots[slot] === null) empty += 1;
        }
        return empty;
    }

    /**
     * Drop an item into the open window's player side, the way a pickup
     * arrives as a `set_slot` while a container is open.
     * @param {number} slot normal inventory slot
     * @param {object|null} item
     */
    setInventorySlot(slot, item) {
        const windowSlot = this.toWindowSlot(slot);
        this.slots[windowSlot] = item ? copyItem(item, windowSlot) : null;
    }

    /**
     * Mirror of mineflayer's `window.deposit`: moves items of one type from the
     * player side into the container, and only touches window slots.
     */
    async deposit(itemType, metadata, count, nbt) {
        this.depositCalls.push({ itemType, count });
        await this.onDeposit?.(this, { itemType, count });

        let remaining = count == null ? 1 : count;
        while (remaining > 0) {
            const source = this.findItemRange(
                this.inventoryStart,
                this.inventoryEnd,
                itemType,
                metadata,
                false,
                nbt
            );
            if (!source) {
                throw new Error(
                    `Can't find ${nameOfType(this, itemType)} in slots `
                    + `[${this.inventoryStart} - ${this.inventoryEnd}], (item id: ${itemType})`
                );
            }
            // Pick the stack up, exactly like a left click on the source slot.
            this.selectedItem = source;
            this.slots[source.slot] = null;

            const partial = this.findItemRange(
                0,
                this.inventoryStart,
                itemType,
                source.metadata,
                true,
                source.nbt
            );
            const destSlot = partial
                ? partial.slot
                : this.firstEmptySlotRange(0, this.inventoryStart);
            if (destSlot === null) {
                // Cursor keeps holding the stack; the caller has to put it back.
                throw new Error('destination full');
            }

            const room = partial
                ? stackSizeOf(partial) - partial.count
                : stackSizeOf(source);
            const moved = Math.min(remaining, source.count, room);
            if (partial) {
                partial.count += moved;
            } else {
                this.slots[destSlot] = copyItem({ ...source, count: moved }, destSlot);
            }
            this.selectedItem.count -= moved;
            remaining -= moved;

            if (this.selectedItem.count > 0) {
                this.selectedItem.slot = source.slot;
                this.slots[source.slot] = this.selectedItem;
            }
            this.selectedItem = null;
        }
    }

    /** Re-synchronise `bot.inventory` from the window, renumbering slots. */
    close() {
        if (this.closed) return;
        this.closed = true;
        for (let windowSlot = this.inventoryStart; windowSlot < this.inventoryEnd; windowSlot += 1) {
            const slot = this.toInventorySlot(windowSlot);
            const item = this.slots[windowSlot];
            this.bot.inventory.slots[slot] = item ? copyItem(item, slot) : null;
        }
        this.bot.currentWindow = null;
        this.events.push(`close:${this.id}`);
        this.onClose?.(this);
    }
}

function nameOfType(window, itemType) {
    for (const item of window.slots) {
        if (item?.type === itemType) return item.name;
    }
    return `item_${itemType}`;
}

/**
 * Restore an item held by the window cursor, like mineflayer's
 * `bot.putSelectedItemRange`.
 * @param {FakeContainerWindow} window
 * @param {number} slot
 */
export function putSelectedItemRange(_start, _end, window, slot) {
    const item = window.selectedItem;
    if (!item) return;
    item.slot = slot;
    window.slots[slot] = item;
    window.selectedItem = null;
}
