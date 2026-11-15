import { it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import injectPhysics from 'mineflayer/lib/plugins/physics.js';
import { WaterSimulation } from '../src/simulator/WaterSimulation.js';
import { installMovementPacketLimiter } from '../src/host/movementPackets.js';

it('real Mineflayer physics/control/packet pipeline dives and follows a moving owner', async t => {
    let clock = 0;
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
    t.mock.method(performance, 'now', () => clock);
    const sim = new WaterSimulation('underwater-turns', {
        initialBotPosition: [8.5, 9, 0.5],
        ownerMotion: seconds => ({ x: Math.min(18, 12 + seconds * 0.3), y: 7, z: 0.5 })
    });
    const bot = sim.bot;
    const packets = [];
    bot.entity.eyeHeight = 1.62;
    bot.isAlive = true;
    bot._client = Object.assign(new EventEmitter(), {
        write(name, data) { packets.push({ name, data: structuredClone(data) }); }
    });
    injectPhysics(bot, {});
    installMovementPacketLimiter(bot);
    t.after(() => bot.emit('end'));
    bot.emit('login');
    bot._client.emit('position', { x: 8.5, y: 9, z: 0.5, yaw: 90, pitch: 0, flags: {}, teleportId: 1 });
    let minimumY = 9;
    for (let tick = 0; tick < 600; tick++) {
        sim.moveOwner();
        if (tick % 5 === 0) {
            await sim.manager.tick();
            await sim.eyeContact.tick(sim.ctx);
        }
        clock += 50;
        t.mock.timers.tick(50);
        sim.tick++;
        sim.stepVitals();
        minimumY = Math.min(minimumY, bot.entity.position.y);
    }
    assert.ok(minimumY < 7.8, `never dived in actual Mineflayer physics: minY=${minimumY}`);
    assert.equal(sim.drowningDamage, 0);
    const positions = packets.filter(packet => ['position', 'position_look'].includes(packet.name));
    assert.ok(positions.some(packet => packet.data.y < 7.8), 'server must receive the dive, not only local physics');
    assert.ok(positions.some(packet => packet.data.x > 13), 'server must receive horizontal movement');
    assert.ok(positions.every(packet => Number.isFinite(packet.data.x) && Number.isFinite(packet.data.y)));
    const diagnostics = bot._trailmateMovementDiagnostics.snapshot();
    assert.equal(diagnostics.physicsEnabled, true);
    assert.ok(diagnostics.physicsTicks >= 590);
    assert.ok(diagnostics.physicsAgeMs <= 50);
    assert.ok(diagnostics.positionPacketAgeMs <= 1000);
});
