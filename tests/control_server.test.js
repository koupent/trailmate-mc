import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRetention,
  buildStatus,
  createControlState,
  readRetentionCatalog
} from '../src/runtime/controlServer.ts';
import { createChestTransferConfig } from '../src/companion/utils/ChestItemTransfer.js';

describe('control server status', () => {
  it('parked status reports not spawned', () => {
    const state = createControlState();
    const status = buildStatus(state);
    assert.equal(status.spawned, false);
    assert.equal(status.spawning, false);
    assert.equal(status.lastError, null);
  });

  it('spawned status includes mode and inventory fields', () => {
    const state = createControlState();
    state.host = /** @type {any} */ ({
      name: 'Trailmate',
      bot: {
        username: 'Trailmate',
        health: 18,
        food: 16,
        entity: { position: { x: 1.24, y: 64.0, z: -3.56 } },
        game: { dimension: 'overworld' },
        inventory: {
          items: () => [
            { name: 'torch', count: 32 },
            { name: 'bread', count: 5 },
            { name: 'torch', count: 8 }
          ]
        }
      },
      companion: {
        ctx: { ownerName: 'PlayerOne' },
        manager: {
          getCurrentModeId: () => 'follow',
          getActiveFsmId: () => 'combat'
        }
      }
    });

    const status = buildStatus(state);
    assert.equal(status.spawned, true);
    assert.equal(status.ownerName, 'PlayerOne');
    assert.equal(status.preferredMode, 'follow');
    assert.equal(status.activeFsm, 'combat');
    assert.deepEqual(status.position, { x: 1.2, y: 64, z: -3.6 });
    const byName = Object.fromEntries(
      status.inventory.map((item) => [item.name, item])
    );
    assert.equal(byName.torch.count, 40);
    assert.equal(byName.torch.displayName, '松明');
    assert.equal(byName.bread.count, 5);
    assert.equal(byName.bread.displayName, 'パン');
  });
});

describe('retention catalog route', () => {
  it('publishes the candidate list without waiting for a spawn', () => {
    // The dashboard has no minecraft-data of its own, so the control API must
    // answer while the companion is still parked.
    const catalog = readRetentionCatalog(createControlState());
    assert.deepEqual(
      catalog.categories.map((category) => category.id),
      ['helmet', 'chestplate', 'leggings', 'boots', 'shield', 'weapon', 'food', 'torch']
    );
    const weapon = catalog.categories.find((category) => category.id === 'weapon');
    assert.equal(weapon.label, '近接武器');
    assert.deepEqual(weapon.limit, { min: 1, max: 36, default: 2 });
    assert.ok(weapon.items.some((item) => item.name === 'netherite_sword'));
    assert.equal(weapon.items.some((item) => item.name === 'bow'), false);
    assert.equal(
      catalog.categories.find((category) => category.id === 'food').items
        .some((item) => item.name === 'beef'),
      false,
      'raw ingredients are not offered'
    );
  });
});

describe('retention apply route', () => {
  /** A companion with the two live config objects `startCompanion` leaves behind. */
  function makeSpawnedState() {
    const state = createControlState();
    const itemTransfer = { config: createChestTransferConfig() };
    state.host = /** @type {any} */ ({
      bot: { username: 'Trailmate' },
      companion: {
        itemTransfer,
        ctx: { config: { item_share: createChestTransferConfig() } }
      }
    });
    return state;
  }

  it('reaches both live copies, so the next chest uses the new rules', () => {
    const state = makeSpawnedState();
    const result = applyRetention(state, {
      retention: { weapon: { limit: 3, items: { wooden_sword: 0 } } }
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    const companion = /** @type {any} */ (state.host.companion);
    // The chest transfer plans deposits from its own copy; the dialogue asks
    // the owner to restock from the context's.
    for (const live of [companion.itemTransfer.config, companion.ctx.config.item_share]) {
      assert.equal(live.retention.weapon.limit, 3);
      assert.deepEqual(live.retention.weapon.items, { wooden_sword: 0 });
      assert.equal(live.retention.helmet.limit, 2, 'untouched categories keep their default');
    }
  });

  it('normalizes what it is handed before it reaches the companion', () => {
    const state = makeSpawnedState();
    const result = applyRetention(state, { retention: { helmet: { limit: 0 } } });
    assert.equal(result.retention.helmet.limit, 1, 'gear never drops to zero');
  });

  it('reports that nothing took the change while parked', () => {
    const result = applyRetention(createControlState(), {
      retention: { torch: { limit: 1, items: {} } }
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.retention.torch.limit, 1);
  });
});
