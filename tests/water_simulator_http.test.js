import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let server, base;
before(async () => {
    server = spawn(process.execPath, ['--import', 'tsx', 'src/simulator/server.ts'], {
        cwd: new URL('..', import.meta.url), env: { ...process.env, SIM_PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    base = await new Promise((resolve, reject) => {
        let logs = '';
        const timeout = setTimeout(() => reject(new Error(`simulator startup timed out: ${logs}`)), 15000);
        server.once('exit', code => { clearTimeout(timeout); reject(new Error(`simulator exited ${code}: ${logs}`)); });
        server.stderr.on('data', data => { logs += data; });
        server.stdout.on('data', data => {
            logs += data;
            const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (match) { clearTimeout(timeout); resolve(match[0]); }
        });
    });
});
after(async () => {
    if (server && server.exitCode == null) { const exit = once(server, 'exit'); server.kill(); await exit; }
});
async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
}

it('serves the water stage UI, script and six selectable scenarios', async () => {
    const html = await fetch(`${base}/water.html`).then(r => r.text());
    assert.match(html, /water-play/);
    const js = await fetch(`${base}/water.js`).then(r => r.text());
    assert.match(js, /\/api\/water\/tick/);
    const scenarios = await fetch(`${base}/api/water/scenarios`).then(r => r.json());
    assert.equal(scenarios.length, 6);
});

for (const scenario of ['shallow-one', 'shallow-two', 'deep-dive', 'roof-return']) {
    it(`simulator HTTP E2E: load ${scenario} and run 180 seconds through the playback API`, async () => {
        const loaded = await post('/api/water/start', { scenario });
        let state = loaded.state;
        for (let i = 0; i < 18; i++) {
            ({ state } = await post('/api/water/tick', { id: loaded.id, ticks: 200 }));
            assert.equal(state.vitals.drowningDamage, 0);
            assert.ok(state.bot.hp > 0);
        }
        assert.equal(state.tick, 3600);
        assert.ok(state.metrics.returnCount >= 2);
        assert.ok(state.metrics.resumedCount >= 2);
        if (scenario.startsWith('shallow')) assert.ok(state.bot.x >= 22);
    });
}

it('rejects an unknown stage without starting a broken session', async () => {
    const response = await fetch(`${base}/api/water/start`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'missing' })
    });
    assert.equal(response.status, 400);
});
