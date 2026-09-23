/**
 * An owner the companion cannot walk to, against the real mineflayer-pathfinder.
 *
 * The companion never places blocks while walking, so `scafoldingBlocks` is
 * empty and A* starts with zero blocks to place. The library only stops a
 * placement when that count is exactly 0 or 1, and a door action is counted as
 * a placement too. One closed door or gate on the way drove the count to -1,
 * and from there every bridge and tower looked affordable: A* reported routes
 * to owners on pillars and ledges that could only be reached by building.
 *
 * Opening the gate took the door action off the route, the count stayed at 0,
 * the route vanished, the gate was owed a close, and closing it brought the
 * route back. Hand-shaped routes cannot show that; only the real A* over the
 * real Movements can.
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
import prismarineIterators from 'prismarine-world/src/iterators.js';
import { createSafeMovements } from '../src/companion/blockProtection.js';
import { MovementController } from '../src/companion/movement/MovementController.js';
import { DoorTracker } from '../src/companion/movement/DoorTracker.js';
import { resolveFollowPhase } from '../src/companion/movement/followPhase.js';
import { FOLLOW_GOAL_RANGE } from '../src/companion/movement/followConstants.js';
import { PassageTransitBehavior } from '../src/companion/stateMachine/behaviors/PassageTransitBehavior.js';

const { RaycastIterator } = prismarineIterators;

const VERSION = '1.21.4';
const registry = minecraftData(VERSION);
const Block = prismarineBlock(registry);

const GROUND_Y = 63;
const FEET_Y = 64;
const MIN_X = -8;
const MAX_X = 8;
const MIN_Z = -12;
const MAX_Z = 8;
/** A fence line across the whole field, broken by one passage at x = 0. */
const PASSAGE = { x: 0, y: FEET_Y, z: 0 };

/** The block state id whose properties match, so passages really are closed. */
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

/**
 * A real voxel world: a stone field split by a fence at z = 0. The only way
 * from the south half (z > 0) to the north half is the passage at x = 0.
 * @param {{ passage?: 'gate'|'door'|null, pillars?: Array<{ x: number, z: number, height: number }> }} [options]
 */
function makeWorld({ passage = 'gate', pillars = [] } = {}) {
    const states = new Map();
    const at = (pos) => `${pos.x},${pos.y},${pos.z}`;
    const set = (pos, name, props) => states.set(at(pos), stateId(name, props));

    for (let x = MIN_X; x <= MAX_X; x++) {
        for (let z = MIN_Z; z <= MAX_Z; z++) set({ x, y: GROUND_Y, z }, 'stone');
    }
    for (let x = MIN_X; x <= MAX_X; x++) {
        if (x === PASSAGE.x && passage) continue;
        set({ x, y: FEET_Y, z: PASSAGE.z }, 'oak_fence');
        set({ x, y: FEET_Y + 1, z: PASSAGE.z }, 'oak_fence');
    }
    for (const pillar of pillars) {
        for (let dy = 0; dy < pillar.height; dy++) {
            set({ x: pillar.x, y: FEET_Y + dy, z: pillar.z }, 'stone');
        }
    }

    const passageState = (open) => {
        if (passage === 'gate') {
            set(PASSAGE, 'oak_fence_gate', { facing: 'north', open: String(open) });
        } else if (passage === 'door') {
            const door = { facing: 'north', hinge: 'left', open: String(open), powered: 'false' };
            set(PASSAGE, 'oak_door', { ...door, half: 'lower' });
            set({ ...PASSAGE, y: PASSAGE.y + 1 }, 'oak_door', { ...door, half: 'upper' });
        }
    };
    passageState(false);

    // A* reads every cell many times per search. Building a fresh block each
    // time made the closed-loop runs take seconds; a cell only gets a new
    // block when its state changes, exactly as a real passage toggle does.
    const AIR = stateId('air');
    const blocks = new Map();

    return {
        blockAt(pos) {
            const floored = {
                x: Math.floor(pos.x),
                y: Math.floor(pos.y),
                z: Math.floor(pos.z)
            };
            const id = states.get(at(floored)) ?? AIR;
            const cacheKey = `${at(floored)}:${id}`;
            let block = blocks.get(cacheKey);
            if (!block) {
                block = Block.fromStateId(id, 0);
                block.position = new Vec3(floored.x, floored.y, floored.z);
                blocks.set(cacheKey, block);
            }
            return block;
        },
        passage,
        isPassageOpen() {
            return this.blockAt(PASSAGE)._properties?.open === true;
        },
        setPassageOpen(open) {
            passageState(open);
        }
    };
}

