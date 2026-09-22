/**
 * What an item *is*, decided in one place.
 *
 * Everything that used to ask "does this name contain `axe`?" asks here
 * instead, and two properties fall out of that:
 *
 * - Classification is an allow-list. A name that matches nothing is `other`,
 *   and `other` is never retained, so a rule this table forgets surfaces as an
 *   item handed back to the owner — not as one the companion hoards forever.
 * - Name rules are anchored to suffixes (`_axe`, never `axe`), so `gold_ingot`
 *   and `chest` cannot masquerade as gear.
 *
 * The item registry is the better source when there is one, but several call
 * sites — and every retention test — run against bots without
 * `registry.itemsByName`. The name rules are therefore a first-class path and
 * not a degraded one: both must agree on every item the companion can hold.
 */

import { UNSAFE_OR_SPECIAL_FOODS } from '../../host/autoEat.js';

/**
 * @typedef {'helmet'|'chestplate'|'leggings'|'boots'|'shield'|'weapon'
 *   |'ranged_weapon'|'ammo'|'tool'|'food'|'torch'|'other'} ItemCategory
 */

/** Every category an item can land in. */
export const ITEM_CATEGORY = Object.freeze({
    helmet: /** @type {const} */ ('helmet'),
    chestplate: /** @type {const} */ ('chestplate'),
    leggings: /** @type {const} */ ('leggings'),
    boots: /** @type {const} */ ('boots'),
    shield: /** @type {const} */ ('shield'),
    /** Melee weapon — what the companion actually fights with. */
    weapon: /** @type {const} */ ('weapon'),
    rangedWeapon: /** @type {const} */ ('ranged_weapon'),
    ammo: /** @type {const} */ ('ammo'),
    tool: /** @type {const} */ ('tool'),
    food: /** @type {const} */ ('food'),
    torch: /** @type {const} */ ('torch'),
    other: /** @type {const} */ ('other')
});

/**
 * Categories the companion keeps, and the setting that says how many of each.
 *
 * This map *is* the retention allow-list: a category missing from it is never
 * kept, in any amount. The retention rule table is built from these entries in
 * this order, so the request order the owner hears and the keep decision
 * cannot drift apart.
 *
 * @type {Readonly<Record<string, 'keep_equipment_sets'|'keep_weapon_stacks'|'keep_food_stacks'|'keep_torch_stacks'>>}
 */
export const RETENTION_LIMIT_KEY_BY_CATEGORY = Object.freeze({
    [ITEM_CATEGORY.helmet]: 'keep_equipment_sets',
    [ITEM_CATEGORY.chestplate]: 'keep_equipment_sets',
    [ITEM_CATEGORY.leggings]: 'keep_equipment_sets',
    [ITEM_CATEGORY.boots]: 'keep_equipment_sets',
    [ITEM_CATEGORY.shield]: 'keep_equipment_sets',
    [ITEM_CATEGORY.weapon]: 'keep_weapon_stacks',
    [ITEM_CATEGORY.food]: 'keep_food_stacks',
    [ITEM_CATEGORY.torch]: 'keep_torch_stacks'
});

/** Categories that are worn or wielded: a held one counts as equipped. */
const EQUIPMENT_CATEGORIES = new Set([
    ITEM_CATEGORY.helmet,
    ITEM_CATEGORY.chestplate,
    ITEM_CATEGORY.leggings,
    ITEM_CATEGORY.boots,
    ITEM_CATEGORY.shield,
    ITEM_CATEGORY.weapon
]);

/** Categories whose leading material token ranks one item against another. */
const MATERIAL_TIERED_CATEGORIES = new Set([...EQUIPMENT_CATEGORIES, ITEM_CATEGORY.tool]);

/** Categories that count as "the companion is armed". */
const ARMED_CATEGORIES = new Set([ITEM_CATEGORY.weapon, ITEM_CATEGORY.rangedWeapon]);

/** Weapons plus the tools a player swings while working. */
const WORK_CATEGORIES = new Set([...ARMED_CATEGORIES, ITEM_CATEGORY.tool]);

/**
 * Names decided before anything else looks at them.
 * @type {ReadonlyMap<string, ItemCategory>}
 */
const EXACT_CATEGORY_OVERRIDES = new Map([
    // No registry category identifies a shield at all.
    ['shield', ITEM_CATEGORY.shield],
    // Torches carry no enchant categories, and `redstone_torch` must not join
    // them, so the two light sources are named outright.
    ['torch', ITEM_CATEGORY.torch],
    ['soul_torch', ITEM_CATEGORY.torch],
    // `trident` has only its own registry category and `mace` reads as a
    // weapon there; both are pinned so the two paths cannot drift.
    ['trident', ITEM_CATEGORY.weapon],
    ['mace', ITEM_CATEGORY.weapon],
    // Not armor. The registry gives elytra `equippable` but deliberately not
    // `armor`, and the companion cannot fly. Named explicitly because it used
    // to be classified as a chestplate and therefore kept forever.
    ['elytra', ITEM_CATEGORY.other],
    // Not a vanilla 1.21 item, but both weapon checks this module replaces
    // accepted it, and a modded spear is a melee weapon.
    ['spear', ITEM_CATEGORY.weapon]
]);

