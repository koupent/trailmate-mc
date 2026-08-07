/**
 * Decide which inventory stacks the companion should keep vs give away.
 * Retention rules live here so future keep-categories can extend one place.
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';

export const DEFAULT_RETENTION = {
    keep_torch_stacks: 3,
    keep_food_stacks: 3,
    keep_equipment_sets: 3,
    keep_weapon_stacks: 3
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

const EQUIPMENT_GROUPS = [
    'helmet',
    'chestplate',
    'leggings',
    'boots',
    'shield',
    'weapon'
];

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

/**
 * Chest retention is intentionally data-driven. Adding or removing a retained
 * inventory category should only require editing this list and its config key.
 */
export const CHEST_RETENTION_RULES = Object.freeze([
    {
        id: 'torch',
        limitKey: 'keep_torch_stacks',
        matches: (stack) => isTorch(stack.name),
        compare: (a, b) => b.count - a.count
    },
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
        id: 'melee_weapon',
        limitKey: 'keep_weapon_stacks',
        matches: (stack, context) => (
            equipmentGroup(stack.name) === 'weapon'
            && !context.keepSlots.has(stack.slot)
        ),
        compare: (a, b) => equipmentScore(b) - equipmentScore(a)
    }
]);

/**
 * @param {Array<{ slot: number }>} stacks
 * @param {Partial<typeof DEFAULT_RETENTION>} policy
 * @param {{ foodsByName: object, bannedFood: Set<string>, keepSlots: Set<number> }} context
 * @param {ReadonlyArray<{ limitKey: keyof typeof DEFAULT_RETENTION, matches: Function, compare: Function }>} rules
 */
function applyRetentionRules(stacks, policy, context, rules) {
    for (const rule of rules) {
        const keepCount = policy[rule.limitKey] ?? DEFAULT_RETENTION[rule.limitKey] ?? 0;
        keepTopStacks(
            stacks.filter((stack) => rule.matches(stack, context)),
            Math.max(0, keepCount),
            (a, b) => rule.compare(a, b, context),
            context.keepSlots
        );
    }
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
 * Inventory stacks to put in an owner-placed handoff chest.
 *
 * Keep:
 * - currently equipped armor / shield / weapon
 * - configured spare melee weapon, food, and torch stacks
 * Everything else is deposited.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Partial<typeof DEFAULT_RETENTION>} [policy]
 * @param {{ foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>, bannedFood?: string[] }} [options]
 */
export function listChestDepositStacks(bot, policy = {}, options = {}) {
    const foodsByName = options.foodsByName || bot?.registry?.foodsByName || {};
    const bannedFood = new Set(options.bannedFood || UNSAFE_OR_SPECIAL_FOODS);
    const stacks = listOccupiedStacks(bot);
    const keepSlots = equippedItemSlots(bot);
    applyRetentionRules(stacks, policy, {
        foodsByName,
        bannedFood,
        keepSlots
    }, CHEST_RETENTION_RULES);

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
    const keepTorch = policy.keep_torch_stacks ?? DEFAULT_RETENTION.keep_torch_stacks;
    const keepFood = policy.keep_food_stacks ?? DEFAULT_RETENTION.keep_food_stacks;
    const keepEquip = policy.keep_equipment_sets ?? DEFAULT_RETENTION.keep_equipment_sets;

    const foodsByName = options.foodsByName || bot?.registry?.foodsByName || {};
    const bannedFood = new Set(options.bannedFood || UNSAFE_OR_SPECIAL_FOODS);

    const stacks = listOccupiedStacks(bot);
    /** @type {Set<number>} */
    const keepSlots = new Set();

    keepTopStacks(
        stacks.filter((s) => isTorch(s.name)),
        keepTorch,
        (a, b) => b.count - a.count,
        keepSlots
    );
    keepTopStacks(
        stacks.filter((s) => isKeepableFood(s.name, foodsByName, bannedFood)),
        keepFood,
        (a, b) => compareFoodDesc(a, b, foodsByName),
        keepSlots
    );

    /** @type {Record<string, typeof stacks>} */
    const byGroup = Object.fromEntries(EQUIPMENT_GROUPS.map((group) => [group, []]));
    for (const stack of stacks) {
        const group = equipmentGroup(stack.name);
        if (group) byGroup[group].push(stack);
    }
    for (const group of EQUIPMENT_GROUPS) {
        keepTopStacks(
            byGroup[group],
            keepEquip,
            (a, b) => equipmentScore(b) - equipmentScore(a),
            keepSlots
        );
    }

    return stacks
        .filter((s) => !keepSlots.has(s.slot))
        .map(({ slot, type, count, name }) => ({ slot, type, count, name }));
}
