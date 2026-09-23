/**
 * Passage detection against the real MovementController.
 *
 * Both listen on `path_update`, and MovementController is constructed first, so
 * it sees every route before DoorTracker does. These tests pin what it is
 * allowed to do there: it no longer rejects a route over what its doorways look
 * like. Clearing the path used to leave the passage stripped of its pathfinder
 * door action and claimed by nobody, which is a wall, and the bot stood in
 * front of it replanning until something else moved it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { MovementController } from '../src/companion/movement/MovementController.js';
import { DoorTracker } from '../src/companion/movement/DoorTracker.js';

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
    it('lets a crossing route reach the tracker and strips the door action', async () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);

        const result = { status: 'success', path: crossingPath() };
        harness.bot.emit('path_update', result);
        await harness.doors.tick();

        assert.equal(result.path.length, 5, 'movement must not clear a valid route');
        assert.deepEqual(result.path[2].toPlace, [], 'pathfinder never opens the gate itself');
        assert.equal(harness.doors.passageJob?.key, '0,64,0');
        assert.equal(harness.doors.passageJob.intent, 'open');
        assert.equal(harness.activations.length, 0);

        harness.doors.dispose();
    });

    it('keeps a route whose passage geometry cannot be read', async () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: 6 }, 1);

        // A door action on the first node: there is no earlier route point to
        // take an approach side from, and the route never leaves one side.
        const result = {
            status: 'success',
            path: [
                { x: 0, y: 64, z: 3, toPlace: [{ ...GATE_POS, useOne: true }] },
                { x: 0, y: 64, z: 4, toPlace: [] }
            ]
        };
        harness.bot.emit('path_update', result);
        await harness.doors.tick();

        assert.equal(result.path.length, 2, 'the route survives an unreadable doorway');
        assert.equal(harness.movement.isBlocked, false);
        // The action is stripped either way, so the passage has to be handled.
        assert.deepEqual(result.path[0].toPlace, []);
        assert.equal(harness.doors.passageJob?.key, '0,64,0');

        harness.doors.dispose();
    });

    it('keeps its job across the goal reset that a real stop emits', async () => {
        const harness = makeHarness();
        harness.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);
        harness.bot.emit('path_update', { status: 'success', path: crossingPath() });
        await harness.doors.tick();
        assert.equal(harness.doors.passagePending, true);

        // A job outlives every pathfinder reset, including the one the state's
        // own stop-before-activation triggers.
        harness.movement.stop();
        assert.equal(harness.doors.passagePending, true);

        harness.movement.goToward({ x: 0.5, y: 64, z: 1.5 }, 1);
        assert.equal(harness.doors.passagePending, true);
        assert.equal(harness.doors.passageJob.key, '0,64,0');

        harness.doors.dispose();
    });

    it('does not close a gate it opened when the follow route that comes next is emptied', async () => {
        const harness = makeHarness();
        const { bot, doors } = harness;
        // The owner stands on solid ground beyond the gate.
        harness.setBlock('stone', { x: 0, y: 63, z: -6 }, {});
        harness.setBlock('air', { x: 0, y: 64, z: -6 }, {}).boundingBox = 'empty';
        harness.setBlock('air', { x: 0, y: 65, z: -6 }, {}).boundingBox = 'empty';
        const owner = { id: 7, position: new Vec3(0.5, 64, -5.5) };
        harness.movement.followEntity(owner, 1);

        bot.emit('path_update', { status: 'success', path: crossingPath() });
        await doors.tick();
        assert.equal(doors.passageJob?.intent, 'open');

        // Open it the way PassageTransitBehavior does, stop included.
        harness.movement.stop();
        assert.equal(doors.advancePassage().action, 'activate');
        await doors.activatePassage();
        harness.setBlock('oak_fence_gate', GATE_POS, { facing: 'north', open: true });
        assert.equal(doors.advancePassage().action, 'done');
        doors.finishPassage();

        // Follow resumes and replans; A* reports partial first, which movement
        // empties before the tracker ever sees it.
        harness.movement.followEntity(owner, 1);
        const partial = { status: 'partial', path: crossingPath().slice(0, 2) };
        bot.emit('path_update', partial);
        await doors.tick();

        assert.equal(partial.path.length, 0, 'movement still refuses the partial route');
        assert.equal(doors.passagePending, false, 'no close for a gate never walked through');
        assert.deepEqual(doors.neededPassages, ['0,64,0']);

        // A route that does walk through it, then the bot on the far side.
        const route = crossingPath();
        bot.emit('path_update', { status: 'success', path: route });
        await doors.tick();
        assert.equal(doors.passagePending, false);

        bot.entity.position = new Vec3(0.5, 64, -1.5);
        while (route.length && route[0].z + 0.5 >= -1.5) route.shift();
        await doors.tick();

        assert.equal(doors.passageJob?.intent, 'close');
        assert.equal(doors.passageJob.reason, 'crossed');

        doors.dispose();
    });

    it('gives a route drawn from the closing stand point back to the tracker', async () => {
        const harness = makeHarness();
        harness.setBlock('oak_fence_gate', GATE_POS, { facing: 'north', open: true });
        // Where a close leaves the bot: squarely out from the doorway, not
        // offset along the fence where no route point can describe the crossing.
        harness.bot.entity.position = new Vec3(0.5, 64, -1.75);
        harness.movement.goToward({ x: 0.5, y: 64, z: 4 }, 1);

        const result = {
            status: 'success',
            path: [
                { x: 0, y: 64, z: -1, toPlace: [] },
                { x: 0, y: 64, z: 0, toPlace: [] },
                { x: 0, y: 64, z: 1, toPlace: [] },
                { x: 0, y: 64, z: 3, toPlace: [] }
            ]
        };
        harness.bot.emit('path_update', result);
        await harness.doors.tick();

        assert.equal(result.path.length, 4, 'the route back through the gate stands');
        assert.equal(harness.movement.isBlocked, false);

        harness.doors.dispose();
    });
});
