import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROXY_BACKEND_UNREACHABLE_MESSAGE,
  createProxyWatch,
  isProxyBackendFailure,
  stripMinecraftFormatting
} from '../dashboard/proxyRecovery.mjs';
import { humanizeSpawnError } from '../dashboard/backendReady.mjs';

describe('proxy backend failure detection', () => {
  it('detects the ViaProxy kick text even with colour codes', () => {
    assert.equal(
      isProxyBackendFailure(
        'bot ended before spawn: "§cCould not connect to the backend server!"'
      ),
      true
    );
    assert.equal(
      isProxyBackendFailure('java.nio.channels.UnresolvedAddressException'),
      true
    );
    assert.equal(isProxyBackendFailure(PROXY_BACKEND_UNREACHABLE_MESSAGE), true);
  });

  it('leaves unrelated failures alone', () => {
    assert.equal(
      isProxyBackendFailure('bot ended before spawn: multiplayer.disconnect.duplicate_login'),
      false
    );
    assert.equal(isProxyBackendFailure('bot ended before spawn: socketClosed'), false);
    assert.equal(isProxyBackendFailure(''), false);
  });

  it('strips minecraft formatting codes', () => {
    assert.equal(stripMinecraftFormatting('§cred §ltext'), 'red text');
  });

  it('humanizes the raw kick text for the dashboard', () => {
    assert.equal(
      humanizeSpawnError(
        'bot ended before spawn: "§cCould not connect to the backend server!"',
        { spawnReady: true }
      ),
      PROXY_BACKEND_UNREACHABLE_MESSAGE
    );
  });
});

describe('proxy watch', () => {
  const run = { proxyRunning: true, proxyStartedAt: 1000 };

  it('restarts once the target becomes reachable again', () => {
    const watch = createProxyWatch();
    // Windows 起動直後: ViaProxy は動いているが Tailscale がまだ上がっていない。
    assert.deepEqual(watch.observe({ ...run, reachable: false, now: 1 }), {
      restart: false,
      reason: 'target-unreachable'
    });
    const decision = watch.observe({ ...run, reachable: true, now: 2 });
    assert.equal(decision.restart, true);
    assert.equal(decision.reason, 'target-recovered');
    // 一度直したら繰り返さない。
    assert.equal(watch.observe({ ...run, reachable: true, now: 3 }).restart, false);
  });

  it('leaves a proxy alone that never lost the target', () => {
    const watch = createProxyWatch();
    assert.equal(watch.observe({ ...run, reachable: true, now: 1 }).restart, false);
    assert.equal(watch.observe({ ...run, reachable: true, now: 2 }).restart, false);
  });

  it('forgets the outage when the proxy has been restarted', () => {
    const watch = createProxyWatch();
    watch.observe({ ...run, reachable: false, now: 1 });
    const decision = watch.observe({
      proxyRunning: true,
      proxyStartedAt: 5000,
      reachable: true,
      now: 2
    });
    assert.equal(decision.restart, false);
    assert.equal(decision.reason, 'healthy');
  });

  it('never cuts a live session and clears suspicion when spawned', () => {
    const watch = createProxyWatch();
    watch.observe({ ...run, reachable: false, now: 1 });
    assert.equal(
      watch.observe({ ...run, reachable: true, spawned: true, now: 2 }).reason,
      'session-active'
    );
    assert.equal(watch.observe({ ...run, reachable: true, now: 3 }).restart, false);
  });

  it('waits while a spawn or login is in flight, then recovers', () => {
    const watch = createProxyWatch();
    watch.observe({ ...run, reachable: false, now: 1 });
    assert.deepEqual(watch.observe({ ...run, reachable: true, busy: true, now: 2 }), {
      restart: false,
      reason: 'busy'
    });
    assert.deepEqual(watch.observe({ ...run, reachable: true, spawning: true, now: 3 }), {
      restart: false,
      reason: 'busy'
    });
    assert.equal(watch.observe({ ...run, reachable: true, now: 4 }).restart, true);
  });

  it('holds off while the proxy is down and honours the cooldown', () => {
    const watch = createProxyWatch({ cooldownMs: 10000 });
    assert.deepEqual(watch.observe({ proxyRunning: false, reachable: true, now: 1 }), {
      restart: false,
      reason: 'proxy-not-running'
    });
    watch.observe({ ...run, reachable: false, now: 2 });
    assert.equal(watch.observe({ ...run, reachable: true, now: 3 }).restart, true);

    watch.observe({ proxyRunning: true, proxyStartedAt: 2000, reachable: false, now: 4 });
    assert.deepEqual(
      watch.observe({ proxyRunning: true, proxyStartedAt: 2000, reachable: true, now: 5 }),
      { restart: false, reason: 'cooldown' }
    );
  });
});
