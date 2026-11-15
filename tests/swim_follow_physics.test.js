import { it } from 'node:test';
import assert from 'node:assert/strict';
import { WaterSimulation, WATER_SCENARIOS } from '../src/simulator/WaterSimulation.js';
import { headInWater, WATER_SPEED } from '../src/companion/movement/waterNavigation.js';
import physicsLoader from 'prismarine-physics';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

it('return-time estimates stay below measured real-physics swim speeds', () => {
    for (const direction of ['up', 'down', 'horizontal']) {
        const sim = new WaterSimulation('deep-dive');
        // Calibration fixture, not a running follow scenario.
        sim.bot.entity.position.set(2.5, -10, 0.5);
        sim.bot.setControlState('jump', direction === 'up');
        sim.bot.setControlState('forward', direction === 'horizontal');
        let before;
        for (let tick = 0; tick < 60; tick++) {
            if (tick === 20) before = sim.bot.entity.position.clone();
            sim.physics.simulatePlayer(new physicsLoader.PlayerState(sim.bot, sim.bot.controlState), sim.world).apply(sim.bot);
        }
        const delta = sim.bot.entity.position.minus(before);
        const measured = (direction === 'horizontal' ? Math.hypot(delta.x, delta.z) : Math.abs(delta.y)) / 2;
        assert.ok(WATER_SPEED[direction] <= measured * 0.85,
            `${direction}: model ${WATER_SPEED[direction]} must leave margin below measured ${measured}`);
    }
});

// Production FSM + real pathfinder at 4 Hz, physics and vanilla air at 20 Hz.
// Never teleport the companion or restore oxygen from the test.
for (const { id } of WATER_SCENARIOS) {
    it(`water E2E: ${id}, 180 seconds of follow / return / recover / resume`, async () => {
        const sim = new WaterSimulation(id);
        await sim.step(3600);
        if (process.env.WATER_REPORT_DIR) {
            await mkdir(process.env.WATER_REPORT_DIR, { recursive: true });
            await writeFile(path.join(process.env.WATER_REPORT_DIR, `${id}.json`), JSON.stringify({
                scenario: id, seconds: sim.tick / 20, minAirTicks: sim.minAir,
                drowningDamage: sim.drowningDamage, returns: sim.returnCount, resumes: sim.resumedCount,
                final: sim.sample(), trace: sim.trace
            }, null, 2));
        }
        assert.equal(sim.drowningDamage, 0, JSON.stringify(sim.trace.slice(-5)));
        assert.ok(sim.minAir >= 30, `air reserve exhausted: ${sim.minAir}`);
        assert.ok(sim.bot.health >= 14);
        assert.ok(sim.returnCount >= 2, 'must exercise independent return trips');
        assert.ok(sim.resumedCount >= 2, 'must resume following after recovery');
        assert.ok(sim.trace.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
        const recoveries = sim.trace.filter(point => point.state === 'hazard_escape');
        assert.ok(recoveries.some(point => point.target && !headInWater(sim.bot, point.target)),
            'return endpoint must be a real breathable coordinate');
        if (id.startsWith('shallow')) {
            assert.ok(sim.bot.entity.position.x >= 22, `stuck before exiting water: ${sim.bot.entity.position}`);
            assert.ok(sim.bot.entity.position.y >= 9.9, 'must climb onto the opposite bank');
            assert.equal(sim.bot.oxygenLevel, 20);
        }
        if (id === 'deep-dive') {
            assert.ok(sim.maxProgress > 15, 'must make horizontal progress toward the moving owner');
            assert.ok(sim.trace.some(point => point.y < 6), 'must actually dive');
            assert.ok(sim.trace.some(point => point.y > 8.5), 'must actually return to air');
        }
        if (id === 'roof-return') {
            assert.ok(sim.trace.some(point => point.y > 8.5 && (point.x < 5 || point.x > 18)),
                'must go around the ceiling');
        }
        if (id === 'low-food') assert.ok(sim.bot.food >= 14);
    });
}

it('water E2E: no food, wait in breathable water instead of resuming an unsafe dive', async () => {
    const sim = new WaterSimulation('low-food', { noFood: true });
    await sim.step(2400);
    assert.equal(sim.drowningDamage, 0);
    assert.equal(sim.bot.food, 5);
    assert.equal(headInWater(sim.bot), false);
    assert.equal(sim.manager.getActiveFsmId(), 'hazard_escape');
});

it('water E2E: changing from follow to wait releases swimming controls', async () => {
    const sim = new WaterSimulation('shallow-one');
    await sim.step(120);
    await sim.manager.switchMode('wait');
    await sim.step(20);
    assert.equal(sim.manager.getCurrentModeId(), 'wait');
    for (const control of ['forward', 'back', 'left', 'right']) {
        assert.equal(sim.bot.controlState[control], false);
    }
});

it('water E2E: seagrass and kelp are swimmable rather than invisible walls', async () => {
    const sim = new WaterSimulation('shallow-one', { waterPlants: true });
    await sim.step(2400);
    assert.equal(sim.drowningDamage, 0);
    assert.ok(sim.bot.entity.position.x >= 22);
});

it('water E2E: unknown chunks do not count as breathable return destinations', async () => {
    const sim = new WaterSimulation('deep-dive', { unloaded: true });
    await sim.step(2400);
    assert.equal(sim.drowningDamage, 0);
    assert.ok(sim.maxProgress < 18);
    assert.ok(sim.trace.every(point => !point.target || point.target.x < 18));
});
