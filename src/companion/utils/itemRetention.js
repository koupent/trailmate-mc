/**
 * Decide which inventory stacks the companion should keep vs give away.
 * Retention rules live here so future keep-categories can extend one place.
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';

export const DEFAULT_RETENTION = {
    keep_torch_stacks: 2,
    keep_food_stacks: 2,
    keep_equipment_sets: 2,
    keep_weapon_stacks: 2
};

const TIER_SCORE = {
    wood: 1,
    wooden: 1,
    leather: 1,
    gold: 2,
    golden: 2,
    stone: 3,
    chainmail: 3,
    iron: 4,
    diamond: 5,
    netherite: 6
};

/** Prefer attackDamage over material tier when ranking weapons. */
const WEAPON_DAMAGE_WEIGHT = 10;

/** Equipment categories in request order, each with its retention limit. */
const EQUIPMENT_RETENTION_RULES = Object.freeze([
    { id: 'helmet', limitKey: 'keep_equipment_sets' },
    { id: 'chestplate', limitKey: 'keep_equipment_sets' },
    { id: 'leggings', limitKey: 'keep_equipment_sets' },
    { id: 'boots', limitKey: 'keep_equipment_sets' },
    { id: 'shield', limitKey: 'keep_equipment_sets' },
    { id: 'weapon', limitKey: 'keep_weapon_stacks' }
]);

/**
 * @param {string} name
 * @returns {number}
 */
export function tierOf(name) {
    const n = String(name || '');
    for (const [key, score] of Object.entries(TIER_SCORE)) {
        if (n.includes(key)) return score;
    }
    return 0;
}

/**
 * @param {string} name
 */
export function isTorch(name) {
    return name === 'torch' || name === 'soul_torch';
}

/**
 * @param {string} name
 * @param {Record<string, { foodPoints?: number, saturation?: number }>} foodsByName
 * @param {Set<string>} bannedFood
 */
export function isKeepableFood(name, foodsByName, bannedFood) {
    if (!name || bannedFood.has(name)) return false;
    return Boolean(foodsByName?.[name]);
}

/**
 * Equipment slot group for retention (null = not equipment).
 * @param {string} name
 * @returns {'helmet'|'chestplate'|'leggings'|'boots'|'shield'|'weapon'|null}
 */
export function equipmentGroup(name) {
    const n = String(name || '');
    if (n === 'shield') return 'shield';
    if (n.includes('helmet')) return 'helmet';
    if (n.includes('chestplate') || n.includes('tunic') || n === 'elytra') return 'chestplate';
    if (n.includes('leggings') || n.includes('pants')) return 'leggings';
    if (n.includes('boots')) return 'boots';
    if (n.includes('sword')) return 'weapon';
    if (n.includes('axe') && !n.includes('pickaxe')) return 'weapon';
    if (n === 'trident' || n === 'mace') return 'weapon';
    return null;
}

/**
 * @param {{ name: string, attackDamage?: number }} item
 */