/**
 * Names with no usable registry category and no shared suffix.
 * @type {ReadonlyMap<string, ItemCategory>}
 */
const EXACT_NAME_CATEGORIES = new Map([
    ['bow', ITEM_CATEGORY.rangedWeapon],
    ['crossbow', ITEM_CATEGORY.rangedWeapon],
    ['arrow', ITEM_CATEGORY.ammo],
    ['spectral_arrow', ITEM_CATEGORY.ammo],
    ['tipped_arrow', ITEM_CATEGORY.ammo],
    ['shears', ITEM_CATEGORY.tool]
]);

/**
 * Suffix rules, in order. The anchor is what makes them safe: `_axe` cannot
 * match `gold_ingot`, and `_chestplate` cannot match `chest`.
 * @type {ReadonlyArray<readonly [string, ItemCategory]>}
 */
const NAME_SUFFIX_RULES = Object.freeze([
    ['_helmet', ITEM_CATEGORY.helmet],
    ['_chestplate', ITEM_CATEGORY.chestplate],
    ['_leggings', ITEM_CATEGORY.leggings],
    ['_boots', ITEM_CATEGORY.boots],
    // `_pickaxe` is listed before `_axe` on purpose: ordering is how a pickaxe
    // stays a tool, instead of an exclusion the next rule has to remember.
    ['_pickaxe', ITEM_CATEGORY.tool],
    ['_axe', ITEM_CATEGORY.weapon],
    ['_sword', ITEM_CATEGORY.weapon],
    ['_shovel', ITEM_CATEGORY.tool],
    ['_hoe', ITEM_CATEGORY.tool]
]);

/** Material tiers, keyed by the item name's leading token. */
const MATERIAL_SCORE = Object.freeze({
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
});

/** Foods the companion never counts as food, whatever the registry says. */
const DEFAULT_EXCLUDED_FOODS = new Set(UNSAFE_OR_SPECIAL_FOODS);

/**
 * @typedef {{
 *   itemsByName?: Record<string, { enchantCategories?: string[] }>,
 *   foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>,
 *   excludedFoods?: Iterable<string>
 * }} ClassifyOptions
 */

/**
 * @param {ClassifyOptions} options
 * @returns {Set<string>}
 */
function resolveExcludedFoods(options) {
    const excluded = options.excludedFoods;
    if (excluded == null) return DEFAULT_EXCLUDED_FOODS;
    return excluded instanceof Set ? excluded : new Set(excluded);
}

/**
 * @param {string} name
 * @param {ClassifyOptions['itemsByName']} itemsByName
 * @returns {(key: string) => boolean}
 */
function enchantCategoryReader(name, itemsByName) {
    const categories = itemsByName?.[name]?.enchantCategories;
    if (!Array.isArray(categories) || categories.length === 0) return () => false;
    return (key) => categories.includes(key);
}

/**
 * The armor slot the registry states outright, or null.
 *
 * minecraft-data renamed these tags between 1.20 (`armor_head`) and 1.21
 * (`head_armor`), and the bot's target version is configurable, so both
 * spellings are read. Every generation is also missing at least one slot —
 * 1.18 has no leggings tag, 1.21 ships `chest_armor` with no members — which
 * is why the name rules run before the coarse `armor` bucket below.
 *
 * @param {(key: string) => boolean} has
 * @returns {ItemCategory|null}
 */
function armorSlotFromRegistry(has) {
    if (has('head_armor') || has('armor_head')) return ITEM_CATEGORY.helmet;
    if (has('leg_armor') || has('armor_legs')) return ITEM_CATEGORY.leggings;
    if (has('foot_armor') || has('armor_feet')) return ITEM_CATEGORY.boots;
    if (has('armor_chest')) return ITEM_CATEGORY.chestplate;
    return null;
}

/**
 * The registry's coarse buckets, for names the suffix rules do not know.
 *
 * These have moved between data versions — an axe carries `weapon` in 1.21 but
 * only `digger` in 1.20 — so they answer last, after a vanilla name has had
 * its say. `armor` without a slot tag can only mean the chestplate that 1.21
 * left untagged.
 *
 * @param {(key: string) => boolean} has
 * @returns {ItemCategory|null}
 */
