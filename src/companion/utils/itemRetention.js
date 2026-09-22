/**
 * Decide which inventory stacks the companion should keep vs give away.
 *
 * Retention is an allow-list over the categories in `itemClassify`: a stack is
 * kept only when its category appears in `RETENTION_LIMIT_KEY_BY_CATEGORY` and
 * it ranks inside that category's limit. Everything else goes back to the
 * owner, so a classification rule this repo has not written yet costs an item
 * handed over — never an item stuck in the companion's inventory forever.
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';
import {
    classifyItemName,
    classifyOptionsFromBot,
    isEquipmentCategory,
    isRetainedCategory,
    ITEM_CATEGORY,
    materialScore,
    RETENTION_LIMIT_KEY_BY_CATEGORY
} from './itemClassify.js';

export const DEFAULT_RETENTION = {
    keep_torch_stacks: 2,
    keep_food_stacks: 2,
    keep_equipment_sets: 2,
    keep_weapon_stacks: 2
};

/** Prefer attackDamage over material tier when ranking weapons. */
const WEAPON_DAMAGE_WEIGHT = 10;

/**
 * @param {string} name
 * @returns {number}
 */
export function tierOf(name) {
    return materialScore(name, classifyItemName(name));
}

/**
 * @param {string} name
 */
export function isTorch(name) {
    return classifyItemName(name) === ITEM_CATEGORY.torch;
}

/**
 * @param {string} name
 * @param {Record<string, { foodPoints?: number, saturation?: number }>} foodsByName
 * @param {Set<string>} bannedFood
 */
export function isKeepableFood(name, foodsByName, bannedFood) {
    return classifyItemName(name, {
        foodsByName,
        excludedFoods: bannedFood
    }) === ITEM_CATEGORY.food;
}

/**
 * Equipment slot group for retention (null = not equipment).
 * @param {string} name
 * @param {import('./itemClassify.js').ClassifyOptions} [options]
 * @returns {'helmet'|'chestplate'|'leggings'|'boots'|'shield'|'weapon'|null}
 */
export function equipmentGroup(name, options = {}) {
    const category = classifyItemName(name, options);
    return isEquipmentCategory(category)
        ? /** @type {'helmet'|'chestplate'|'leggings'|'boots'|'shield'|'weapon'} */ (category)
        : null;
}

/**
 * @param {{ name: string, attackDamage?: number }} item
 * @param {import('./itemClassify.js').ClassifyOptions} [options]
 */
export function equipmentScore(item, options = {}) {
    const category = classifyItemName(item.name, options);
    const score = materialScore(item.name, category);
    if (category === ITEM_CATEGORY.weapon) {
        return (item.attackDamage || 0) * WEAPON_DAMAGE_WEIGHT + score;
    }
    return score;
}

/**
 * Keep the top N stacks (by compare) in keepSlots.
 * @param {Array<{ slot: number }>} items
 * @param {number} keepCount
 * @param {(a: any, b: any) => number} compareDesc
 * @param {Set<number>} keepSlots
 */
function keepTopStacks(items, keepCount, compareDesc, keepSlots) {
    const ranked = items.slice().sort(compareDesc);
    for (const stack of ranked.slice(0, keepCount)) {
        keepSlots.add(stack.slot);
    }
}

/**
 * @param {{ name: string }} a
 * @param {{ name: string }} b
 * @param {Record<string, { foodPoints?: number, saturation?: number }>} foodsByName
 */
function compareFoodDesc(a, b, foodsByName) {
    const fa = foodsByName[a.name] || { foodPoints: 0, saturation: 0 };
    const fb = foodsByName[b.name] || { foodPoints: 0, saturation: 0 };
    const points = (fb.foodPoints || 0) - (fa.foodPoints || 0);
    if (points !== 0) return points;
    return (fb.saturation || 0) - (fa.saturation || 0);
}

/**
 * How a category ranks its own stacks when only some of them fit the limit.
 * @param {string} category
 * @returns {(a: any, b: any, context: any) => number}
 */
function comparatorFor(category) {
    if (category === ITEM_CATEGORY.food) {
        return (a, b, context) => compareFoodDesc(a, b, context.foodsByName);
    }
    if (category === ITEM_CATEGORY.torch) return (a, b) => b.count - a.count;
    return (a, b, context) => equipmentScore(b, context) - equipmentScore(a, context);
}

/**
 * Every retention category in a fixed request order, with the setting that
 * defines its target count. Built straight from the classifier's allow-list,
 * so keep decisions and shortage requests cannot drift from each other — or
 * from what the classifier thinks an item is.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   limitKey: keyof typeof DEFAULT_RETENTION,
 *   equipment: boolean,
 *   matches: (stack: any, context: any) => boolean,
 *   compare: (a: any, b: any, context: any) => number
 * }>}
 */