function makeBot(world, start) {
    return {
        registry,
        version: VERSION,
        entity: { position: new Vec3(start.x, start.y, start.z), height: 1.8, onGround: true },
        game: { minY: -64, dimension: 'overworld' },
        world: { raycast: () => null, getBlock: (pos) => world.blockAt(pos) },
        blockAt: (pos) => world.blockAt(pos),
        entities: {},
        inventory: { items: () => [], slots: [] },
        canDigBlock: () => false
    };
}

/**
 * Real A* over the real Movements this project installs, resumed until it
 * settles the way mineflayer-pathfinder resumes a `partial` context.
 */
function planRoute(bot, movements, goal) {
    const from = bot.entity.position.floored();
    const start = new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
    const context = new AStar(start, movements, goal, 10_000, 40, -1);
    let result = context.compute();
    for (let resumes = 0; result.status === 'partial' && resumes < 50; resumes++) {
        result = context.compute();
    }
    return result;
}

function placements(path) {
    return path.flatMap((node) => (node.toPlace || []).filter((action) => !action.useOne));
}

function doorActions(path) {
    return path.flatMap((node) => (node.toPlace || [])
        .filter((action) => action.useOne)
        .map((action) => ({ node, action })));
}

describe('owner out of walking reach, against the real pathfinder', () => {
    it('finds no route to an owner on a pillar behind a closed gate', () => {
        const world = makeWorld({ pillars: [{ x: 0, z: -3, height: 2 }] });
        const bot = makeBot(world, { x: 0.5, y: FEET_Y, z: 4.5 });
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(bot, movements, new pf.goals.GoalNear(0, FEET_Y + 2, -3, 1));

        assert.notEqual(result.status, 'success', 'the pillar top is only reachable by building');
        assert.deepEqual(placements(result.path), []);
    });

    it('does not route through an unrelated gate to reach an owner on a pillar', () => {
        const world = makeWorld({ pillars: [{ x: 4, z: 5, height: 2 }] });
        const bot = makeBot(world, { x: 0.5, y: FEET_Y, z: 5.5 });
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(bot, movements, new pf.goals.GoalNear(4, FEET_Y + 2, 5, 1));

        assert.notEqual(result.status, 'success', 'the pillar top is only reachable by building');
        assert.deepEqual(placements(result.path), []);
        assert.deepEqual(doorActions(result.path), [], 'the gate has nothing to do with this owner');
    });

    for (const passage of ['gate', 'door']) {
        it(`still opens a closed ${passage} for an owner standing just past it`, () => {
            const world = makeWorld({ passage });
            const bot = makeBot(world, { x: 0.5, y: FEET_Y, z: 4.5 });
            const movements = createSafeMovements(bot, { allowSprinting: false });

            const result = planRoute(bot, movements, new pf.goals.GoalNear(0, FEET_Y, -3, 1));

            assert.equal(result.status, 'success');
            assert.deepEqual(placements(result.path), []);
            const actions = doorActions(result.path);
            assert.equal(actions.length, 1, `the ${passage} is opened exactly once`);
            const [{ node, action }] = actions;
            assert.deepEqual(
                { x: action.x, y: action.y, z: action.z },
                PASSAGE,
                `the action targets the ${passage}`
            );
            assert.equal(Math.floor(node.z), PASSAGE.z, 'on the node that is the passage');
        });
    }
});

/** One companion tick. */
const TICK_MS = 250;
/** mineflayer-pathfinder resets a route that makes no progress for 3.5 s. */
const STUCK_TICKS = 14;

/**
 * A synchronous `world.raycast` over the voxel world, the way prismarine-world's
 * WorldSync walks it: real block shapes, so a closed gate blocks the view and
 * an open one does not.
 */