function categoryFromRegistryBuckets(has) {
    if (has('weapon') || has('sword') || has('sharp_weapon') || has('trident')) {
        return ITEM_CATEGORY.weapon;
    }
    if (has('bow') || has('crossbow')) return ITEM_CATEGORY.rangedWeapon;
    // `digger` is the 1.20 spelling of `mining`.
    if (has('mining') || has('digger')) return ITEM_CATEGORY.tool;
    if (has('armor')) return ITEM_CATEGORY.chestplate;
    return null;
}

/**
 * Category from the item name alone, or null when no rule matches.
 * @param {string} name
 * @returns {ItemCategory|null}
 */
function categoryFromName(name) {
    const exact = EXACT_NAME_CATEGORIES.get(name);
    if (exact) return exact;
    for (const [suffix, category] of NAME_SUFFIX_RULES) {
        if (name.endsWith(suffix)) return category;
    }
    return null;
}

/**
 * The single classification entry point.
 *
 * Order: exact overrides, the armor slot the registry states outright, food,
 * the anchored name rules, the registry's coarse buckets, then `other`. The
 * name rules sit ahead of those buckets because a vanilla name is the one
 * signal that has not moved between data versions.
 *
 * An excluded food is never food: the caller's exclusion list is a decision
 * about that item, so it outranks the food category.
 *
 * @param {string|null|undefined} name
 * @param {ClassifyOptions} [options]
 * @returns {ItemCategory}
 */
export function classifyItemName(name, options = {}) {
    const itemName = String(name || '');
    if (!itemName) return ITEM_CATEGORY.other;

    const override = EXACT_CATEGORY_OVERRIDES.get(itemName);
    if (override) return override;

    const has = enchantCategoryReader(itemName, options.itemsByName);
    const armorSlot = armorSlotFromRegistry(has);
    if (armorSlot) return armorSlot;

    if (options.foodsByName?.[itemName] && !resolveExcludedFoods(options).has(itemName)) {
        return ITEM_CATEGORY.food;
    }

    return categoryFromName(itemName)
        ?? categoryFromRegistryBuckets(has)
        ?? ITEM_CATEGORY.other;
}

/**
 * Classification inputs read off a live bot, with per-call overrides.
 * @param {import('mineflayer').Bot|null|undefined} bot
 * @param {ClassifyOptions} [overrides]
 * @returns {ClassifyOptions}
 */
export function classifyOptionsFromBot(bot, overrides = {}) {
    return {
        itemsByName: overrides.itemsByName || bot?.registry?.itemsByName,
        foodsByName: overrides.foodsByName || bot?.registry?.foodsByName || {},
        excludedFoods: overrides.excludedFoods
    };
}

/**
 * How good an item is within its category, from the material it is made of.
 *
 * Only the leading token counts. The old substring check scored `gold_ingot`
 * as gold gear and `stone` as a stone tier; anything outside a material-tiered
 * category now scores zero instead.
 *
 * @param {string|null|undefined} name
 * @param {ItemCategory} category
 * @returns {number}
 */
export function materialScore(name, category) {
    if (!MATERIAL_TIERED_CATEGORIES.has(category)) return 0;
    const itemName = String(name || '');
    const separator = itemName.indexOf('_');
    const material = separator === -1 ? itemName : itemName.slice(0, separator);
    return MATERIAL_SCORE[/** @type {keyof typeof MATERIAL_SCORE} */ (material)] || 0;
}

/**
 * Whether the companion keeps items of this category at all.
 * @param {ItemCategory|null|undefined} category
 */
export function isRetainedCategory(category) {
    return category != null
        && Object.prototype.hasOwnProperty.call(RETENTION_LIMIT_KEY_BY_CATEGORY, category);
}

/**
 * Whether items of this category are worn or wielded rather than stacked.
 * @param {ItemCategory|null|undefined} category
 */
export function isEquipmentCategory(category) {
    return category != null && EQUIPMENT_CATEGORIES.has(category);
}

/**
 * Torch and soul torch — the two light sources the companion places.
 * Neither needs a registry, so this takes no options.
 * @param {string|null|undefined} name
 */
export function isTorchItemName(name) {
    return classifyItemName(name) === ITEM_CATEGORY.torch;
}

/**
 * Whether holding this item counts as being armed. Ranged weapons count:
 * a bow in the inventory means gear recovery is not the priority.
 * @param {string|null|undefined} name
 * @param {ClassifyOptions} [options]
 */
export function isCombatWeaponName(name, options = {}) {
    return ARMED_CATEGORIES.has(classifyItemName(name, options));
}

/**
 * Weapons plus the tools used for mining, digging, harvesting, or shearing.
 * @param {string|null|undefined} name
 * @param {ClassifyOptions} [options]
 */
export function isWorkItemCategoryName(name, options = {}) {
    return WORK_CATEGORIES.has(classifyItemName(name, options));
}