export const RETENTION_CATEGORIES = Object.freeze(
    Object.entries(RETENTION_LIMIT_KEY_BY_CATEGORY).map(([category, limitKey]) => Object.freeze({
        id: category,
        limitKey,
        /** Worn and wielded pieces count against their own limit. */
        equipment: isEquipmentCategory(category),
        matches: (/** @type {any} */ stack, /** @type {any} */ context) => (
            classifyItemName(stack.name, context) === category
        ),
        compare: comparatorFor(category)
    }))
);

/**
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {keyof typeof DEFAULT_RETENTION} key
 */
function retentionLimit(policy, key) {
    const configured = policy[key] ?? DEFAULT_RETENTION[key] ?? 0;
    return Math.max(0, Math.trunc(Number(configured) || 0));
}

/**
 * Keep equipped items plus the best spares up to each category's total limit.
 * Stacked categories (food, torches) have no equipped notion and simply keep
 * their best N.
 *
 * @param {Array<{ slot: number, name: string, count: number }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {{ foodsByName: object, excludedFoods: Set<string>, itemsByName?: object }} context
 * @param {Set<number>} equippedSlots
 * @param {Set<number>} keepSlots
 */
function applyRetention(stacks, policy, context, equippedSlots, keepSlots) {
    for (const rule of RETENTION_CATEGORIES) {
        const groupStacks = stacks.filter((stack) => rule.matches(stack, context));
        const limit = retentionLimit(policy, rule.limitKey);
        if (!rule.equipment) {
            keepTopStacks(groupStacks, limit, (a, b) => rule.compare(a, b, context), keepSlots);
            continue;
        }
        const equippedCount = groupStacks.filter((stack) => equippedSlots.has(stack.slot)).length;
        keepTopStacks(
            groupStacks.filter((stack) => !equippedSlots.has(stack.slot)),
            Math.max(0, limit - equippedCount),
            (a, b) => rule.compare(a, b, context),
            keepSlots
        );
    }
}

/**
 * Slot numbers that mineflayer's player inventory reserves for worn armor and
 * the off-hand, with the equip destination each one answers to. No container
 * window maps them, so they are read from `bot.inventory` even while a chest
 * is open — and a deposit cannot reach them at all.
 */
const EQUIPMENT_DESTINATION_SLOTS = Object.freeze([
    Object.freeze({ destination: 'head', slot: 5 }),
    Object.freeze({ destination: 'torso', slot: 6 }),
    Object.freeze({ destination: 'legs', slot: 7 }),
    Object.freeze({ destination: 'feet', slot: 8 }),
    Object.freeze({ destination: 'off-hand', slot: 45 })
]);

export const ARMOR_AND_OFFHAND_SLOTS = Object.freeze(
    EQUIPMENT_DESTINATION_SLOTS.map((entry) => entry.slot)
);

/** First and last (exclusive) player-inventory slot inside a container window. */
export const PLAYER_INVENTORY_SLOT_RANGE = Object.freeze({ start: 9, end: 45 });

/**
 * Armor / off-hand destinations for this bot. Mineflayer's answer wins when it
 * has one; the layout above is the fallback, which also makes the policy
 * usable in deterministic tests whose Bot stub does not expose the helper.
 * @param {import('mineflayer').Bot} bot
 * @returns {Array<{ destination: string, slot: number }>}
 */