function raycastThrough(world) {
    return (from, direction, range) => {
        const iter = new RaycastIterator(from, direction, range);
        let pos = from;
        while (pos) {
            const position = new Vec3(pos.x, pos.y, pos.z);
            const block = world.blockAt(position);
            if (block && iter.intersect(block.shapes, position)) return block;
            pos = iter.next();
        }
        return null;
    };
}

/**
 * Just enough of mineflayer-pathfinder to walk a route: a goal is planned with
 * the real A* once, the route is walked by shifting one node off the very
 * array `path_update` handed out, a closed passage refuses to let the bot in,
 * and a route that stops making progress is reset and planned again.
 */
function installPathfinder(bot) {
    let goal = null;
    let dynamic = false;
    let movements = null;
    let path = [];
    let planned = false;
    let stuckTicks = 0;

    const reset = () => {
        path = [];
        planned = false;
        stuckTicks = 0;
    };

    bot.pathfinder = {
        get goal() {
            return goal;
        },
        get movements() {
            return movements;
        },
        setMovements(next) {
            movements = next;
            reset();
        },
        setGoal(next, isDynamic = false) {
            goal = next;
            dynamic = isDynamic;
            reset();
        },
        isMoving() {
            return path.length > 0;
        },
        tick() {
            if (!goal || !movements) return;
            if (path.length === 0) {
                if (planned || goal.isEnd(bot.entity.position.floored())) return;
                const result = planRoute(bot, movements, goal);
                assert.deepEqual(placements(result.path), [], 'a planned route places blocks');
                bot.emit('path_update', result);
                path = result.path;
                planned = true;
                return;
            }

            const next = path[0];
            const cell = bot.blockAt(new Vec3(next.x, next.y, next.z));
            if (/door|fence_gate/.test(cell.name) && cell._properties?.open !== true) {
                stuckTicks += 1;
                if (stuckTicks >= STUCK_TICKS) reset();
                return;
            }
            stuckTicks = 0;
            bot.entity.position = new Vec3(
                Number.isInteger(next.x) ? next.x + 0.5 : next.x,
                next.y,
                Number.isInteger(next.z) ? next.z + 0.5 : next.z
            );
            path.shift();
            if (path.length === 0 && !dynamic && goal.isEnd(bot.entity.position.floored())) {
                const reached = goal;
                goal = null;
                bot.emit('goal_reached', reached);
            }
        }
    };
}

/**
 * The companion's follow loop with every real piece that decides about doors:
 * MovementController, DoorTracker, resolveFollowPhase and passage_transit.
 */
function makeCompanion(world, { bot: botStart, owner: ownerStart }) {
    let clock = 100_000;
    const now = () => clock;

    const bot = new EventEmitter();
    bot.registry = registry;
    bot.version = VERSION;
    bot.entity = {
        position: new Vec3(botStart.x, botStart.y, botStart.z),
        height: 1.8,
        onGround: true
    };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: raycastThrough(world), getBlock: (pos) => world.blockAt(pos) };
    bot.blockAt = (pos) => world.blockAt(pos);
    bot.entities = {};
    bot.inventory = { items: () => [], slots: [] };
    bot.canDigBlock = () => false;
    /** @type {Array<'open'|'close'>} */
    const activations = [];
    bot.activateBlock = async () => {
        const before = world.blockAt(PASSAGE);
        world.setPassageOpen(!world.isPassageOpen());
        activations.push(world.isPassageOpen() ? 'open' : 'close');
        bot.emit('blockUpdate', before, world.blockAt(PASSAGE));
    };
    installPathfinder(bot);

    const owner = {
        id: 7,
        username: 'owner',
        position: new Vec3(ownerStart.x, ownerStart.y, ownerStart.z),
        height: 1.8,
        yaw: 0
    };
    const movement = new MovementController(bot, { now });
    const doors = new DoorTracker(bot, { getOwnerEntity: () => owner, now });
    const ctx = { bot, config: { follow_distance: 3 }, movement, doors };
    const transit = new PassageTransitBehavior({ ctx, paused: false });
    let inTransit = false;

    return {
        bot,
        activations,
        moveOwner(pos) {
            owner.position = new Vec3(pos.x, pos.y, pos.z);
        },
        async run(ticks) {
            for (let tick = 0; tick < ticks; tick++) {
                clock += TICK_MS;
                await doors.tick();

                if (doors.passagePending) {
                    if (!inTransit) transit.onStateEntered();
                    inTransit = true;
                    await transit.runTick();
                } else {
                    if (inTransit) transit.onStateExited();
                    inTransit = false;
                    // FollowMode's own tail once nothing else claims the tick.
                    if (resolveFollowPhase(ctx, owner) === 'near') {
                        movement.stop();
                    } else {
                        movement.followEntity(owner, FOLLOW_GOAL_RANGE, {
                            endpointVisibilityTarget: owner
                        });
                    }
                }
                bot.pathfinder.tick();
            }
        },
        dispose() {
            doors.dispose();
        }
    };
}

