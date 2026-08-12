import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import {
    BOAT_MOUNT_RANGE,
    BoatPassengerController,
    isTwoSeatBoat
} from '../src/companion/movement/BoatPassengerController.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';

function entity(id, name, x = 0, y = 64, z = 0) {
    return { id, name, position: new Vec3(x, y, z), passengers: [], vehicle: null };
}

function makeHarness(options = {}) {
    let now = 10_000;
    const botEntity = entity(1, 'player');
    const mountCalls = [];
    const activateEntityCalls = [];
    const lookAtCalls = [];
    const lookCalls = [];
    const interactionPackets = [];
    let dismountCalls = 0;
    let clearControlCalls = 0;
    let moveVehicleCalls = 0;
    const traceLogs = [];
    const bot = {
        entity: botEntity,
        entities: {},
        vehicle: null,
        version: '1.21.6',
        protocolVersion: 771,
        _client: Object.assign(new EventEmitter(), {
            write(name, payload) {
                interactionPackets.push({ name, payload });
            }
        }),
        lookAt(position, force) {
            lookAtCalls.push({ position, force });
        },
        look(yaw, pitch, force) {
            lookCalls.push({ yaw, pitch, force });
        },
        mount(target) {
            mountCalls.push(target);
        },
        activateEntity(target) {
            activateEntityCalls.push(target);
        },
        dismount() {
            dismountCalls += 1;
        },
        clearControlStates() {
            clearControlCalls += 1;
        },
        moveVehicle() {
            moveVehicleCalls += 1;
        }
    };
    const movement = {
        stopCalls: 0,
        stop() {
            this.stopCalls += 1;
        }
    };
    const logger = {
        log(message) { traceLogs.push(message); },
        warn(message) { traceLogs.push(message); }
    };
    const controller = new BoatPassengerController(bot, movement, {
        now: () => now,
        logger,
        ...options
    });
    return {
        bot,
        controller,
        movement,
        mountCalls,
        activateEntityCalls,
        lookAtCalls,
        lookCalls,
        interactionPackets,
        traceLogs,
        get dismountCalls() { return dismountCalls; },
        get clearControlCalls() { return clearControlCalls; },
        get moveVehicleCalls() { return moveVehicleCalls; },
        setNow(value) { now = value; }
    };
}

