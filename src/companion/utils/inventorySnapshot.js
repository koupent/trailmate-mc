/**
 * Inventory facts for companion dialogue.
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';
import { isKeepableFood, isTorch } from './itemRetention.js';

const bannedFood = new Set(UNSAFE_OR_SPECIAL_FOODS);
const PLAYER_INVENTORY_START = 9;
const PLAYER_INVENTORY_END = 45;

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {{ foodCount: number, torchCount: number }}
 */
export function countSupplyItems(bot) {
    if (!bot?.inventory) {
        return { foodCount: 0, torchCount: 0 };
    }

    const foodsByName = bot.registry?.foodsByName || {};
    let foodCount = 0;
    let torchCount = 0;

    for (const item of bot.inventory.items()) {
        if (isTorch(item.name)) {
            torchCount += item.count;
        } else if (isKeepableFood(item.name, foodsByName, bannedFood)) {
            foodCount += item.count;
        }
    }

    return { foodCount, torchCount };
}

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