export function equipmentScore(item) {
    if (equipmentGroup(item.name) === 'weapon') {
        return (item.attackDamage || 0) * WEAPON_DAMAGE_WEIGHT + tierOf(item.name);
    }
    return tierOf(item.name);
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

const COMMON_STACK_RETENTION_RULES = Object.freeze([
    {
        id: 'food',
        limitKey: 'keep_food_stacks',
        matches: (stack, context) => isKeepableFood(
            stack.name,
            context.foodsByName,
            context.bannedFood
        ),
        compare: (a, b, context) => compareFoodDesc(a, b, context.foodsByName)
    },
    {
        id: 'torch',
        limitKey: 'keep_torch_stacks',
        matches: (stack) => isTorch(stack.name),
        compare: (a, b) => b.count - a.count
    }
]);

/**
 * Every retention category in a fixed request order, with the setting that
 * defines its target count. Keep decisions and shortage requests share this
 * list so neither can drift from the other.
 * @type {ReadonlyArray<{
 *   id: string,
 *   limitKey: keyof typeof DEFAULT_RETENTION,
 *   matches: (stack: any, context: any) => boolean
 * }>}
 */
export const RETENTION_CATEGORIES = Object.freeze([
    ...EQUIPMENT_RETENTION_RULES.map((rule) => Object.freeze({
        id: rule.id,
        limitKey: rule.limitKey,
        matches: (stack) => equipmentGroup(stack.name) === rule.id
    })),
    ...COMMON_STACK_RETENTION_RULES.map((rule) => Object.freeze({
        id: rule.id,
        limitKey: rule.limitKey,
        matches: rule.matches
    }))
]);

/**
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {keyof typeof DEFAULT_RETENTION} key
 */
function retentionLimit(policy, key) {
    const configured = policy[key] ?? DEFAULT_RETENTION[key] ?? 0;
    return Math.max(0, Math.trunc(Number(configured) || 0));
}

/**
 * @param {Array<{ slot: number }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {{ foodsByName: object, bannedFood: Set<string>, keepSlots: Set<number> }} context
 * @param {ReadonlyArray<{
 *   limitKey: keyof typeof DEFAULT_RETENTION,
 *   matches: (stack: any, context: any) => boolean,
 *   compare: (a: any, b: any, context: any) => number
 * }>} rules
 */
function applyRetentionRules(stacks, policy, context, rules) {
    for (const rule of rules) {
        const keepCount = retentionLimit(policy, rule.limitKey);
        keepTopStacks(
            stacks.filter((stack) => rule.matches(stack, context)),
            keepCount,
            (a, b) => rule.compare(a, b, context),
            context.keepSlots
        );
    }
}

/**
 * Keep equipped items plus the best spares up to each category's total limit.
 * @param {Array<{ slot: number, name: string }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {Set<number>} equippedSlots
 * @param {Set<number>} keepSlots
 */
function applyEquipmentRetention(stacks, policy, equippedSlots, keepSlots) {
    for (const { id: group, limitKey } of EQUIPMENT_RETENTION_RULES) {
        const groupStacks = stacks.filter((stack) => equipmentGroup(stack.name) === group);
        const equippedCount = groupStacks.filter((stack) => equippedSlots.has(stack.slot)).length;
        const spareCount = Math.max(0, retentionLimit(policy, limitKey) - equippedCount);
        keepTopStacks(
            groupStacks.filter((stack) => !equippedSlots.has(stack.slot)),
            spareCount,
            (a, b) => equipmentScore(b) - equipmentScore(a),
            keepSlots
        );
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ foodsByName?: object, bannedFood?: string[] }} options
 * @param {Set<number>} keepSlots
 */
function createRetentionContext(bot, options, keepSlots = new Set()) {
    return {
        foodsByName: options.foodsByName || bot?.registry?.foodsByName || {},
        bannedFood: new Set(options.bannedFood || UNSAFE_OR_SPECIAL_FOODS),
        keepSlots
    };
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
 * Resolve the slots that are genuinely equipped right now. Inventory hotbar
 * contents are not equipment unless the selected item is a weapon.
 * @param {import('mineflayer').Bot} bot
 * @returns {Set<number>}
 */
export function equippedItemSlots(bot) {
    const slots = new Set();
    for (const destination of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
        try {
            const slot = bot?.getEquipmentDestSlot?.(destination);
            if (Number.isInteger(slot) && bot?.inventory?.slots?.[slot]) slots.add(slot);
        } catch {
            /* Version without this equipment destination. */
        }
    }

    // Mineflayer's stable player-inventory layout. This also makes the policy
    // usable in deterministic tests whose Bot stub does not expose the helper.
    for (const slot of [5, 6, 7, 8, 45]) {
        if (bot?.inventory?.slots?.[slot]) slots.add(slot);
    }

    const held = bot?.heldItem;
    if (held?.slot != null && equipmentGroup(held.name)) slots.add(held.slot);
    return slots;
}

/**
 * Shared retention policy for chest deposits and ordinary surplus transfers.
 * @param {import('mineflayer').Bot} bot
 * @param {ReturnType<typeof listOccupiedStacks>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {{ foodsByName?: object, bannedFood?: string[] }} options
 */
function retainedItemSlots(bot, stacks, policy, options) {
    const equippedSlots = equippedItemSlots(bot);
    const keepSlots = new Set(equippedSlots);
    const context = createRetentionContext(bot, options, keepSlots);
    applyRetentionRules(stacks, policy, context, COMMON_STACK_RETENTION_RULES);
    applyEquipmentRetention(stacks, policy, equippedSlots, keepSlots);
    return keepSlots;
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
    const context = createRetentionContext(bot, options);

    return RETENTION_CATEGORIES.map(({ id, limitKey, matches }) => {
        const current = stacks.filter((stack) => matches(stack, context)).length;
        const target = retentionLimit(policy, limitKey);
        return { id, current, target, missing: Math.max(0, target - current) };
    });
}
