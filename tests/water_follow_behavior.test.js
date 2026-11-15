import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WaterSimulation } from '../src/simulator/WaterSimulation.js';
import { bodyInWater } from '../src/companion/movement/waterNavigation.js';
import { buildStatus, createControlState } from '../src/runtime/controlServer.ts';

const distance = point => Math.hypot(point.x - point.owner.x, point.z - point.owner.z);
const travel = points => points.slice(1).reduce((sum, point, index) => sum
    + Math.hypot(point.x - points[index].x, point.z - points[index].z), 0);

for (const yaw of [0, Math.PI / 2, Math.PI]) {
    it(`tracks an affordable underwater owner through a reversal, yaw=${yaw}`, async () => {
        const sim = new WaterSimulation('shallow-two', {
            initialBotPosition: [8.5, 7, 0.5], initialYaw: yaw,
            ownerMotion: time => ({ x: time < 10 ? 12 + time * 0.5 : Math.max(10, 17 - (time - 10) * 0.5), y: 7, z: 0.5 })
        });
        await sim.step(1000);
        const following = sim.trace.filter(p => p.tick > 160 && p.state === 'normal');
        const close = following.filter(p => distance(p) < 5);
        assert.ok(close.length / following.length >= 0.85,
            `only ${close.length}/${following.length} follow ticks within 5 blocks`);
        assert.ok(sim.trace.some(p => p.tick > 200 && p.x > 11), 'must follow outward');
        assert.ok(distance(sim.trace.at(-1)) <= 4, 'must follow the owner back');
        assert.equal(sim.drowningDamage, 0);
    });
}

it('follows a gradual shore exit and settles after the owner stops', async () => {
    const sim = new WaterSimulation('shallow-two', {
        initialBotPosition: [6.5, 8, 0.5],
        ownerMotion: time => {
            const x = Math.min(25, 9 + time * 0.65);
            return { x, y: Math.min(10, Math.max(8, 8 + (x - 20))), z: 0.5 };
        }
    });
    await sim.step(1400);
    const settled = sim.trace.filter(point => point.tick >= 1000);
    assert.ok(distance(settled.at(-1)) <= 4, 'must stay near the owner on shore');
    assert.ok(settled.at(-1).y >= 9.9, 'must get out of the water');
    assert.ok(travel(settled) < 1, `should settle, travelled ${travel(settled).toFixed(2)} blocks after owner stopped`);
    assert.equal(sim.drowningDamage, 0);
});

it('does not circle a stationary owner in shallow water', async () => {
    const sim = new WaterSimulation('shallow-one', {
        initialBotPosition: [2.05, 9, 0.15],
        ownerMotion: () => ({ x: 4.3, y: 9, z: 0.7 })
    });
    await sim.step(800);
    const settled = sim.trace.filter(point => point.tick >= 200);
    assert.ok(travel(sim.trace) < 0.2, `moved ${travel(sim.trace).toFixed(2)} blocks despite already being within follow range`);
});

it('gets onto the bank even when the owner stops just inside follow range', async () => {
    const sim = new WaterSimulation('shallow-two', {
        initialBotPosition: [17.5, 8.5, 0.3],
        ownerMotion: time => {
            const x = Math.min(22.2, 20 + time * 0.5);
            return { x, y: Math.min(10, Math.max(9, x - 12)), z: 0.3 };
        }
    });
    await sim.step(1000);
    assert.equal(bodyInWater(sim.bot), false, `stayed in the water near shore: ${sim.bot.entity.position}`);
    assert.equal(sim.bot.entity.onGround, true);
    assert.ok(sim.bot.entity.position.y >= 9.9);
    const settled = sim.trace.filter(point => point.tick >= 500);
    assert.ok(travel(settled) < 0.5, `shore oscillation: ${travel(settled).toFixed(2)} blocks`);
});

it('tracks a curved underwater path without prolonged freezes outside follow range', async () => {
    const sim = new WaterSimulation('underwater-turns', {
        ownerMotion: time => ({ x: 13 + 4 * Math.cos(time * 0.1), y: 7 + 0.2 * Math.sin(time * 0.1), z: 2 * Math.sin(time * 0.1) }),
        ownerLooksAtBot: true
    });
    await sim.step(1800);
    const normal = sim.trace.filter(point => point.tick > 200 && point.state === 'normal');
    assert.ok(normal.filter(point => distance(point) <= 5).length >= normal.length * 0.9);
    let stalled = 0;
    for (let i = 1; i < sim.trace.length; i++) {
        const p = sim.trace[i], before = sim.trace[i - 1];
        stalled = p.state === 'normal' && distance(p) > 5 && Math.hypot(p.x - before.x, p.z - before.z) < 0.02 ? stalled + 1 : 0;
        assert.ok(stalled < 12, `frozen outside range for 3 seconds at tick ${p.tick}`);
    }
    assert.equal(sim.drowningDamage, 0);
});

it('bobs naturally at the surface while holding position and always reports its live FSM', async () => {
    const sim = new WaterSimulation('water-idle');
    const control = createControlState();
    control.host = sim.ctx.agent;
    const heights = [];
    for (let tick = 0; tick < 80; tick++) {
        await sim.step(5);
        const status = JSON.parse(JSON.stringify(buildStatus(control)));
        assert.ok(status.fsm.states.includes(status.activeFsm));
        if (tick > 20) heights.push(status.position.y);
    }
    const amplitude = Math.max(...heights) - Math.min(...heights);
    assert.ok(amplitude > 0.05 && amplitude < 1, `surface physics frozen or unstable: ${amplitude}`);
    assert.ok(travel(sim.trace) < 0.2, 'floating must not cause horizontal circling');
    assert.equal(sim.drowningDamage, 0);
});

it('enters a deep pool from land and dives after an affordable submerged owner', async () => {
    const sim = new WaterSimulation('deep-dive', {
        initialBotPosition: [-2.5, 10, 0.5],
        ownerMotion: () => ({ x: 6.5, y: 7, z: 0.5 })
    });
    await sim.step(600);
    assert.ok(sim.trace.some(point => point.x > 1 && point.y < 8), 'never entered and dived from the bank');
    assert.ok(sim.trace.some(point => distance(point) < 4 && Math.abs(point.y - point.owner.y) < 1), 'never reached the owner depth');
    assert.equal(sim.drowningDamage, 0);
});
