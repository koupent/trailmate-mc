import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_CATEGORY_LIMIT,
    DEFAULT_RETENTION_POLICY,
    MAX_RETENTION_LIMIT,
    MIN_EQUIPMENT_CATEGORY_LIMIT,
    categoryRetention,
    defaultRetentionBlock,
    isItemRetained,
    itemRetentionLimit,
    resolveRetentionPolicy,
    retentionCategoryBounds
} from '../src/companion/utils/retentionPolicy.js';
import { RETAINED_CATEGORIES } from '../src/companion/utils/itemClassify.js';

const EQUIPMENT = ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'weapon'];
const STACKED = ['food', 'torch'];

describe('retentionCategoryBounds', () => {
    it('refuses to let an equipment category keep nothing', () => {
        for (const category of EQUIPMENT) {
            assert.deepEqual(retentionCategoryBounds(category), {
                min: MIN_EQUIPMENT_CATEGORY_LIMIT,
                max: MAX_RETENTION_LIMIT,
                default: DEFAULT_CATEGORY_LIMIT
            }, category);
        }
    });

    it('lets a stacked category be turned off entirely', () => {
        for (const category of STACKED) {
            assert.equal(retentionCategoryBounds(category).min, 0, category);
        }
    });
});

describe('resolveRetentionPolicy', () => {
    it('gives an unconfigured install the behaviour it had before', () => {
        // Armor two per slot, shield two, melee two, food and torches two
        // stacks — the numbers the four old settings defaulted to.
        for (const category of RETAINED_CATEGORIES) {
            assert.deepEqual(
                categoryRetention(resolveRetentionPolicy(undefined), category),
                { limit: 2, items: {} },
                category
            );
        }
        assert.deepEqual(resolveRetentionPolicy(null), DEFAULT_RETENTION_POLICY);
        assert.deepEqual(resolveRetentionPolicy({}), DEFAULT_RETENTION_POLICY);
        assert.deepEqual(defaultRetentionBlock(), DEFAULT_RETENTION_POLICY);
    });

    it('names every category, even for a block that mentions one', () => {
        const policy = resolveRetentionPolicy({ retention: { weapon: { limit: 4 } } });
        assert.deepEqual(Object.keys(policy), [...RETAINED_CATEGORIES]);
        assert.equal(policy.weapon.limit, 4);
        assert.equal(policy.helmet.limit, DEFAULT_CATEGORY_LIMIT);
    });

    it('carries an older config over to the new shape', () => {
        const policy = resolveRetentionPolicy({
            keep_equipment_sets: 3,
            keep_weapon_stacks: 1,
            keep_food_stacks: 4,
            keep_torch_stacks: 0
        });
        // One old setting covered every armor slot and the shield.
        for (const category of ['helmet', 'chestplate', 'leggings', 'boots', 'shield']) {
            assert.equal(policy[category].limit, 3, category);
        }
        assert.equal(policy.weapon.limit, 1);
        assert.equal(policy.food.limit, 4);
        assert.equal(policy.torch.limit, 0);
    });

    it('prefers the new block wherever both are present', () => {
        const policy = resolveRetentionPolicy({
            keep_weapon_stacks: 1,
            keep_food_stacks: 1,
            retention: { weapon: { limit: 5, items: { iron_sword: 2 } } }
        });
        assert.equal(policy.weapon.limit, 5);
        // The legacy key still answers for a category the new block skips.
        assert.equal(policy.food.limit, 1);
    });

    it('re-reads its own output unchanged', () => {
        const once = resolveRetentionPolicy({
            retention: { weapon: { limit: 3, items: { iron_sword: 1, wooden_sword: 0 } } }
        });
        assert.deepEqual(resolveRetentionPolicy({ retention: once }), once);
    });

    it('clamps a hand-edited value instead of letting it stop the companion', () => {
        const policy = resolveRetentionPolicy({
            retention: {
                helmet: { limit: 0 },
                weapon: { limit: 999 },
                food: { limit: -4 },
                torch: { limit: 2.7, items: { torch: 3.9, lantern: -1, bogus: 'x' } }
            }
        });
        assert.equal(policy.helmet.limit, MIN_EQUIPMENT_CATEGORY_LIMIT, 'gear keeps at least one');
        assert.equal(policy.weapon.limit, MAX_RETENTION_LIMIT);
        assert.equal(policy.food.limit, 0);
        assert.equal(policy.torch.limit, 2);
        assert.deepEqual(policy.torch.items, { torch: 3, lantern: 0 });
    });

    it('survives a block of the wrong shape', () => {
        for (const broken of [{ retention: 'nope' }, { retention: [] }, { retention: { weapon: 3 } }]) {
            assert.deepEqual(resolveRetentionPolicy(broken), DEFAULT_RETENTION_POLICY, JSON.stringify(broken));
        }
    });
});

describe('per-item lookups', () => {
    const entry = categoryRetention(
        resolveRetentionPolicy({
            retention: { weapon: { limit: 2, items: { iron_sword: 1, wooden_sword: 0 } } }
        }),
        'weapon'
    );

    it('reads an explicit cap, and null for an item with none', () => {
        assert.equal(itemRetentionLimit(entry, 'iron_sword'), 1);
        assert.equal(itemRetentionLimit(entry, 'wooden_sword'), 0);
        assert.equal(itemRetentionLimit(entry, 'netherite_sword'), null);
    });

    it('treats zero, and only zero, as striking an item off the list', () => {
        assert.equal(isItemRetained(entry, 'iron_sword'), true);
        assert.equal(isItemRetained(entry, 'netherite_sword'), true);
        assert.equal(isItemRetained(entry, 'wooden_sword'), false);
    });
});

describe('the shared default', () => {
    it('cannot be edited through a config that fell back to it', () => {
        // Every config starts from this object. If a caller could write through
        // it, one companion's saved rules would become everyone's defaults.
        assert.throws(
            () => { DEFAULT_RETENTION_POLICY.weapon.limit = 9; },
            TypeError
        );
        assert.throws(
            () => { DEFAULT_RETENTION_POLICY.weapon.items.iron_sword = 1; },
            TypeError
        );
        assert.equal(DEFAULT_RETENTION_POLICY.weapon.limit, DEFAULT_CATEGORY_LIMIT);
    });

    it('hands out a fresh block to anyone who means to change one', () => {
        const mine = defaultRetentionBlock();
        mine.weapon.limit = 5;
        assert.equal(defaultRetentionBlock().weapon.limit, DEFAULT_CATEGORY_LIMIT);
        assert.equal(DEFAULT_RETENTION_POLICY.weapon.limit, DEFAULT_CATEGORY_LIMIT);
    });
});
