/**
 * Passage detection against the real MovementController.
 *
 * Both listen on `path_update`, and MovementController is constructed first,
 * so it may clear a route before DoorTracker ever sees it. These tests pin the
 * production wiring: which routes reach the tracker, and which pathfinder
 * events may drop an acquired transaction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { MovementController } from '../src/companion/movement/MovementController.js';
import { DoorTracker, PASSAGE_STAGE } from '../src/companion/movement/DoorTracker.js';

const GATE_POS = { x: 0, y: 64, z: 0 };

function makeHarness() {
    const now = 10_000;
    const blocks = new Map();
    const activations = [];

    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = { position: new Vec3(0.5, 64, 3.5), height: 1.8, onGround: true };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null };
    bot.blockAt = (pos) => blocks.get(
        `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    ) || null;
    bot.activateBlock = (block) => {
        activations.push(block);
        return Promise.resolve();
    };
    // Mirror mineflayer-pathfinder: setGoal announces the goal, then resets the path.
    bot.pathfinder = {
        goal: null,
        movements: null,
        setMovements(movements) { this.movements = movements; },
        setGoal(goal) {
            this.goal = goal;
            bot.emit('goal_updated', goal);
            bot.emit('path_reset', 'goal_updated');
        },
        isMoving() { return false; }
    };

    const setBlock = (name, pos, props) => {
        const block = {
            name,
            position: new Vec3(pos.x, pos.y, pos.z),
            boundingBox: 'block',
            _properties: { ...props }
        };
        blocks.set(`${pos.x},${pos.y},${pos.z}`, block);
        return block;
    };
    setBlock('oak_fence_gate', GATE_POS, { facing: 'north', open: false });

    // Same construction order as CompanionContext: movement first, doors second.
    const movement = new MovementController(bot, { now: () => now });
    const doors = new DoorTracker(bot, { getOwnerEntity: () => null, now: () => now });

    return { bot, movement, doors, activations, setBlock };
}

/** Corridor route from +z to -z, with the door action pathfinder emits. */
function crossingPath() {
    return [
        { x: 0, y: 64, z: 2, toPlace: [] },
        { x: 0, y: 64, z: 1, toPlace: [] },
        { x: 0, y: 64, z: 0, toPlace: [{ ...GATE_POS, useOne: true }] },
        { x: 0, y: 64, z: -1, toPlace: [] },
        { x: 0, y: 64, z: -2, toPlace: [] }
    ];
}

describe('passage detection with the real MovementController', () => {
    it('lets a valid crossing route reach the tracker and strips the door action', () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);

        const result = { status: 'success', path: crossingPath() };
        harness.bot.emit('path_update', result);

        assert.equal(result.path.length, 5, 'movement must not clear a valid route');
        assert.deepEqual(result.path[2].toPlace, [], 'pathfinder never opens the gate itself');
        assert.equal(harness.doors.passageTransaction?.key, '0,64,0');
        assert.equal(harness.doors.passageTransaction.stage, PASSAGE_STAGE.approach);
        assert.equal(harness.activations.length, 0);

        harness.doors.dispose();
    });

    it('requests nothing when movement rejects the route as no real crossing', () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: 6 }, 1);

        // A door action on a route that stays on one side of the gate.
        const result = {
            status: 'success',
            path: [
                { x: 0, y: 64, z: 2, toPlace: [] },
                { x: 0, y: 64, z: 3, toPlace: [{ ...GATE_POS, useOne: true }] },
                { x: 0, y: 64, z: 4, toPlace: [] }
            ]
        };
        harness.bot.emit('path_update', result);

        assert.deepEqual(result.path, [], 'movement clears an invalid passage route');
        assert.equal(harness.doors.passagePending, false);
        assert.equal(harness.movement.isBlocked, true);

        harness.doors.dispose();
    });

    it('drops an unclaimed candidate on the goal reset a real stop emits', () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);
        harness.bot.emit('path_update', { status: 'success', path: crossingPath() });
        assert.equal(harness.doors.passagePending, true);

        harness.movement.stop();

        assert.equal(harness.doors.passagePending, false);
        harness.doors.dispose();
    });

    it('keeps an acquired transaction through the same real stop', () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);
        harness.bot.emit('path_update', { status: 'success', path: crossingPath() });

        // syncPassageTransit acquires before it stops ordinary movement.
        harness.doors.claimPassage();
        harness.movement.stop();

        assert.equal(harness.doors.passagePending, true);
        assert.equal(harness.doors.passageTransaction.key, '0,64,0');

        // The state's own goals reset the pathfinder repeatedly, too.
        harness.movement.goToward({ x: 0.5, y: 64, z: 1.5 }, 1);
        assert.equal(harness.doors.passagePending, true);

        harness.doors.dispose();
    });
});
