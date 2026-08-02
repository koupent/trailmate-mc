/**
 * Inventory counts for companion dialogue (food / torch awareness).
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';
import { isKeepableFood, isTorch } from './itemRetention.js';

const bannedFood = new Set(UNSAFE_OR_SPECIAL_FOODS);

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
