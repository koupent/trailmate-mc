import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createMovementPacketLimiter } from '../src/host/movementPackets.js';

it('delivers queued water movement even if a look packet arrives before the flush', () => {
    let time = 0;
    const sent = [];
    const limiter = createMovementPacketLimiter((name, data) => sent.push({ name, data }), { now: () => time });
    limiter.write('position', { x: 0, y: 9, z: 0, onGround: false });
    time = 10;
    limiter.write('position', { x: 1, y: 8.9, z: 0, onGround: false });
    time = 20;
    limiter.write('look', { yaw: 90, pitch: 30, onGround: false });
    time = 50;
    limiter.flush();
    assert.deepEqual(sent.at(-1), { name: 'position_look', data: { x: 1, y: 8.9, z: 0, yaw: 90, pitch: 30, onGround: false } });
});

it('does not send an older queued position after a newer immediate update', () => {
    let time = 0;
    const xs = [];
    const limiter = createMovementPacketLimiter((_name, data) => xs.push(data.x), { now: () => time });
    limiter.write('position', { x: 0, y: 0, z: 0 });
    time = 10; limiter.write('position', { x: 1, y: 0, z: 0 });
    time = 50; limiter.write('position', { x: 2, y: 0, z: 0 });
    limiter.flush();
    assert.deepEqual(xs, [0, 2]);
});

it('copies Mineflayer shared packet data and preserves teleport acknowledgements', () => {
    let time = 0;
    const sent = [];
    const limiter = createMovementPacketLimiter((name, data) => sent.push({ name, data }), { now: () => time });
    limiter.write('position', { x: 0, y: 0, z: 0 });
    time = 1;
    const shared = { x: 1, y: 2, z: 3, flags: { onGround: false } };
    limiter.write('position', shared);
    shared.x = 99; shared.flags.onGround = true;
    limiter.write('teleport_confirm', { teleportId: 42 });
    time = 50; limiter.flush();
    assert.equal(sent.at(-1).data.x, 1);
    assert.equal(sent.at(-1).data.flags.onGround, false);
    assert.ok(sent.some(packet => packet.name === 'teleport_confirm' && packet.data.teleportId === 42));
});

it('a timer flush cannot send a second movement update inside the throttle window', () => {
    let time = 0;
    const times = [];
    const limiter = createMovementPacketLimiter(() => times.push(time), { now: () => time });
    limiter.write('position', { x: 0, y: 9, z: 0 });
    time = 1; limiter.write('look', { yaw: 90, pitch: 0 });
    time = 2; limiter.flush();
    assert.deepEqual(times, [0]);
    time = 50; limiter.flush();
    assert.deepEqual(times, [0, 50]);
});
