import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_STARTING_MESSAGE,
  backendUnavailableStatus,
  probeTrailmateBackend,
  withBackendReady
} from '../dashboard/backendReady.mjs';

describe('backend readiness helpers', () => {
  it('builds a calm unavailable status payload', () => {
    const status = backendUnavailableStatus();
    assert.equal(status.backendReady, false);
    assert.equal(status.spawned, false);
    assert.equal(status.backendMessage, BACKEND_STARTING_MESSAGE);
  });

  it('marks successful control status as backendReady', () => {
    const status = withBackendReady({ spawned: false, botName: 'Trailmate' }, true);
    assert.equal(status.backendReady, true);
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
});
