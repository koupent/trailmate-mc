/**
 * The passage model against the real mineflayer-pathfinder.
 *
 * Everything else in the passage tests feeds DoorTracker routes shaped by hand.
 * That proves the model is self-consistent, not that it matches the library, and
 * the model leans on two things only mineflayer-pathfinder can decide:
 *
 *   1. a `useOne` door action rides on the path node that IS the passage block
 *   2. the bot reaches that node, and only then is the passage behind it
 *
 * Together they are what lets "the route no longer goes through it" stand in for
 * "the bot has been through it". If a library upgrade moves the door action to
 * the node before the doorway, every hand-shaped test still passes while the
 * companion quietly stops closing gates behind itself. This is that alarm.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pf from 'mineflayer-pathfinder';
import { createSafeMovements } from '../src/companion/blockProtection.js';
import { analyzePassageRoute, routeEntersPassage } from '../src/companion/movement/passageRoute.js';
import { DoorTracker } from '../src/companion/movement/DoorTracker.js';

const VERSION = '1.21.4';
const registry = minecraftData(VERSION);
const Block = prismarineBlock(registry);

const GROUND_Y = 63;
const FEET_Y = 64;
/** Two fence lines across a corridor, each broken by a single gate at x = 0. */
const GATE_A = { x: 0, y: FEET_Y, z: 0 };
const GATE_B = { x: 0, y: FEET_Y, z: -6 };

/** The block state id whose properties match, so gates really are closed. */
function stateId(name, props) {
    const def = registry.blocksByName[name];
    assert.ok(def, `unknown block ${name}`);
    if (!props) return def.minStateId;
    for (let id = def.minStateId; id <= def.maxStateId; id++) {
        const actual = Block.fromStateId(id, 0)._properties || {};
        const matches = Object.entries(props)
            .every(([key, value]) => String(actual[key]) === String(value));
        if (matches) return id;
    }
    assert.fail(`no state of ${name} matches ${JSON.stringify(props)}`);
}

/** A real voxel world: state ids read back through real prismarine-block. */
function makeWorld() {
    const states = new Map();
    const at = (pos) => `${pos.x},${pos.y},${pos.z}`;
    const set = (pos, name, props) => states.set(at(pos), stateId(name, props));

    for (let x = -8; x <= 8; x++) {
        for (let z = -12; z <= 8; z++) set({ x, y: GROUND_Y, z }, 'stone');
    }
    for (const z of [GATE_A.z, GATE_B.z]) {
        for (let x = -6; x <= 6; x++) {
            if (x === 0) continue;
            set({ x, y: FEET_Y, z }, 'oak_fence');
            set({ x, y: FEET_Y + 1, z }, 'oak_fence');
        }
    }
    set(GATE_A, 'oak_fence_gate', { facing: 'north', open: 'false' });
    set(GATE_B, 'oak_fence_gate', { facing: 'north', open: 'false' });

    return {
        blockAt(pos) {
            const floored = {
                x: Math.floor(pos.x),
                y: Math.floor(pos.y),
                z: Math.floor(pos.z)
            };
            const block = Block.fromStateId(states.get(at(floored)) ?? stateId('air'), 0);
            block.position = new Vec3(floored.x, floored.y, floored.z);
            return block;
        },
        isGateOpen(pos) {
            return this.blockAt(pos)._properties?.open === true;
        },
        toggleGate(pos) {
            set(pos, 'oak_fence_gate', {
                facing: 'north',
                open: String(!this.isGateOpen(pos))
            });
        }
    };
}

function makeBot(world, startZ) {
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.version = VERSION;
    bot.entity = { position: new Vec3(0.5, FEET_Y, startZ), height: 1.8, onGround: true };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null, getBlock: (pos) => world.blockAt(pos) };
    bot.blockAt = (pos) => world.blockAt(pos);
    bot.entities = {};
    bot.inventory = { items: () => [], slots: [] };
    bot.canDigBlock = () => false;
    bot.activateBlock = async (block) => world.toggleGate(block.position);
    return bot;
}

/**
 * Real A* over the real Movements this project installs. A* yields `partial`
 * whenever it runs past its per-tick budget, and mineflayer-pathfinder resumes
 * the same context until it settles; do the same rather than race a timer.
 */
function planRoute(bot, movements, targetZ) {
    const from = bot.entity.position.floored();
    const start = new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
    const context = new AStar(
        start,
        movements,
        new pf.goals.GoalNear(0, FEET_Y, targetZ, 1),
        10_000,
        40,
        -1
    );
    let result = context.compute();
    for (let resumes = 0; result.status === 'partial' && resumes < 20; resumes++) {
        result = context.compute();
    }
    return result;
}

