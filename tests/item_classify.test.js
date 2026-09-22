import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import {
    classifyItemName,
    isCombatWeaponName,
    isEquipmentCategory,
    isRetainedCategory,
    isTorchItemName,
    isWorkItemCategoryName,
    ITEM_CATEGORY,
    materialScore,
    RETAINED_CATEGORIES
} from '../src/companion/utils/itemClassify.js';

/** The version the companion is configured for by default. */
const REGISTRY = minecraftData('1.21.6');

/** Every Minecraft generation mineflayer can still talk to today. */
const SUPPORTED_VERSIONS = ['1.18.2', '1.19.4', '1.20.4', '1.20.6', '1.21', '1.21.6'];

const FOODS_BY_NAME = {
    bread: { foodPoints: 5, saturation: 6 },
    golden_apple: { foodPoints: 4, saturation: 9.6 }
};

/** Classification with the item registry behind it. */
function withRegistry(name, overrides = {}) {
    return classifyItemName(name, {
        itemsByName: REGISTRY.itemsByName,
        foodsByName: REGISTRY.foodsByName,
        ...overrides
    });
}

/** Classification with nothing but the name rules. */
function withoutRegistry(name, overrides = {}) {
    return classifyItemName(name, { foodsByName: REGISTRY.foodsByName, ...overrides });
}

