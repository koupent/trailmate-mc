import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKEND_STARTING_MESSAGE,
  PROXY_STARTING_MESSAGE,
  SESSION_FAILED_MESSAGE,
  TARGET_UNREACHABLE_MESSAGE,
  backendUnavailableStatus,
  buildSpawnDiagnostics,
  humanizeSpawnError,
  parseHostPort,
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

  it('parses host:port', () => {
    assert.deepEqual(parseHostPort('example.com:25565'), {
      host: 'example.com',
      port: 25565
    });
    assert.deepEqual(parseHostPort('example.com'), {
      host: 'example.com',
      port: 25565
    });
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

  it('buildSpawnDiagnostics blocks on unreachable target even when proxy is healthy', async () => {
    const result = await buildSpawnDiagnostics({
      controlUrl: 'http://trailmate:8790',
      targetAddress: 'mc.example.com:25565',
      authMethod: 'NONE',
      fetch: async () => ({ ok: true, status: 200 }),
      getProxyHealth: async () => ({ ok: true, status: 'healthy' }),
      probeTcpFn: async () => ({ ok: false, detail: 'timeout' })
    });
    assert.equal(result.spawnReady, false);
    assert.equal(result.blockerId, 'target');
    assert.equal(result.error, TARGET_UNREACHABLE_MESSAGE);
    assert.ok(result.steps.some((s) => s.id === 'target' && s.state === 'error'));
  });

  it('probeSpawnReady becomes ok when all checks pass', async () => {
    const result = await probeSpawnReady({
      controlUrl: 'http://trailmate:8790',
      targetAddress: 'mc.example.com:25565',
      authMethod: 'NONE',
      fetch: async () => ({ ok: true, status: 200 }),
      getProxyHealth: async () => ({ ok: true, status: 'healthy' }),
      probeTcpFn: async () => ({ ok: true, detail: 'mc.example.com:25565' })
    });
    assert.equal(result.ok, true);
    assert.equal(result.spawnReady, true);
    assert.equal(result.diagnostics.summary, 'スポーンできる状態です。');
  });

  it('humanizes socketClosed differently when infrastructure is ready', () => {
    assert.equal(
      humanizeSpawnError('bot ended before spawn: socketClosed', { spawnReady: true }),
      SESSION_FAILED_MESSAGE
    );
    assert.equal(
      humanizeSpawnError('bot ended before spawn: socketClosed', { blockerId: 'target' }),
      TARGET_UNREACHABLE_MESSAGE
    );
  });
});
