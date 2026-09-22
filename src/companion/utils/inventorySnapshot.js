/**
 * Inventory facts for companion dialogue.
 */

const PLAYER_INVENTORY_START = 9;
const PLAYER_INVENTORY_END = 45;

/**
 * Count only the 36 storage/hotbar slots. Crafting, armor, and off-hand slots
 * sit outside Mineflayer's inventory range and must not affect fullness.
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {{ inventoryUsedSlots: number, inventoryTotalSlots: number, inventoryEmptySlots: number, inventoryFillPercent: number }}
 */
export function snapshotInventoryFill(bot) {
    const inventory = bot?.inventory;
    const slots = inventory?.slots || [];
    const start = Number.isInteger(inventory?.inventoryStart)
        ? inventory.inventoryStart
        : PLAYER_INVENTORY_START;
    const end = Number.isInteger(inventory?.inventoryEnd) && inventory.inventoryEnd > start
        ? inventory.inventoryEnd
        : PLAYER_INVENTORY_END;
    const inventoryTotalSlots = end - start;
    let inventoryUsedSlots = 0;

    for (let slot = start; slot < end; slot++) {
        if (slots[slot] != null) inventoryUsedSlots += 1;
    }

    const inventoryEmptySlots = inventoryTotalSlots - inventoryUsedSlots;
    const inventoryFillPercent = inventoryTotalSlots > 0
        ? Math.round((inventoryUsedSlots / inventoryTotalSlots) * 100)
        : 0;
    return {
        inventoryUsedSlots,
        inventoryTotalSlots,
        inventoryEmptySlots,
        inventoryFillPercent
    };
}
