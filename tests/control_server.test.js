import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatus,
  createControlState
} from '../src/runtime/controlServer.ts';

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
    assert.deepEqual(status.inventory, [
      { name: 'bread', count: 5 },
      { name: 'torch', count: 40 }
    ]);
  });
});
