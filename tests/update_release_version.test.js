import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUpdateManager } from '../dashboard/update.mjs';
import { releaseContainerConfig, releaseImageRef } from '../dashboard/releaseVersion.mjs';

it('updates pinned installations and confirms VERSION only after the new dashboard starts', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trailmate-pin-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'VERSION'), 'v0.1.40\n');
    await fs.writeFile(path.join(root, 'docker-compose.yml'),
        'services:\n  trailmate:\n    image: ghcr.io/koupent/trailmate-mc:v0.1.40\n  dashboard:\n    image: ghcr.io/koupent/trailmate-dashboard:v0.1.40\n    environment:\n      DASHBOARD_PORT: 8787\n    ports:\n      - "8787:8787"\n');
    const recreated = [];
    const deps = {
        despawnGraceMs: 0,
        fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.1.43', name: 'v0.1.43', html_url: 'https://example.test/v0.1.43' }) }),
        recreateServiceContainer: async (service, _progress, options = {}) => {
            await options.beforeSelfReplace?.();
            const image = service === 'trailmate' ? 'ghcr.io/koupent/trailmate-mc' : 'ghcr.io/koupent/trailmate-dashboard';
            const config = releaseContainerConfig({ Image: image + ':v0.1.40',
                Env: ['BOT_NAME=Companion', 'TRAILMATE_VERSION=v0.1.40', 'DASHBOARD_VERSION=v0.1.40'] }, options.targetVersion, service);
            recreated.push({ service, config });
        }
    };
    const manager = createUpdateManager(root, { ...deps, dashboardVersion: 'v0.1.40' });
    const result = await manager.startApply({});
    assert.equal(result.ok, true);
    for (let i = 0; i < 200 && recreated.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(recreated.length, 2);
    for (const { service, config } of recreated) {
        assert.ok(config.Image.endsWith(':v0.1.43'), `recreated old image ${config.Image}`);
        assert.ok(config.Env.includes('BOT_NAME=Companion'));
        assert.equal(config.Env.includes('DASHBOARD_BIND=0.0.0.0'), service === 'dashboard');
        assert.equal(config.Env.some(value => /^(TRAILMATE_VERSION|DASHBOARD_VERSION)=/.test(value)), false);
        assert.equal(config.Env.some(value => value.includes('v0.1.40')), false);
    }
    const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    assert.equal(compose.includes('v0.1.40'), false, 'restart must not restore old release');
    assert.equal((compose.match(/:v0\.1\.43/g) || []).length, 2);
    assert.match(compose, /DASHBOARD_BIND: 0\.0\.0\.0/);
    assert.match(compose, /127\.0\.0\.1:8787:8787/);
    assert.equal((await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim(), 'v0.1.40');
    assert.equal((await manager.getLogs()).updating, true);
    const newDashboard = createUpdateManager(root, { ...deps, dashboardVersion: 'v0.1.43' });
    const completed = await newDashboard.getLogs();
    assert.equal(completed.updating, false);
    assert.equal(completed.ok, true);
    assert.equal((await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim(), 'v0.1.43');
});

it('retags registry ports and digest pins without corrupting image names', () => {
    assert.equal(releaseImageRef('registry.example:5000/team/bot:old', 'v0.1.43'), 'registry.example:5000/team/bot:v0.1.43');
    assert.equal(releaseImageRef('ghcr.io/team/bot@sha256:abc', 'v0.1.43'), 'ghcr.io/team/bot:v0.1.43');
    assert.throws(() => releaseImageRef('image', '../invalid'), /不正/);
});

it('reports an older running dashboard even after VERSION records the latest release', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trailmate-dashboard-version-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'VERSION'), 'v0.1.44\n');
    const deps = { fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.1.44' }) }) };
    const stale = await createUpdateManager(root, { ...deps, dashboardVersion: 'v0.1.42' }).getStatus();
    assert.equal(stale.currentVersion, 'v0.1.42');
    assert.equal(stale.recordedVersion, 'v0.1.44');
    assert.equal(stale.versionMismatch, true);
    assert.equal(stale.updateAvailable, true);
    const updated = await createUpdateManager(root, { ...deps, dashboardVersion: 'v0.1.44' }).getStatus();
    assert.equal(updated.versionMismatch, false);
    assert.equal(updated.updateAvailable, false);
});

it('keeps the original VERSION when the replacement dashboard does not respond in time', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trailmate-dashboard-timeout-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'data'));
    await fs.writeFile(path.join(root, 'VERSION'), 'v0.1.44\n');
    await fs.writeFile(path.join(root, 'data', 'update-state.json'), JSON.stringify({
        startedAt: Date.now() - 180000,
        dashboardPendingAt: Date.now() - 180000,
        targetVersion: 'v0.1.45'
    }));
    await fs.writeFile(path.join(root, 'data', 'update.lock'), 'locked');
    const oldDashboard = createUpdateManager(root, { dashboardVersion: 'v0.1.44' });
    const finished = await oldDashboard.getLogs();
    assert.equal(finished.updating, false);
    assert.equal(finished.ok, false);
    assert.match(finished.error, /起動を確認できません/);
    assert.equal((await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim(), 'v0.1.44');
});