describe('BoatPassengerController', () => {
    it('accepts only two-seat boats and bamboo rafts', () => {
        assert.equal(isTwoSeatBoat({ name: 'oak_boat' }), true);
        assert.equal(isTwoSeatBoat({ name: 'bamboo_raft' }), true);
        assert.equal(isTwoSeatBoat({ name: 'oak_chest_boat' }), false);
        assert.equal(isTwoSeatBoat({ name: 'bamboo_chest_raft' }), false);
        assert.equal(isTwoSeatBoat({ name: 'minecart' }), false);
    });

    it('boards only after the owner occupies the driver seat', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', BOAT_MOUNT_RANGE, 64, 0);
        owner.vehicle = boat;
        boat.passengers = [owner];

        assert.equal(harness.controller.tryBoard(owner), true);
        assert.deepEqual(harness.activateEntityCalls, []);
        assert.deepEqual(harness.mountCalls, []);
        assert.equal(harness.interactionPackets.length, 2);
        assert.equal(harness.movement.stopCalls, 1);
        assert.equal(harness.clearControlCalls, 1);

        assert.equal(harness.controller.tryBoard(owner), true);
        assert.equal(harness.interactionPackets.length, 2, 'mount requests should be rate-limited');

        harness.setNow(11_001);
        assert.equal(harness.controller.tryBoard(owner), true);
        assert.equal(harness.interactionPackets.length, 4, 'a missing mount confirmation should be retried');
    });

    it('boards at the observed 3.1m center distance when the boat hitbox is in reach', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', 3.1, 64, 0);
        boat.width = 1.375;
        boat.height = 0.5625;
        owner.vehicle = boat;
        boat.passengers = [owner];

        assert.equal(harness.controller.tryBoard(owner), true);
        assert.deepEqual(harness.activateEntityCalls, []);
        assert.deepEqual(harness.mountCalls, []);
        assert.equal(harness.interactionPackets.length, 2);
        assert.ok(harness.traceLogs.some((line) => line.includes('"event":"mount_requested"')));
    });

    it('aims inside the boat hitbox and sends the vanilla two-stage entity interaction', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', 2, 64, 0);
        boat.width = 1.375;
        boat.height = 0.5625;
        owner.vehicle = boat;
        boat.passengers = [owner];

        assert.equal(harness.controller.tryBoard(owner), true);
        assert.deepEqual(harness.lookAtCalls, [{
            position: new Vec3(2, 64 + 0.5625 / 2, 0),
            force: true
        }]);
        assert.deepEqual(harness.interactionPackets, [
            {
                name: 'use_entity',
                payload: {
                    target: boat.id,
                    mouse: 2,
                    x: 0,
                    y: 0.5625 / 2,
                    z: 0,
                    hand: 0,
                    sneaking: false
                }
            },
            {
                name: 'use_entity',
                payload: {
                    target: boat.id,
                    mouse: 0,
                    hand: 0,
                    sneaking: false
                }
            }
        ]);
    });

    it('traces the owner passenger packet and boarding decision without repeating stable state', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', 3.1, 64, 0);
        boat.width = 1.375;
        boat.height = 0.5625;
        owner.vehicle = boat;
        boat.passengers = [owner];
        harness.bot.entities[boat.id] = boat;

        harness.controller.maintain(owner);
        harness.bot._client.emit('set_passengers', {
            entityId: boat.id,
            passengers: [owner.id]
        });
        harness.controller.tryBoard(owner);
        harness.controller.tryBoard(owner);
        boat.position.x = 3.2;
        harness.controller.tryBoard(owner);

        const events = harness.traceLogs.map((line) => JSON.parse(line.slice(line.indexOf('{'))));
        assert.equal(events.filter(({ event }) => event === 'owner_vehicle_seen').length, 1);
        assert.equal(events.filter(({ event }) => event === 'passenger_packet').length, 1);
        assert.equal(events.filter(({ event }) => event === 'boarding_evaluated').length, 1);
        assert.equal(events.filter(({ event }) => event === 'mount_requested').length, 1);
        assert.equal(events.find(({ event }) => event === 'boarding_evaluated').hitboxDistance, 2.634);
    });

    it('releases movement ownership when a mount request is never confirmed', () => {
        const harness = makeHarness({ mountTimeoutMs: 2000 });
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', 2, 64, 0);
        owner.vehicle = boat;
        boat.passengers = [owner];

        assert.equal(harness.controller.tryBoard(owner), true);
        harness.setNow(12_001);

        assert.equal(
            harness.controller.tryBoard(owner),
            false,
            'an unconfirmed request must release FollowMode instead of freezing forever'
        );
        assert.ok(harness.traceLogs.some((line) => line.includes('"event":"mount_timed_out"')));
    });

    it('reconciles an empty passenger packet and clears the stale owner vehicle', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat', 2, 64, 0);
        owner.vehicle = boat;
        boat.passengers = [owner];
        harness.bot.entities[boat.id] = boat;
        harness.controller.maintain(owner);

        harness.bot._client.emit('set_passengers', {
            entityId: boat.id,
            passengers: []
        });

        assert.equal(owner.vehicle, null);
        assert.deepEqual(boat.passengers, []);
        assert.equal(harness.controller.tryBoard(owner), false);
    });

    it('does not board when the owner is not driving, the boat is full, or it is out of reach', () => {
        for (const setup of ['not-driver', 'full', 'far', 'chest']) {
            const harness = makeHarness();
            const owner = entity(7, 'player');
            const other = entity(8, 'player');
            const name = setup === 'chest' ? 'oak_chest_boat' : 'oak_boat';
            const x = setup === 'far' ? BOAT_MOUNT_RANGE + 1 : BOAT_MOUNT_RANGE;
            const boat = entity(20, name, x, 64, 0);
            owner.vehicle = boat;
            boat.passengers = setup === 'not-driver' ? [other, owner]
                : setup === 'full' ? [owner, other]
                    : [owner];

            assert.equal(harness.controller.tryBoard(owner), false, setup);
            assert.equal(harness.mountCalls.length, 0, setup);
            assert.equal(harness.activateEntityCalls.length, 0, setup);
            assert.equal(harness.interactionPackets.length, 0, setup);
        }
    });

    it('holds movement without sending vehicle controls while riding with the owner', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        owner.yaw = 1.25;
        owner.headYaw = -0.75;
        owner.pitch = -0.35;
        const boat = entity(20, 'oak_boat');
        owner.vehicle = boat;
        harness.bot.vehicle = boat;
        boat.passengers = [owner, harness.bot.entity];

        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.movement.stopCalls, 1);
        assert.equal(harness.clearControlCalls, 1);
        assert.equal(harness.moveVehicleCalls, 0);
        assert.deepEqual(harness.lookCalls, [{
            yaw: owner.headYaw,
            pitch: owner.pitch,
            force: true
        }]);
        assert.equal(harness.interactionPackets.length, 1);
        assert.equal(harness.interactionPackets[0].name, 'look');
        assert.ok(Math.abs(harness.interactionPackets[0].payload.yaw - 222.972) < 0.001);
        assert.ok(Math.abs(harness.interactionPackets[0].payload.pitch - 20.054) < 0.001);
        assert.deepEqual(harness.interactionPackets[0].payload.flags, {
            onGround: false,
            hasHorizontalCollision: undefined
        });

        harness.setNow(10_249);
        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.interactionPackets.length, 1, 'stable look should be rate-limited');

        harness.setNow(10_250);
        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.interactionPackets.length, 2, 'stable look should be periodically resent');

        owner.headYaw = 0.5;
        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.interactionPackets.length, 3, 'changed look should be sent immediately');
    });

    it('dismounts and releases control when the owner leaves or the seat order changes', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat');
        owner.vehicle = boat;
        harness.bot.vehicle = boat;
        boat.passengers = [owner, harness.bot.entity];
        assert.equal(harness.controller.maintain(owner), true);

        owner.vehicle = null;
        boat.passengers = [harness.bot.entity];
        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.dismountCalls, 1);

        harness.bot.vehicle = null;
        assert.equal(harness.controller.maintain(owner), false);
        assert.equal(harness.controller.tryBoard(owner), false);

        const reordered = makeHarness();
        owner.vehicle = boat;
        reordered.bot.vehicle = boat;
        boat.passengers = [reordered.bot.entity, owner];
        assert.equal(reordered.controller.maintain(owner), true);
        assert.equal(reordered.dismountCalls, 1);

        const wrongVehicle = makeHarness();
        const minecart = entity(30, 'minecart');
        owner.vehicle = minecart;
        wrongVehicle.bot.vehicle = minecart;
        minecart.passengers = [owner, wrongVehicle.bot.entity];
        assert.equal(wrongVehicle.controller.maintain(owner), true);
        assert.equal(wrongVehicle.dismountCalls, 1);
    });

    it('suppresses ordinary FSM behavior even while the orchestrator is paused', async () => {
        const calls = [];
        const owner = entity(7, 'player');
        const ctx = {
            ownerEntity: owner,
            hazardEscape: { tick: () => false },
            boatPassenger: {
                maintain(currentOwner) {
                    calls.push(['boat', currentOwner]);
                    return true;
                }
            }
        };
        const manager = new CompanionOrchestrator(ctx, {}, [], 'follow');
        manager.targets.paused = true;
        manager.root.activeState.runTick = async () => calls.push(['behavior']);

        await manager.tick();

        assert.deepEqual(calls, [['boat', owner]]);
    });
});
