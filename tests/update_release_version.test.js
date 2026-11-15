import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUpdateManager } from '../dashboard/update.mjs';
import { releaseContainerConfig, releaseImageRef } from '../dashboard/releaseVersion.mjs';

it('updates pinned ZIP installations to the requested image, environment and restart pins', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trailmate-pin-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'VERSION'), 'v0.1.40\n');
    await fs.writeFile(path.join(root, 'docker-compose.yml'),
        'services:\n  trailmate:\n    image: ghcr.io/koupent/trailmate-mc:v0.1.40\n  dashboard:\n    image: ghcr.io/koupent/trailmate-dashboard:v0.1.40\n');
    const recreated = [];
    const manager = createUpdateManager(root, {
        despawnGraceMs: 0,
        fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v0.1.43', name: 'v0.1.43', html_url: 'https://example.test/v0.1.43' }) }),
        recreateServiceContainer: async (service, _progress, options = {}) => {
            const image = service === 'trailmate' ? 'ghcr.io/koupent/trailmate-mc' : 'ghcr.io/koupent/trailmate-dashboard';
            const config = releaseContainerConfig({ Image: image + ':v0.1.40',
                Env: ['BOT_NAME=Companion', 'TRAILMATE_VERSION=v0.1.40', 'DASHBOARD_VERSION=v0.1.40'] }, options.targetVersion);
            recreated.push({ service, config });
        }
    });
    const result = await manager.startApply({});
    assert.equal(result.ok, true);
    for (let i = 0; i < 200 && recreated.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(recreated.length, 2);
    for (const { config } of recreated) {
        assert.ok(config.Image.endsWith(':v0.1.43'), `recreated old image ${config.Image}`);
        assert.ok(config.Env.includes('TRAILMATE_VERSION=v0.1.43'));
        assert.ok(config.Env.includes('BOT_NAME=Companion'));
        assert.equal(config.Env.some(value => value.includes('v0.1.40')), false);
    }
    const compose = await fs.readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    assert.equal(compose.includes('v0.1.40'), false, 'restart must not restore old release');
    assert.equal((compose.match(/:v0\.1\.43/g) || []).length, 2);
    assert.equal((await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim(), 'v0.1.43');
});

it('retags registry ports and digest pins without corrupting image names', () => {
    assert.equal(releaseImageRef('registry.example:5000/team/bot:old', 'v0.1.43'), 'registry.example:5000/team/bot:v0.1.43');
    assert.equal(releaseImageRef('ghcr.io/team/bot@sha256:abc', 'v0.1.43'), 'ghcr.io/team/bot:v0.1.43');
    assert.throws(() => releaseImageRef('image', '../invalid'), /不正/);
});
