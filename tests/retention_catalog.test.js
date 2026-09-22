import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import {
    buildRetentionCatalog,
    catalogItemsByCategory
} from '../src/companion/utils/retentionCatalog.js';
import { itemDisplayNameJa } from '../src/i18n/itemNames.js';
import { RETAINED_CATEGORIES } from '../src/companion/utils/itemClassify.js';

const REGISTRY = minecraftData('1.21.6');
const CATALOG = buildRetentionCatalog(REGISTRY, {
    version: '1.21.6',
    itemLabel: itemDisplayNameJa,
    categoryLabel: (id) => `label:${id}`
});

/** @param {string} id */
function items(id) {
    return CATALOG.categories.find((category) => category.id === id)?.items || [];
}

function allNames() {
    return CATALOG.categories.flatMap((category) => category.items.map((item) => item.name));
}

describe('buildRetentionCatalog', () => {
    it('offers one tab per retention category, in request order', () => {
        assert.deepEqual(CATALOG.categories.map((category) => category.id), [...RETAINED_CATEGORIES]);
        assert.deepEqual(
            CATALOG.categories.map((category) => category.label),
            RETAINED_CATEGORIES.map((id) => `label:${id}`)
        );
        assert.equal(CATALOG.version, '1.21.6');
    });

    it('stays small enough to be a picker rather than a dump', () => {
        // 1415 items exist; a list anywhere near that size is unusable.
        assert.ok(allNames().length < 100, `${allNames().length} candidates`);
        assert.equal(new Set(allNames()).size, allNames().length, 'no item appears twice');
    });

    it('covers every vanilla armor slot, shield and melee weapon', () => {
        assert.equal(items('helmet').length, 7, 'six materials plus the turtle shell');
        assert.equal(items('chestplate').length, 6);
        assert.equal(items('leggings').length, 6);
        assert.equal(items('boots').length, 6);
        assert.deepEqual(items('shield').map((item) => item.name), ['shield']);
        // Six swords, six axes, the mace and the trident.
        assert.equal(items('weapon').length, 14);
        for (const name of ['netherite_sword', 'diamond_axe', 'mace', 'trident']) {
            assert.ok(items('weapon').some((item) => item.name === name), name);
        }
    });

    it('lists the four light sources the companion carries', () => {
        assert.deepEqual(
            items('torch').map((item) => item.name),
            ['soul_torch', 'torch', 'lantern', 'soul_lantern']
        );
    });

    it('never offers ranged gear, which the companion does not use', () => {
        for (const name of ['bow', 'crossbow', 'arrow', 'spectral_arrow', 'tipped_arrow']) {
            assert.equal(allNames().includes(name), false, name);
        }
    });

    it('never offers a raw ingredient or an unsafe food', () => {
        for (const name of [
            'beef',
            'porkchop',
            'chicken',
            'mutton',
            'rabbit',
            'cod',
            'salmon',
            'potato',
            'tropical_fish',
            'rotten_flesh',
            'spider_eye',
            'poisonous_potato',
            'pufferfish',
            'chorus_fruit',
            'suspicious_stew'
        ]) {
            assert.equal(allNames().includes(name), false, name);
        }
        for (const name of ['cooked_beef', 'baked_potato', 'bread', 'golden_carrot']) {
            assert.ok(items('food').some((item) => item.name === name), name);
        }
    });

    it('shows hunger points rather than the registry saturation figure', () => {
        // `foodsByName.saturation` is foodPoints × ratio — 204.8 for a steak,
        // against the 12.8 vanilla means. Only foodPoints is safe to print.
        const steak = items('food').find((item) => item.name === 'cooked_beef');
        assert.equal(steak.foodPoints, 8);
        assert.equal(steak.saturation, undefined);
        assert.equal(items('weapon')[0].foodPoints, undefined, 'only food carries it');
    });

    it('puts the most useful entry first in every category', () => {
        assert.equal(items('helmet')[0].name, 'netherite_helmet');
        assert.equal(items('food')[0].name, 'rabbit_stew', 'ten hunger points');
        assert.ok(
            ['torch', 'soul_torch'].includes(items('torch')[0].name),
            'a placeable torch outranks a lantern'
        );
    });

    it('labels every candidate in Japanese', () => {
        const unlabelled = allNames().filter((name) => itemDisplayNameJa(name) === name);
        assert.deepEqual(unlabelled, []);
        assert.equal(
            items('weapon').find((item) => item.name === 'netherite_sword').label,
            'ネザライトの剣'
        );
    });

    it('states the bounds each category total accepts', () => {
        const weapon = CATALOG.categories.find((category) => category.id === 'weapon');
        assert.deepEqual(weapon.limit, { min: 1, max: 36, default: 2 });
        assert.equal(weapon.equipment, true);
        const torch = CATALOG.categories.find((category) => category.id === 'torch');
        assert.deepEqual(torch.limit, { min: 0, max: 36, default: 2 });
        assert.equal(torch.equipment, false);
    });

    it('draws empty tabs rather than throwing without a registry', () => {
        const empty = buildRetentionCatalog(null);
        assert.equal(empty.categories.length, RETAINED_CATEGORIES.length);
        assert.deepEqual(empty.categories.flatMap((category) => category.items), []);
        assert.equal(empty.version, null);
    });
});

describe('catalogItemsByCategory', () => {
    it('indexes the catalog for validation lookups', () => {
        const index = catalogItemsByCategory(CATALOG);
        assert.equal(index.get('weapon').has('iron_sword'), true);
        assert.equal(index.get('weapon').has('bow'), false);
        assert.equal(index.get('helmet').has('iron_sword'), false);
    });
});