describe('passage model against the real pathfinder', () => {
    it('puts every door action on the node that is the passage itself', () => {
        const world = makeWorld();
        const bot = makeBot(world, 4.5);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(bot, movements, -9);
        assert.equal(result.status, 'success');

        const actions = result.path.flatMap((node) => (node.toPlace || [])
            .filter((action) => action.useOne)
            .map((action) => ({ node, action })));
        assert.equal(actions.length, 2, 'both gates need opening');

        for (const { node, action } of actions) {
            assert.equal(Math.floor(node.x), action.x);
            assert.equal(Math.floor(node.z), action.z);
            assert.ok(
                Math.abs(Math.floor(node.y) - action.y) <= 1,
                'the door action and its node share a doorway'
            );
        }
    });

    it('reads both gates off a real route, with a stand point A* proved reachable', () => {
        const world = makeWorld();
        const bot = makeBot(world, 4.5);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(bot, movements, -9);
        const plans = analyzePassageRoute(bot, result.path, bot.entity.position);

        assert.deepEqual([...plans.keys()].sort(), ['0,64,-6', '0,64,0']);
        for (const plan of plans.values()) {
            assert.equal(plan.onPath, true);
            assert.equal(plan.approachSide, 1, 'approached from the +z side');
            // One block short of the doorway, on the route, so walking to it
            // never means stepping through the gate first.
            assert.equal(plan.approachPoint.z, plan.passagePos.z + 1.5);
        }
    });

    it('stops reporting a gate as needed exactly when the bot reaches it', () => {
        const world = makeWorld();
        const bot = makeBot(world, 4.5);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        // mineflayer-pathfinder shifts each node off this array on arrival; the
        // tracker holds the same array and reads what is left.
        const live = planRoute(bot, movements, -9).path;
        const neededUntil = { a: 0, b: 0 };
        for (let walked = 0; live.length; walked++) {
            if (routeEntersPassage(live, GATE_A)) neededUntil.a = walked;
            if (routeEntersPassage(live, GATE_B)) neededUntil.b = walked;
            live.shift();
        }

        // The gate stays needed right up to the step that enters its doorway,
        // and is behind the bot from the next one on. Anything earlier would
        // shut a gate in the bot's own face.
        assert.equal(neededUntil.a, 3, 'gate A is needed until its own node');
        assert.equal(neededUntil.b, 9, 'gate B is needed until its own node');
    });

    it('opens and closes two real gates in order, without ever turning back', async () => {
        const world = makeWorld();
        const bot = makeBot(world, 4.5);
        const movements = createSafeMovements(bot, { allowSprinting: false });
        let clock = 100_000;
        const doors = new DoorTracker(bot, { getOwnerEntity: () => null, now: () => clock });

        const done = [];
        const track = [bot.entity.position.z];
        let live = [];
        const originalLog = console.log;
        console.log = (line) => {
            const match = /passage (open|close) done at (\S+)/.exec(String(line));
            if (match) done.push(`${match[1]} ${match[2]}`);
        };

        /** Replan with the real A*, and hand the route to the tracker. */
        const planTo = (targetZ) => {
            const result = planRoute(bot, movements, targetZ);
            if (result.status !== 'success' && result.status !== 'partial') return;
            live = result.path;
            bot.emit('path_update', { status: result.status, path: result.path });
        };

        /** Walk one node. A closed gate simply refuses to let the bot in. */
        const stepAlong = () => {
            const next = live[0];
            if (!next) return;
            const block = bot.blockAt(new Vec3(next.x, next.y, next.z));
            if (block.name.endsWith('fence_gate') && block._properties?.open !== true) return;
            bot.entity.position = new Vec3(next.x + 0.5, next.y, next.z + 0.5);
            live.shift();
            track.push(bot.entity.position.z);
        };

        try {
            for (let tick = 0; tick < 60; tick++) {
                clock += 250;
                await doors.tick();

                if (doors.passagePending) {
                    doors.resumePassage();
                    const step = doors.advancePassage();
                    if (step.action === 'move') {
                        planTo(step.target.z);
                        stepAlong();
                    } else if (step.action === 'activate') {
                        await doors.activatePassage();
                    } else if (step.action === 'done') {
                        doors.finishPassage();
                    } else if (step.action === 'fail') {
                        assert.fail(`unexpected failure: ${step.reason}`);
                    }
                    continue;
                }

                doors.suspendPassage();
                planTo(-9);
                stepAlong();
                // Past both walls with nothing left owing.
                if (bot.entity.position.z <= -7.5
                    && !world.isGateOpen(GATE_A)
                    && !world.isGateOpen(GATE_B)) {
                    break;
                }
            }
        } finally {
            console.log = originalLog;
            doors.dispose();
        }

        // The reported failure was: open A, walk to B, turn back for A, shut B
        // on the way. Each gate is now shut before the next one is opened.
        assert.deepEqual(done, [
            'open 0,64,0',
            'close 0,64,0',
            'open 0,64,-6',
            'close 0,64,-6'
        ]);
        assert.equal(world.isGateOpen(GATE_A), false);
        assert.equal(world.isGateOpen(GATE_B), false);

        const backwards = track.filter((z, i) => i > 0 && z > track[i - 1]);
        assert.deepEqual(backwards, [], `walked backwards to ${backwards.join(', ')}`);
    });
});
