/**
 * The retention policy: which items the companion keeps, and how many.
 *
 * One policy covers both of the things an owner wants to say:
 *
 * - "keep two melee weapons, whatever they are" — a category budget.
 * - "keep one iron sword and one golden sword" — per-item limits inside it.
 *
 * so the model is a budget per category plus an optional cap per item:
 *
 *     { weapon: { limit: 2, items: { iron_sword: 1, golden_sword: 1 } } }
 *
 * An item absent from `items` is kept, capped only by the category budget; an
 * item mapped to `0` is never kept. That default is what makes an untouched
 * `config.json` behave exactly as it did before this file existed: every
 * classifiable item eligible, two per category.
 *
 * Reading is deliberately forgiving — `config.json` is a file people edit by
 * hand, and a bad number there must not stop the companion from working.
 * Values are coerced and clamped here; the dashboard rejects them outright
 * before they can ever be written.
 */

import {
    EQUIPMENT_CATEGORY_IDS,
    LEGACY_RETENTION_LIMIT_KEY_BY_CATEGORY,
    RETAINED_CATEGORIES
} from './itemClassify.js';

/** Stacks kept per category before anyone configures anything. */
export const DEFAULT_CATEGORY_LIMIT = 2;

/** A player inventory holds 36 stacks; no limit can mean more than that. */
export const MAX_RETENTION_LIMIT = 36;

/**
 * Equipment categories keep at least one.
 *
 * At a limit of 1 the worn or wielded piece fills the budget on its own and no
 * spare is kept — which is the "carry nothing extra" people reach for when
 * they type 0. Zero itself is refused, because a category the companion is
 * told to keep none of is a category it would be asked to hand back while
 * wearing it.
 */
export const MIN_EQUIPMENT_CATEGORY_LIMIT = 1;

const EQUIPMENT_CATEGORY_SET = new Set(EQUIPMENT_CATEGORY_IDS);

/**
 * How large a number this category accepts, and what it holds without one.
 * The dashboard reads these off the catalog rather than repeating them.
 *
 * @param {string} category
 * @returns {{ min: number, max: number, default: number }}
 */
export function retentionCategoryBounds(category) {
    return {
        min: EQUIPMENT_CATEGORY_SET.has(category) ? MIN_EQUIPMENT_CATEGORY_LIMIT : 0,
        max: MAX_RETENTION_LIMIT,
        default: DEFAULT_CATEGORY_LIMIT
    };
}

/**
 * @param {unknown} value
 * @param {{ min: number, max: number }} bounds
 * @returns {number|null} null when the value says nothing usable
 */
function clampLimit(value, bounds) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(numeric)));
}

/**
 * The category limit an older `config.json` was asking for, or null.
 * @param {Record<string, unknown>} itemShare
 * @param {string} category
 */
function legacyCategoryLimit(itemShare, category) {
    const key = LEGACY_RETENTION_LIMIT_KEY_BY_CATEGORY[category];
    return key ? clampLimit(itemShare[key], retentionCategoryBounds(category)) : null;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, number>}
 */
function resolveItemLimits(raw) {
    if (!raw || typeof raw !== 'object') return {};
    /** @type {Record<string, number>} */
    const items = {};
    for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
        const limit = clampLimit(value, { min: 0, max: MAX_RETENTION_LIMIT });
        if (limit != null) items[name] = limit;
    }
    return items;
}

/**
 * @typedef {{ limit: number, items: Record<string, number> }} CategoryRetention
 * @typedef {Record<string, CategoryRetention>} RetentionPolicy
 */

/**
 * The effective policy behind an `item_share` config block.
 *
 * Accepts its own output, so applying a saved policy and re-reading it are the
 * same operation.
 *
 * @param {Record<string, unknown>|null|undefined} itemShare
 * @returns {RetentionPolicy}
 */
export function resolveRetentionPolicy(itemShare) {
    const config = itemShare && typeof itemShare === 'object' ? itemShare : {};
    const configured = config.retention && typeof config.retention === 'object'
        ? /** @type {Record<string, any>} */ (config.retention)
        : {};

    /** @type {RetentionPolicy} */
    const policy = {};
    for (const category of RETAINED_CATEGORIES) {
        const bounds = retentionCategoryBounds(category);
        const entry = configured[category];
        const declared = entry && typeof entry === 'object'
            ? clampLimit(entry.limit, bounds)
            : null;
        policy[category] = {
            limit: declared ?? legacyCategoryLimit(config, category) ?? bounds.default,
            items: resolveItemLimits(entry && typeof entry === 'object' ? entry.items : null)
        };
    }
    return policy;
}

/**
 * The policy an owner who has configured nothing is running.
 *
 * Frozen all the way down. It is handed out as a fallback from
 * `categoryRetention`, and a caller that wrote through that reference would be
 * editing the default every other caller reads. Use `defaultRetentionBlock()`
 * for a copy meant to be changed.
 */
export const DEFAULT_RETENTION_POLICY = Object.freeze(
    Object.fromEntries(
        Object.entries(resolveRetentionPolicy(null)).map(([category, entry]) => [
            category,
            Object.freeze({ limit: entry.limit, items: Object.freeze(entry.items) })
        ])
    )
);

/**
 * @param {RetentionPolicy} policy
 * @param {string} category
 * @returns {CategoryRetention}
 */
export function categoryRetention(policy, category) {
    return policy?.[category] || DEFAULT_RETENTION_POLICY[category] || { limit: 0, items: {} };
}

/**
 * How many of one item this category keeps: a number, or null for "as many as
 * the category budget allows".
 *
 * @param {CategoryRetention} entry
 * @param {string} name
 * @returns {number|null}
 */
export function itemRetentionLimit(entry, name) {
    const limit = entry?.items?.[name];
    return Number.isInteger(limit) ? limit : null;
}

/**
 * Whether this item is eligible to be kept at all.
 * @param {CategoryRetention} entry
 * @param {string} name
 */
export function isItemRetained(entry, name) {
    return itemRetentionLimit(entry, name) !== 0;
}

/**
 * A retention block holding nothing but the defaults, ready to be written to
 * `config.json` or handed to the dashboard as its "reset" state.
 * @returns {RetentionPolicy}
 */
export function defaultRetentionBlock() {
    return resolveRetentionPolicy(null);
}
