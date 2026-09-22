import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    RetentionValidationError,
    effectiveRetention,
    mergeRetentionIntoConfig,
    normalizeRetentionInput,
    readRetentionBlock
} from '../dashboard/retentionSettings.mjs';

/** A stand-in for what the bot's control API publishes. */
const CATALOG = {
    version: '1.21.6',
    categories: [
        {
            id: 'helmet',
            label: '頭防具',
            equipment: true,
            limit: { min: 1, max: 36, default: 2 },
            items: [{ name: 'netherite_helmet' }, { name: 'iron_helmet' }]
        },
        {
            id: 'weapon',
            label: '近接武器',
            equipment: true,
            limit: { min: 1, max: 36, default: 2 },
            items: [{ name: 'iron_sword' }, { name: 'golden_sword' }, { name: 'wooden_sword' }]
        },
        {
            id: 'torch',
            label: '松明・ランタン',
            equipment: false,
            limit: { min: 0, max: 36, default: 2 },
            items: [{ name: 'torch' }, { name: 'lantern' }]
        }
    ]
};

/** @param {() => unknown} run */
function rejection(run) {
    try {
        run();
    } catch (error) {
        return error;
    }
    return null;
}

describe('normalizeRetentionInput', () => {
    it('fills in every category the caller left out', () => {
        assert.deepEqual(normalizeRetentionInput(CATALOG, {}), {
            helmet: { limit: 2, items: {} },
            weapon: { limit: 2, items: {} },
            torch: { limit: 2, items: {} }
        });
    });

    it('keeps a category total alongside its per-item rules', () => {
        assert.deepEqual(
            normalizeRetentionInput(CATALOG, {
                weapon: { limit: 2, items: { iron_sword: 1, golden_sword: 1, wooden_sword: 0 } }
            }).weapon,
            { limit: 2, items: { iron_sword: 1, golden_sword: 1, wooden_sword: 0 } }
        );
    });

    it('takes the strings an HTML number input actually sends', () => {
        const result = normalizeRetentionInput(CATALOG, {
            weapon: { limit: '3', items: { iron_sword: '1' } }
        });
        assert.deepEqual(result.weapon, { limit: 3, items: { iron_sword: 1 } });
    });

    it('reads an empty box as "no rule", not as zero', () => {
        // Zero strikes an item off the list; a blank field must not do that by
        // accident, so it is dropped and the category total decides.
        const result = normalizeRetentionInput(CATALOG, {
            weapon: { limit: '', items: { iron_sword: '', golden_sword: null } }
        });
        assert.deepEqual(result.weapon, { limit: 2, items: {} });
    });

    it('refuses a total that would return what the companion is wearing', () => {
        const error = rejection(() => normalizeRetentionInput(CATALOG, { helmet: { limit: 0 } }));
        assert.ok(error instanceof RetentionValidationError);
        assert.equal(error.status, 400);
        assert.match(error.message, /頭防具/);
        assert.match(error.message, /1〜36/);
        // A stacked category may legitimately be turned off.
        assert.equal(normalizeRetentionInput(CATALOG, { torch: { limit: 0 } }).torch.limit, 0);
    });

    it('refuses values outside the bounds the catalog published', () => {
        for (const input of [
            { weapon: { limit: 37 } },
            { weapon: { limit: -1 } },
            { weapon: { items: { iron_sword: 37 } } },
            { weapon: { items: { iron_sword: -1 } } }
        ]) {
            assert.equal(
                rejection(() => normalizeRetentionInput(CATALOG, input))?.status,
                400,
                JSON.stringify(input)
            );
        }
    });

    it('refuses a value that is not a whole number', () => {
        for (const value of [2.5, 'two', true, {}, []]) {
            assert.equal(
                rejection(() => normalizeRetentionInput(CATALOG, { weapon: { limit: value } }))?.status,
                400,
                String(value)
            );
        }
    });

    it('refuses a category or item the catalog does not offer', () => {
        assert.match(
            rejection(() => normalizeRetentionInput(CATALOG, { pickaxe: { limit: 1 } })).message,
            /pickaxe/
        );
        assert.match(
            rejection(() => normalizeRetentionInput(CATALOG, { weapon: { items: { bow: 1 } } })).message,
            /bow/
        );
    });

    it('refuses a submission of the wrong shape', () => {
        for (const input of [null, 'nope', [], 7]) {
            assert.equal(
                rejection(() => normalizeRetentionInput(CATALOG, input))?.status,
                400,
                JSON.stringify(input)
            );
        }
        assert.equal(
            rejection(() => normalizeRetentionInput(CATALOG, { weapon: 3 }))?.status,
            400
        );
    });

    it('refuses to save at all without a catalog to check against', () => {
        // Better a clear "the bot is still starting" than a config.json full of
        // item names nothing will ever match.
        const error = rejection(() => normalizeRetentionInput(null, { weapon: { limit: 2 } }));
        assert.equal(error.status, 400);
        assert.match(error.message, /相棒/);
    });

    it('round-trips its own output', () => {
        const once = normalizeRetentionInput(CATALOG, {
            weapon: { limit: 3, items: { wooden_sword: 0 } }
        });
        assert.deepEqual(normalizeRetentionInput(CATALOG, once), once);
    });
});

