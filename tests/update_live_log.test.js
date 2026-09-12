import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUpdateManager, normalizeTag } from '../dashboard/update.mjs';

describe('update manager live log re-fetch', () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'trailmate-update-'));
    await fs.writeFile(path.join(root, 'VERSION'), '0.1.5\n', 'utf8');
  });

  after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('getLogs polling does not wipe an in-progress job log', async () => {
    let releaseTrailmate;
    const trailmateGate = new Promise((resolve) => {
      releaseTrailmate = resolve;
    });
    /** @type {string[]} */
    const progressLines = [];

    const mgr = createUpdateManager(root, {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v0.1.6',
          name: 'v0.1.6',
          html_url: 'https://example.test/release'
        })
      }),
      recreateServiceContainer: async (service, onProgress) => {
        if (service === 'trailmate') {
          onProgress('[docker] pulling trailmate');
          progressLines.push('pull');
          await trailmateGate;
          onProgress('[docker] recreated trailmate');
          return;
        }
        onProgress('[docker] recreated ' + service);
      }
    });

    const started = await mgr.startApply({});
    assert.equal(started.ok, true);
    assert.match(started.log, /更新開始/);

    // Wait until recreate is blocked mid-job
    for (let i = 0; i < 100 && progressLines.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(progressLines.includes('pull'), 'recreate should reach trailmate pull');

    const logFile = path.join(root, 'data', 'update.log');
    const onDisk = await fs.readFile(logFile, 'utf8');
    assert.match(onDisk, /recreate trailmate|pulling trailmate/);

    const mid = await mgr.getLogs();
    assert.equal(mid.updating, true);
    assert.match(mid.log, /pulling trailmate/);
    assert.match(mid.log, /更新開始/);

    // ディスクを意図的に古くする。壊れた hydrate はここでライブログを潰す。
    await fs.writeFile(logFile, 'STALE DISK LOG\n', 'utf8');
    await fs.writeFile(
      path.join(root, 'data', 'update-state.json'),
      JSON.stringify({
        active: true,
        startedAt: Date.now(),
        finishedAt: null,
        ok: null,
        error: null,
        targetVersion: 'v0.1.6'
      }),
      'utf8'
    );

    for (let i = 0; i < 5; i += 1) {
      const again = await mgr.getLogs();
      assert.equal(again.updating, true);
      assert.doesNotMatch(again.log, /STALE DISK LOG/);
      assert.match(again.log, /pulling trailmate/);
      assert.ok(again.log.length >= mid.log.length);
    }

    releaseTrailmate();
    for (let i = 0; i < 100; i += 1) {
      const done = await mgr.getLogs();
      if (!done.updating && done.ok) {
        assert.doesNotMatch(done.log, /STALE DISK LOG/);
        assert.match(done.log, /VERSION=v0\.1\.6|recreate dashboard|DONE/);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail('update did not finish');
  });
});

describe('update normalizeTag', () => {
  it('still normalizes tags', () => {
    assert.equal(normalizeTag('v0.1.6'), '0.1.6');
  });
});
