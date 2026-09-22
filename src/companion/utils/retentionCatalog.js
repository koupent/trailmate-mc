/**
 * The items the dashboard offers as retention candidates.
 *
 * Minecraft ships 1415 items. A picker listing all of them is not a picker, so
 * the catalog is every item the companion's own classifier already recognises
 * — armor, shield, melee weapons, light sources, cooked food — and nothing
 * else. That is roughly seventy entries.
 *
 * Deriving it from `classifyItemName` rather than from a hand-written list is
 * the point: the catalog and the keep decision read the same rules, so an item
 * can never be offered in the UI and then ignored at the chest, or kept by the
 * companion without ever appearing on screen.
 *
 * Nothing here reads a bot, a file or a locale. The caller supplies the
 * registry and the two label functions, which is what lets the control server
 * build the catalog from `minecraft-data` before anything has spawned.
 */

import {
    classifyItemName,
    isRetainedCategory,
    ITEM_CATEGORY,
    isTorchItemName,
    materialScore,
    RETAINED_CATEGORIES
} from './itemClassify.js';
import { retentionCategoryBounds } from './retentionPolicy.js';

/**
 * @typedef {{
 *   itemsArray?: Array<{ name?: string }>,
 *   itemsByName?: Record<string, { enchantCategories?: string[] }>,
 *   foodsByName?: Record<string, { foodPoints?: number, saturation?: number }>
 * }} CatalogRegistry
 *
 * @typedef {{ name: string, label: string, foodPoints?: number }} CatalogItem
 * @typedef {{
 *   id: string,
 *   label: string,
 *   equipment: boolean,
 *   limit: { min: number, max: number, default: number },
 *   items: CatalogItem[]
 * }} CatalogCategory
 * @typedef {{ version: string|null, categories: CatalogCategory[] }} RetentionCatalog
 */

/**
 * Within a category, the entry an owner is most likely to want kept comes
 * first: better material, then more filling food, then placeable torches ahead
 * of lanterns. Ties fall back to the name so the list never reorders itself
 * between two reads of the same registry.
 *
 * @param {string} category
 * @param {Record<string, { foodPoints?: number }>} foodsByName
 * @returns {(a: CatalogItem, b: CatalogItem) => number}
 */
function catalogOrder(category, foodsByName) {
    if (category === ITEM_CATEGORY.food) {
        return (a, b) => (
            (foodsByName[b.name]?.foodPoints || 0) - (foodsByName[a.name]?.foodPoints || 0)
            || a.name.localeCompare(b.name)
        );
    }
    if (category === ITEM_CATEGORY.torch) {
        return (a, b) => (
            Number(isTorchItemName(b.name)) - Number(isTorchItemName(a.name))
            || a.name.localeCompare(b.name)
        );
    }
    return (a, b) => (
        materialScore(b.name, category) - materialScore(a.name, category)
        || a.name.localeCompare(b.name)
    );
}

/**
 * Build the candidate catalog for one registry.
 *
 * @param {CatalogRegistry|null|undefined} registry
 * @param {{
 *   version?: string|null,
 *   itemLabel?: (name: string) => string,
 *   categoryLabel?: (id: string) => string
 * }} [options]
 * @returns {RetentionCatalog}
 */
export function buildRetentionCatalog(registry, options = {}) {
    const itemLabel = options.itemLabel || ((name) => name);
    const categoryLabel = options.categoryLabel || ((id) => id);
    const foodsByName = registry?.foodsByName || {};
    const classify = {
        itemsByName: registry?.itemsByName,
        foodsByName
    };

    /** @type {Map<string, CatalogItem[]>} */
    const byCategory = new Map(RETAINED_CATEGORIES.map((id) => [id, []]));
    const seen = new Set();

    for (const item of registry?.itemsArray || []) {
        const name = String(item?.name || '');
        if (!name || seen.has(name)) continue;
        const category = classifyItemName(name, classify);
        if (!isRetainedCategory(category)) continue;
        seen.add(name);
        /** @type {CatalogItem} */
        const entry = { name, label: itemLabel(name) };
        if (category === ITEM_CATEGORY.food) {
            entry.foodPoints = Number(foodsByName[name]?.foodPoints) || 0;
        }
        byCategory.get(category)?.push(entry);
    }

    return {
        version: options.version ?? null,
        categories: RETAINED_CATEGORIES.map((id) => {
            const bounds = retentionCategoryBounds(id);
            return {
                id,
                label: categoryLabel(id),
                equipment: bounds.min > 0,
                limit: bounds,
                items: (byCategory.get(id) || []).sort(catalogOrder(id, foodsByName))
            };
        })
    };
}

/**
 * Item names by category, as a lookup. The dashboard validates a submitted
 * policy against this so a typo cannot be persisted as a rule that matches
 * nothing.
 *
 * @param {RetentionCatalog} catalog
 * @returns {Map<string, Set<string>>}
 */
export function catalogItemsByCategory(catalog) {
    return new Map(
        (catalog?.categories || []).map((category) => [
            category.id,
            new Set(category.items.map((item) => item.name))
        ])
    );
}