describe('classifyItemName', () => {
    it('places every armor piece in its own slot', () => {
        for (const material of ['leather', 'chainmail', 'iron', 'diamond', 'golden', 'netherite']) {
            assert.equal(withRegistry(`${material}_helmet`), ITEM_CATEGORY.helmet);
            assert.equal(withRegistry(`${material}_chestplate`), ITEM_CATEGORY.chestplate);
            assert.equal(withRegistry(`${material}_leggings`), ITEM_CATEGORY.leggings);
            assert.equal(withRegistry(`${material}_boots`), ITEM_CATEGORY.boots);
        }
        assert.equal(withRegistry('turtle_helmet'), ITEM_CATEGORY.helmet);
    });

    it('separates melee weapons, ranged weapons, ammunition, and tools', () => {
        for (const name of ['diamond_sword', 'netherite_axe', 'trident', 'mace', 'spear']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.weapon, name);
        }
        for (const name of ['bow', 'crossbow']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.rangedWeapon, name);
        }
        for (const name of ['arrow', 'spectral_arrow', 'tipped_arrow']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.ammo, name);
        }
        for (const name of ['iron_pickaxe', 'stone_shovel', 'wooden_hoe', 'shears']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.tool, name);
        }
        assert.equal(withRegistry('shield'), ITEM_CATEGORY.shield);
    });

    it('anchors name rules to suffixes so ordinary items cannot look like gear', () => {
        // Each of these contains a gear word the old substring checks matched.
        for (const name of [
            'gold_ingot',
            'chest',
            'trapped_chest',
            'bucket',
            'redstone',
            'redstone_torch',
            'wolf_armor',
            'leather_horse_armor',
            'carved_pumpkin',
            'cobblestone',
            'stone',
            'bow_and_nothing'
        ]) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.other, name);
            assert.equal(withoutRegistry(name), ITEM_CATEGORY.other, `${name} (no registry)`);
        }
    });

    it('does not treat an elytra as a chestplate', () => {
        // The registry gives it `equippable` but deliberately not `armor`.
        assert.equal(withRegistry('elytra'), ITEM_CATEGORY.other);
        assert.equal(withoutRegistry('elytra'), ITEM_CATEGORY.other);
    });

    it('keeps a pickaxe a tool and an axe a weapon', () => {
        assert.equal(withRegistry('iron_pickaxe'), ITEM_CATEGORY.tool);
        assert.equal(withRegistry('iron_axe'), ITEM_CATEGORY.weapon);
        assert.equal(withoutRegistry('iron_pickaxe'), ITEM_CATEGORY.tool);
        assert.equal(withoutRegistry('iron_axe'), ITEM_CATEGORY.weapon);
    });

    it('classifies only the two torches the companion places', () => {
        assert.equal(isTorchItemName('torch'), true);
        assert.equal(isTorchItemName('soul_torch'), true);
        assert.equal(isTorchItemName('redstone_torch'), false);
        assert.equal(isTorchItemName('wall_torch'), false);
        assert.equal(isTorchItemName(null), false);
        // Kept with the torches, but never reached for to light a dark spot.
        assert.equal(isTorchItemName('lantern'), false);
        assert.equal(isTorchItemName('soul_lantern'), false);
    });

    it('keeps the lanterns in the torch category without making them placeable', () => {
        for (const name of ['torch', 'soul_torch', 'lantern', 'soul_lantern']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.torch, name);
            assert.equal(withoutRegistry(name), ITEM_CATEGORY.torch, `${name} (no registry)`);
        }
        assert.equal(withRegistry('redstone_torch'), ITEM_CATEGORY.other);
    });

    it('reads food from the registry', () => {
        assert.equal(withRegistry('bread'), ITEM_CATEGORY.food);
        assert.equal(withRegistry('cooked_beef'), ITEM_CATEGORY.food);
        // Excluded by default because the companion must not eat it.
        assert.equal(withRegistry('rotten_flesh'), ITEM_CATEGORY.other);
    });

    it('does not count a raw ingredient as food', () => {
        // Worth a furnace trip, not a kept inventory slot.
        for (const name of ['beef', 'porkchop', 'mutton', 'rabbit', 'cod', 'salmon']) {
            assert.equal(withRegistry(name), ITEM_CATEGORY.other, name);
            assert.equal(withRegistry(`cooked_${name}`), ITEM_CATEGORY.food, `cooked_${name}`);
        }
        // Cooked forms the `cooked_` prefix does not name, plus the raw fish
        // vanilla never lets you cook at all.
        assert.equal(withRegistry('potato'), ITEM_CATEGORY.other);
        assert.equal(withRegistry('baked_potato'), ITEM_CATEGORY.food);
        assert.equal(withRegistry('tropical_fish'), ITEM_CATEGORY.other);
        // Raw is a property of the item, so an empty exclusion list cannot
        // turn it back into food the way it can for a golden apple.
        assert.equal(
            classifyItemName('beef', {
                itemsByName: REGISTRY.itemsByName,
                foodsByName: REGISTRY.foodsByName,
                excludedFoods: []
            }),
            ITEM_CATEGORY.other
        );
    });

    it('lets an explicit exclusion list outrank the food category', () => {
        assert.equal(
            classifyItemName('golden_apple', { foodsByName: FOODS_BY_NAME, excludedFoods: [] }),
            ITEM_CATEGORY.food,
            'the registry alone would call it food'
        );
        assert.equal(
            classifyItemName('golden_apple', {
                foodsByName: FOODS_BY_NAME,
                excludedFoods: ['golden_apple']
            }),
            ITEM_CATEGORY.other,
            'an excluded food is never food'
        );
        // The default exclusion list is the one the companion eats by.
        assert.equal(
            classifyItemName('golden_apple', { foodsByName: FOODS_BY_NAME }),
            ITEM_CATEGORY.other
        );
        assert.equal(
            classifyItemName('bread', { foodsByName: FOODS_BY_NAME }),
            ITEM_CATEGORY.food
        );
    });

    it('falls back to other for anything no rule claims', () => {
        assert.equal(withRegistry('cobblestone'), ITEM_CATEGORY.other);
        assert.equal(classifyItemName(''), ITEM_CATEGORY.other);
        assert.equal(classifyItemName(null), ITEM_CATEGORY.other);
        assert.equal(classifyItemName(undefined), ITEM_CATEGORY.other);
    });

    it('agrees with itself with and without the item registry', () => {
        // The retention tests and several call sites run against bots that have
        // no `registry.itemsByName`, so the name rules are a normal path and
        // not a degraded one. Every item of every supported version has to land
        // in the same category either way.
        for (const version of SUPPORTED_VERSIONS) {
            const registry = minecraftData(version);
            const mismatches = [];
            for (const name of Object.keys(registry.itemsByName)) {
                const registryPath = classifyItemName(name, {
                    itemsByName: registry.itemsByName,
                    foodsByName: registry.foodsByName
                });
                const namePath = classifyItemName(name, { foodsByName: registry.foodsByName });
                if (registryPath !== namePath) mismatches.push(`${name}: ${registryPath}/${namePath}`);
            }
            assert.deepEqual(mismatches, [], version);
        }
    });

    it('classifies the full vanilla gear set the same way on every version', () => {
        const expected = new Map([
            ['netherite_helmet', ITEM_CATEGORY.helmet],
            ['netherite_chestplate', ITEM_CATEGORY.chestplate],
            ['netherite_leggings', ITEM_CATEGORY.leggings],
            ['netherite_boots', ITEM_CATEGORY.boots],
            ['shield', ITEM_CATEGORY.shield],
            ['netherite_sword', ITEM_CATEGORY.weapon],
            ['netherite_axe', ITEM_CATEGORY.weapon],
            ['netherite_pickaxe', ITEM_CATEGORY.tool],
            ['bow', ITEM_CATEGORY.rangedWeapon],
            ['arrow', ITEM_CATEGORY.ammo],
            ['torch', ITEM_CATEGORY.torch],
            ['bread', ITEM_CATEGORY.food],
            ['chest', ITEM_CATEGORY.other]
        ]);

        for (const version of SUPPORTED_VERSIONS) {
            const registry = minecraftData(version);
            for (const [name, category] of expected) {
                assert.equal(
                    classifyItemName(name, {
                        itemsByName: registry.itemsByName,
                        foodsByName: registry.foodsByName
                    }),
                    category,
                    `${name} @ ${version}`
                );
            }
        }
    });
});

