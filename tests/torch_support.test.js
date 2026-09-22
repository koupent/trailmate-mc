import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { maybePlaceSupportTorch } from '../src/companion/stateMachine/torchSupport.js';

/**
 * A pitch-dark spot with solid ground under it: everything the torch support
 * checks before it places, so the item choice is the only variable left.
 * @param {string[]} inventoryNames
 */
function makeCtx(inventoryNames) {
    const events = [];
    const items = inventoryNames.map((name, index) => ({ name, slot: 9 + index }));
    const bot = {
        entity: { position: new Vec3(0.5, 64, 0.5) },
        time: { timeOfDay: 18000 },
        inventory: { items: () => items },
        blockAt(position) {
            if (Math.floor(position.y) < 64) return { name: 'stone', skyLight: 0 };
            return { name: 'air', skyLight: 0 };
        },
        async equip(item) {
            events.push(`equip:${item.name}`);
        },
        async placeBlock() {
            events.push('place');
        }
    };
    return {
        ctx: { bot, config: { torch_placing: true, torch_light_threshold: 7 } },
        events
    };
}

describe('follow-time torch support', () => {
    it('places a plain torch in the dark', async () => {
        const { ctx, events } = makeCtx(['torch']);

        await maybePlaceSupportTorch(ctx);

        assert.deepEqual(events, ['equip:torch', 'place']);
    });

    it('places a soul torch when that is the light source on hand', async () => {
        const { ctx, events } = makeCtx(['soul_torch']);

        await maybePlaceSupportTorch(ctx);

        assert.deepEqual(events, ['equip:soul_torch', 'place']);
    });

    it('does not mistake a redstone torch for a light source', async () => {
        const { ctx, events } = makeCtx(['redstone_torch', 'cobblestone']);

        await maybePlaceSupportTorch(ctx);

        assert.deepEqual(events, []);
    });
});
