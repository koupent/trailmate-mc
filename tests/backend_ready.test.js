import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_STARTING_MESSAGE,
  PROXY_STARTING_MESSAGE,
  backendUnavailableStatus,
  humanizeSpawnError,
  probeSpawnReady,
  probeTrailmateBackend,
  withReadiness
} from '../dashboard/backendReady.mjs';

describe('backend readiness helpers', () => {
  it('builds a calm unavailable status payload', () => {
    const status = backendUnavailableStatus();
    assert.equal(status.backendReady, false);
    assert.equal(status.spawnReady, false);
    assert.equal(status.spawned, false);
    assert.equal(status.backendMessage, BACKEND_STARTING_MESSAGE);
  });

  it('marks readiness flags independently', () => {
    const status = withReadiness(
      { spawned: false, botName: 'Trailmate' },
      { backendReady: true, spawnReady: false, backendMessage: PROXY_STARTING_MESSAGE }
    );
    assert.equal(status.backendReady, true);
    assert.equal(status.spawnReady, false);
    assert.equal(status.backendMessage, PROXY_STARTING_MESSAGE);
    assert.equal(status.botName, 'Trailmate');
  });

  it('probeTrailmateBackend returns ok when /health succeeds', async () => {
    const result = await probeTrailmateBackend('http://trailmate:8790', {
      fetch: async (url) => {
        assert.equal(url, 'http://trailmate:8790/health');
        return { ok: true, status: 200 };
      }
    });
    assert.equal(result.ok, true);
  });

  it('probeTrailmateBackend treats connection failure as starting', async () => {
    const result = await probeTrailmateBackend('http://trailmate:8790', {
      fetch: async () => {
        throw new Error('fetch failed');
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, BACKEND_STARTING_MESSAGE);
  });

  it('probeSpawnReady stays blocked while ViaProxy is starting', async () => {
    const result = await probeSpawnReady({
      controlUrl: 'http://trailmate:8790',
      fetch: async () => ({ ok: true, status: 200 }),
      getProxyHealth: async () => ({ ok: false, status: 'starting' })
    });
    assert.equal(result.ok, false);
    assert.equal(result.backendReady, true);
    assert.equal(result.spawnReady, false);
    assert.equal(result.error, PROXY_STARTING_MESSAGE);
  });

  it('probeSpawnReady becomes ok when trailmate and ViaProxy are ready', async () => {
    const result = await probeSpawnReady({
      controlUrl: 'http://trailmate:8790',
      fetch: async () => ({ ok: true, status: 200 }),
      getProxyHealth: async () => ({ ok: true, status: 'healthy' })
    });
    assert.equal(result.ok, true);
    assert.equal(result.spawnReady, true);
  });

  it('humanizes socketClosed spawn failures', () => {
    assert.equal(
      humanizeSpawnError('bot ended before spawn: socketClosed'),
      PROXY_STARTING_MESSAGE
    );
  });
});
