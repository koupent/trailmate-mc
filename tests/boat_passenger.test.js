import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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

function makeHarness() {
    let now = 10_000;
    const botEntity = entity(1, 'player');
    const mountCalls = [];
    let dismountCalls = 0;
    let clearControlCalls = 0;
    let moveVehicleCalls = 0;
    const bot = {
        entity: botEntity,
        vehicle: null,
        mount(target) {
            mountCalls.push(target);
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
    const controller = new BoatPassengerController(bot, movement, { now: () => now });
    return {
        bot,
        controller,
        movement,
        mountCalls,
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
        assert.deepEqual(harness.mountCalls, [boat]);
        assert.equal(harness.movement.stopCalls, 1);
        assert.equal(harness.clearControlCalls, 1);

        assert.equal(harness.controller.tryBoard(owner), true);
        assert.equal(harness.mountCalls.length, 1, 'mount requests should be rate-limited');

        harness.setNow(11_001);
        assert.equal(harness.controller.tryBoard(owner), true);
        assert.equal(harness.mountCalls.length, 2, 'a missing mount confirmation should be retried');
    });

    it('does not board when the owner is not driving, the boat is full, or it is out of reach', () => {
        for (const setup of ['not-driver', 'full', 'far', 'chest']) {
            const harness = makeHarness();
            const owner = entity(7, 'player');
            const other = entity(8, 'player');
            const name = setup === 'chest' ? 'oak_chest_boat' : 'oak_boat';
            const x = setup === 'far' ? BOAT_MOUNT_RANGE + 0.01 : BOAT_MOUNT_RANGE;
            const boat = entity(20, name, x, 64, 0);
            owner.vehicle = boat;
            boat.passengers = setup === 'not-driver' ? [other, owner]
                : setup === 'full' ? [owner, other]
                    : [owner];

            assert.equal(harness.controller.tryBoard(owner), false, setup);
            assert.equal(harness.mountCalls.length, 0, setup);
        }
    });

    it('holds movement without sending vehicle controls while riding with the owner', () => {
        const harness = makeHarness();
        const owner = entity(7, 'player');
        const boat = entity(20, 'oak_boat');
        owner.vehicle = boat;
        harness.bot.vehicle = boat;
        boat.passengers = [owner, harness.bot.entity];

        assert.equal(harness.controller.maintain(owner), true);
        assert.equal(harness.movement.stopCalls, 1);
        assert.equal(harness.clearControlCalls, 1);
        assert.equal(harness.moveVehicleCalls, 0);
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