/** Run with the tracker's log silenced, returning the jobs it finished. */
async function collectPassageLog(fn) {
    const done = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (line) => {
        const match = /passage (open|close) done at (\S+)/.exec(String(line));
        if (match) done.push(`${match[1]} ${match[2]}`);
    };
    console.warn = () => {};
    try {
        await fn();
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
    }
    return done;
}

describe('follow loop with an owner out of walking reach', () => {
    it('waits at the last reachable spot instead of working a nearby gate', async () => {
        const world = makeWorld({ pillars: [{ x: 4, z: 5, height: 2 }] });
        const companion = makeCompanion(world, {
            bot: { x: -4.5, y: FEET_Y, z: 6.5 },
            owner: { x: 4.5, y: FEET_Y, z: 3.5 }
        });

        let lastReachable = null;
        const done = await collectPassageLog(async () => {
            try {
                await companion.run(40);
                lastReachable = companion.bot.entity.position.clone();
                // The owner climbs onto a pillar the bot cannot walk up.
                companion.moveOwner({ x: 4.5, y: FEET_Y + 2, z: 5.5 });
                await companion.run(60);
            } finally {
                companion.dispose();
            }
        });

        assert.deepEqual(companion.activations, [], `the gate is never touched: ${companion.activations.length} activations`);
        assert.deepEqual(done, []);
        assert.equal(world.isPassageOpen(), false);
        const drift = companion.bot.entity.position.distanceTo(lastReachable);
        assert.ok(drift <= 2, `wandered ${drift.toFixed(1)} blocks from where it could last reach`);
    });

    it('does not work a gate just short of an owner whose feet it cannot reach', async () => {
        const world = makeWorld({ pillars: [{ x: 0, z: -2, height: 2 }] });
        const companion = makeCompanion(world, {
            bot: { x: 0.5, y: FEET_Y, z: 4.5 },
            owner: { x: 0.5, y: FEET_Y + 2, z: -1.5 }
        });

        const done = await collectPassageLog(async () => {
            try {
                await companion.run(60);
            } finally {
                companion.dispose();
            }
        });

        assert.deepEqual(companion.activations, [], `the gate is never touched: ${companion.activations.length} activations`);
        assert.deepEqual(done, []);
        assert.equal(world.isPassageOpen(), false);
    });

    for (const passage of ['gate', 'door']) {
        it(`opens a ${passage}, walks through, and closes it once for a reachable owner`, async () => {
            const world = makeWorld({ passage });
            const companion = makeCompanion(world, {
                bot: { x: 0.5, y: FEET_Y, z: 4.5 },
                owner: { x: 0.5, y: FEET_Y, z: -4.5 }
            });

            const done = await collectPassageLog(async () => {
                try {
                    await companion.run(80);
                } finally {
                    companion.dispose();
                }
            });

            assert.deepEqual(done, ['open 0,64,0', 'close 0,64,0']);
            assert.deepEqual(companion.activations, ['open', 'close']);
            assert.equal(world.isPassageOpen(), false);
            assert.ok(companion.bot.entity.position.z < PASSAGE.z, 'ends on the owner side');
        });
    }
});