describe('materialScore', () => {
    it('ranks gear by its leading material token', () => {
        assert.ok(
            materialScore('netherite_sword', ITEM_CATEGORY.weapon)
            > materialScore('diamond_sword', ITEM_CATEGORY.weapon)
        );
        assert.ok(
            materialScore('iron_helmet', ITEM_CATEGORY.helmet)
            > materialScore('leather_helmet', ITEM_CATEGORY.helmet)
        );
        assert.ok(materialScore('diamond_pickaxe', ITEM_CATEGORY.tool) > 0);
    });

    it('scores nothing outside a material-tiered category', () => {
        // The old substring check read these as gold and stone gear.
        assert.equal(materialScore('gold_ingot', ITEM_CATEGORY.other), 0);
        assert.equal(materialScore('stone', ITEM_CATEGORY.other), 0);
        assert.equal(materialScore('golden_apple', ITEM_CATEGORY.food), 0);
        assert.equal(materialScore('torch', ITEM_CATEGORY.torch), 0);
        assert.equal(materialScore('bow', ITEM_CATEGORY.rangedWeapon), 0);
    });

    it('matches only the leading token, never a substring', () => {
        // `raw_gold` ends in a material word; it is still not gold gear.
        assert.equal(materialScore('raw_gold', ITEM_CATEGORY.weapon), 0);
        assert.equal(materialScore('netherite_scrap', ITEM_CATEGORY.other), 0);
    });
});

describe('category predicates', () => {
    it('retains exactly the categories in the allow-list', () => {
        assert.deepEqual(RETAINED_CATEGORIES, [
            'helmet',
            'chestplate',
            'leggings',
            'boots',
            'shield',
            'weapon',
            'food',
            'torch'
        ]);
        for (const category of RETAINED_CATEGORIES) {
            assert.equal(isRetainedCategory(category), true, category);
        }
        for (const category of [
            ITEM_CATEGORY.rangedWeapon,
            ITEM_CATEGORY.ammo,
            ITEM_CATEGORY.tool,
            ITEM_CATEGORY.other
        ]) {
            assert.equal(isRetainedCategory(category), false, category);
        }
        assert.equal(isRetainedCategory(null), false);
        assert.equal(isRetainedCategory(undefined), false);
    });

    it('treats worn and wielded categories as equipment', () => {
        for (const category of ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'weapon']) {
            assert.equal(isEquipmentCategory(category), true, category);
        }
        for (const category of [ITEM_CATEGORY.food, ITEM_CATEGORY.torch, ITEM_CATEGORY.tool]) {
            assert.equal(isEquipmentCategory(category), false, category);
        }
        assert.equal(isEquipmentCategory(null), false);
    });

    it('counts melee and ranged weapons as being armed', () => {
        for (const name of ['iron_sword', 'iron_axe', 'trident', 'mace', 'bow', 'crossbow']) {
            assert.equal(isCombatWeaponName(name), true, name);
        }
        for (const name of ['iron_pickaxe', 'shears', 'shield', 'torch', 'cobblestone', '']) {
            assert.equal(isCombatWeaponName(name), false, name);
        }
    });

    it('counts weapons and work tools as work equipment', () => {
        for (const name of [
            'diamond_sword',
            'netherite_axe',
            'iron_pickaxe',
            'stone_shovel',
            'wooden_hoe',
            'bow',
            'crossbow',
            'trident',
            'mace',
            'shears'
        ]) {
            assert.equal(isWorkItemCategoryName(name), true, name);
        }
        for (const name of ['air', 'bread', 'torch', 'cobblestone', 'shield']) {
            assert.equal(isWorkItemCategoryName(name), false, name);
        }
    });
});