describe('effectiveRetention', () => {
    it('describes an install that has never been configured', () => {
        assert.deepEqual(effectiveRetention(CATALOG, undefined), {
            helmet: { limit: 2, items: {} },
            weapon: { limit: 2, items: {} },
            torch: { limit: 2, items: {} }
        });
    });

    it('draws the screen from a hand-edited file instead of refusing to', () => {
        // Reading is lenient where writing is strict: a bad value falls back
        // rather than leaving the owner with no picker at all.
        const effective = effectiveRetention(CATALOG, {
            helmet: { limit: 0 },
            weapon: { limit: 99, items: { iron_sword: 'x', wooden_sword: 0 } },
            torch: 'broken',
            pickaxe: { limit: 4 }
        });
        assert.equal(effective.helmet.limit, 1, 'clamped up to the equipment floor');
        assert.equal(effective.weapon.limit, 36);
        assert.deepEqual(effective.weapon.items, { wooden_sword: 0 });
        assert.deepEqual(effective.torch, { limit: 2, items: {} });
        assert.equal(effective.pickaxe, undefined, 'a category the catalog dropped');
    });

    it('drops a rule for an item this Minecraft version no longer has', () => {
        const effective = effectiveRetention(CATALOG, {
            weapon: { limit: 2, items: { iron_sword: 1, some_removed_sword: 0 } }
        });
        assert.deepEqual(effective.weapon.items, { iron_sword: 1 });
    });
});

describe('config.json read / write', () => {
    it('finds the block wherever it is, and nothing where it is not', () => {
        assert.deepEqual(
            readRetentionBlock({ companion: { item_share: { retention: { weapon: { limit: 3 } } } } }),
            { weapon: { limit: 3 } }
        );
        for (const config of [undefined, null, {}, { companion: {} }, { companion: { item_share: {} } }]) {
            assert.equal(readRetentionBlock(config), undefined, JSON.stringify(config));
        }
    });

    it('creates the branch a real config.json is usually missing', () => {
        // The shipped config.json often has no item_share block at all.
        const config = { minecraft_version: '1.21.6', companion: { tick_ms: 250 } };
        const merged = mergeRetentionIntoConfig(config, { weapon: { limit: 3, items: {} } });
        assert.equal(merged, config, 'edits in place, so the rest of the file survives');
        assert.equal(merged.minecraft_version, '1.21.6');
        assert.equal(merged.companion.tick_ms, 250);
        assert.deepEqual(readRetentionBlock(merged), { weapon: { limit: 3, items: {} } });
    });

    it('leaves the other item_share settings alone', () => {
        const merged = mergeRetentionIntoConfig(
            { companion: { item_share: { enabled: true, max_open_passes: 4 } } },
            { torch: { limit: 1, items: {} } }
        );
        assert.equal(merged.companion.item_share.enabled, true);
        assert.equal(merged.companion.item_share.max_open_passes, 4);
    });
});
