import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionStatusCache } from '../dashboard/public/companionStatus.js';
import { renderFsmSvg } from '../dashboard/public/fsmGraph.js';
import { WaterSimulation } from '../src/simulator/WaterSimulation.js';
import { buildStatus, createControlState } from '../src/runtime/controlServer.ts';

it('keeps the floating bot FSM through missing polls and clears only after an explicit despawn', async () => {
    const sim = new WaterSimulation('low-food', { noFood: true });
    await sim.step(1000);
    const control = createControlState();
    control.host = sim.ctx.agent;
    const cache = createCompanionStatusCache();
    const live = buildStatus(control);
    assert.equal(live.activeFsm, 'hazard_escape');
    assert.equal(cache.update(live).stale, false);
    for (const missing of [{ backendReady: false }, { error: 'timeout' }, null, { spawned: true, fsm: null }]) {
        const view = cache.update(missing);
        assert.equal(view.stale, true);
        const svg = renderFsmSvg(view.snapshot.fsm, { label: id => id, note: () => '' });
        assert.match(svg, /data-state="hazard_escape"/);
        assert.match(svg, /is-safety is-active/);
    }
    assert.equal(cache.update(live).stale, false);
    assert.equal(cache.update({ backendReady: true, spawned: false }).snapshot, null);
});