function equipmentDestinations(bot) {
    return EQUIPMENT_DESTINATION_SLOTS.map(({ destination, slot }) => {
        try {
            const reported = bot?.getEquipmentDestSlot?.(destination);
            if (Number.isInteger(reported)) return { destination, slot: reported };
        } catch {
            /* Version without this equipment destination. */
        }
        return { destination, slot };
    });
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {Set<number>}
 */
function armorAndOffhandSlots(bot) {
    const slots = new Set(ARMOR_AND_OFFHAND_SLOTS);
    for (const { slot } of equipmentDestinations(bot)) slots.add(slot);
    return slots;
}

/**
 * Classification inputs for a bot, honouring the caller's overrides.
 * @param {import('mineflayer').Bot} bot
 * @param {{ foodsByName?: object, bannedFood?: Iterable<string>, itemsByName?: object }} [options]
 * @returns {import('./itemClassify.js').ClassifyOptions}
 */
function classifyOptions(bot, options = {}) {
    return classifyOptionsFromBot(bot, {
        itemsByName: options.itemsByName,
        foodsByName: options.foodsByName,
        excludedFoods: options.bannedFood
    });
}

/**
 * Snapshot occupied inventory / equipment slots.
 * @param {import('mineflayer').Bot} bot
 * @returns {Array<{ slot: number, type: number, metadata: number|null, nbt: object|null, count: number, name: string, attackDamage: number }>}
 */
export function listOccupiedStacks(bot) {
    const slots = bot?.inventory?.slots || [];
    /** @type {Array<{ slot: number, type: number, metadata: number|null, nbt: object|null, count: number, name: string, attackDamage: number }>} */
    const stacks = [];
    for (const item of slots) {
        if (!item?.name) continue;
        stacks.push({
            slot: item.slot,
            type: item.type,
            metadata: item.metadata ?? null,
            nbt: item.nbt ?? null,
            count: item.count,
            name: item.name,
            attackDamage: item.attackDamage || 0
        });
    }
    return stacks;
}

/**
 * Resolve the slots that are genuinely equipped right now.
 *
 * A worn slot counts only while it holds something the companion keeps: a
 * bucket parked in the off-hand is surplus, and `listUnequipTargets` is what
 * gets it out. Inventory hotbar contents are not equipment either, unless the
 * selected item is gear.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ foodsByName?: object, bannedFood?: Iterable<string>, itemsByName?: object }} [options]
 * @returns {Set<number>}
 */
export function equippedItemSlots(bot, options = {}) {
    const classify = classifyOptions(bot, options);
    const slots = new Set();

    for (const slot of armorAndOffhandSlots(bot)) {
        const item = bot?.inventory?.slots?.[slot];
        if (!item?.name) continue;
        if (isRetainedCategory(classifyItemName(item.name, classify))) slots.add(slot);
    }

    const held = bot?.heldItem;
    if (held?.slot != null && isEquipmentCategory(classifyItemName(held.name, classify))) {
        slots.add(held.slot);
    }
    return slots;
}

/**
 * Armor and off-hand slots holding something the companion does not keep.
 *
 * No container window maps these slots, so `deposit` cannot reach them: an
 * item that ends up there stays in the companion's hands forever unless it is
 * unequipped back into the inventory proper first.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ foodsByName?: object, bannedFood?: Iterable<string>, itemsByName?: object }} [options]
 * @returns {Array<{ slot: number, destination: string, name: string }>}
 */
export function listUnequipTargets(bot, options = {}) {
    const classify = classifyOptions(bot, options);
    const targets = [];
    for (const { destination, slot } of equipmentDestinations(bot)) {
        const item = bot?.inventory?.slots?.[slot];
        if (!item?.name) continue;
        if (isRetainedCategory(classifyItemName(item.name, classify))) continue;
        targets.push({ slot, destination, name: item.name });
    }
    return targets;
}

/**
 * Retention policy over an explicit stack list. Nothing here reads the bot, so
 * the same rules can be applied to `bot.inventory` or to the live contents of
 * an open container window.
 *
 * @param {Array<{ slot: number, name: string, count: number, attackDamage?: number }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{
 *   equippedSlots?: Iterable<number>,
 *   itemsByName?: Record<string, { enchantCategories?: string[] }>,
 *   foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>,
 *   bannedFood?: Iterable<string>
 * }} [options]
 * @returns {Set<number>}
 */
export function retainedSlots(stacks, policy = {}, options = {}) {
    const equippedSlots = new Set(options.equippedSlots || []);
    const keepSlots = new Set(equippedSlots);
    const context = {
        itemsByName: options.itemsByName,
        foodsByName: options.foodsByName || {},
        excludedFoods: options.bannedFood instanceof Set
            ? options.bannedFood
            : new Set(options.bannedFood || UNSAFE_OR_SPECIAL_FOODS)
    };
    applyRetention(stacks, policy, context, equippedSlots, keepSlots);
    return keepSlots;
}

/**
 * Group the surplus into one deposit order per item type.
 *
 * `container.deposit` moves whichever same-type stack the window finds first,
 * so a per-slot plan cannot say *which* item leaves — only how many. Planning
 * by type keeps the amount exact, and the ranking above orders items by name
 * alone, which makes same-named items interchangeable. If ranking ever grows
 * enchantment awareness, the deposit mechanism has to be reworked too: a
 * per-slot move needs click-level window control instead of `deposit`.
 *
 * @param {Array<{ slot: number, type: number, name: string, count: number, attackDamage?: number }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{
 *   equippedSlots?: Iterable<number>,
 *   itemsByName?: Record<string, { enchantCategories?: string[] }>,
 *   foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>,
 *   bannedFood?: Iterable<string>,
 *   isDepositable?: (slot: number) => boolean
 * }} [options]
 * @returns {Array<{ type: number, name: string, count: number, slots: number[] }>}
 */
export function planDepositByType(stacks, policy = {}, options = {}) {
    const keepSlots = retainedSlots(stacks, policy, options);
    const isDepositable = typeof options.isDepositable === 'function'
        ? options.isDepositable
        : isPlayerInventorySlot;
    /** @type {Map<number, { type: number, name: string, count: number, slots: number[] }>} */
    const plan = new Map();
    for (const stack of stacks) {
        if (keepSlots.has(stack.slot)) continue;
        if (!isDepositable(stack.slot)) continue;
        const entry = plan.get(stack.type);
        if (entry) {
            entry.count += stack.count;
            entry.slots.push(stack.slot);
            continue;
        }
        plan.set(stack.type, {
            type: stack.type,
            name: stack.name,
            count: stack.count,
            slots: [stack.slot]
        });
    }
    return [...plan.values()];
}

/**
 * Armor and off-hand slots are never mapped into a container window, so a
 * deposit cannot reach them.
 * @param {number} slot
 */
export function isPlayerInventorySlot(slot) {
    return slot >= PLAYER_INVENTORY_SLOT_RANGE.start && slot < PLAYER_INVENTORY_SLOT_RANGE.end;
}

/**
 * Shared retention policy for chest deposits and ordinary surplus transfers.
 * @param {import('mineflayer').Bot} bot
 * @param {ReturnType<typeof listOccupiedStacks>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {{ foodsByName?: object, bannedFood?: string[] }} options
 */
function retainedItemSlots(bot, stacks, policy, options) {
    return retainedSlots(stacks, policy, {
        ...retentionOptionsFromBot(bot, options),
        equippedSlots: equippedItemSlots(bot, options)
    });
}

/**
 * Registry-backed classification inputs in the shape `retainedSlots` takes.
 * @param {import('mineflayer').Bot} bot
 * @param {{ foodsByName?: object, bannedFood?: Iterable<string>, itemsByName?: object }} [options]
 */
export function retentionOptionsFromBot(bot, options = {}) {
    const classify = classifyOptions(bot, options);
    return {
        itemsByName: classify.itemsByName,
        foodsByName: classify.foodsByName,
        bannedFood: options.bannedFood
    };
}

/**
 * Inventory stacks to put in an owner-placed handoff chest.
 *
 * Keep:
 * - configured total armor / shield / melee weapon counts, including equipped items
 * - configured food and torch stack counts
 * Everything else is deposited.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{ foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>, bannedFood?: string[] }} [options]
 */
export function listChestDepositStacks(bot, policy = {}, options = {}) {
    const stacks = listOccupiedStacks(bot);
    const keepSlots = retainedItemSlots(bot, stacks, policy, options);

    return stacks
        .filter((s) => !keepSlots.has(s.slot))
        .map(({ slot, type, metadata, nbt, count, name }) => ({
            slot,
            type,
            metadata,
            nbt,
            count,
            name
        }));
}

/**
 * Per-item-type deposit orders for an owner-placed handoff chest, read from
 * `bot.inventory`. Used before a container is open and as the fallback for
 * containers that do not expose their window slots.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{ foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>, bannedFood?: string[] }} [options]
 * @returns {ReturnType<typeof planDepositByType>}
 */
export function listChestDepositPlan(bot, policy = {}, options = {}) {
    return planDepositByType(listOccupiedStacks(bot), policy, {
        ...retentionOptionsFromBot(bot, options),
        equippedSlots: equippedItemSlots(bot, options)
    });
}

/**
 * Stacks the companion may give away (surplus beyond retention policy).
 * @param {import('mineflayer').Bot} bot
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{ foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>, bannedFood?: string[] }} [options]
 * @returns {Array<{ slot: number, type: number, count: number, name: string }>}
 */
export function listGiveableStacks(bot, policy = {}, options = {}) {
    const stacks = listOccupiedStacks(bot);
    const keepSlots = retainedItemSlots(bot, stacks, policy, options);

    return stacks
        .filter((s) => !keepSlots.has(s.slot))
        .map(({ slot, type, count, name }) => ({ slot, type, count, name }));
}

/**
 * How much of each retention category the companion currently holds against
 * its target. Equipment slots and inventory are read from the same slot list,
 * so a worn piece and a spare are each counted once; food and torches count
 * occupied stacks, so a partial stack still counts as one.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{ foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>, bannedFood?: string[] }} [options]
 * @returns {Array<{ id: string, current: number, target: number, missing: number }>}
 */
export function listRetentionStock(bot, policy = {}, options = {}) {
    const stacks = listOccupiedStacks(bot);
    const context = classifyOptions(bot, options);

    return RETENTION_CATEGORIES.map(({ id, limitKey, matches }) => {
        const current = stacks.filter((stack) => matches(stack, context)).length;
        const target = retentionLimit(policy, limitKey);
        return { id, current, target, missing: Math.max(0, target - current) };
    });
}
