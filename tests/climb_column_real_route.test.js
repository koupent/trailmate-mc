/**
 * The climb approach against the real mineflayer-pathfinder.
 *
 * The physics test proves the companion goes UP once its feet are in the vines.
 * Nothing proved it could ever get them there, and that gap is the whole of
 * #138: the fix for #134 was correct and never ran once, because every test put
 * the body inside the column by hand.
 *
 * This file asks real A*, over the real Movements this project installs, the
 * three questions the fix rests on:
 *
 *   1. following an owner who topped the wall really does fail outright
 *   2. `GoalNear` at the follow range really does stop beside the column
 *   3. `GoalNear` at range 0 really does route INTO it
 *
 * If a library upgrade changes any of those, the hand-shaped tests all stay
 * green while the companion quietly stops climbing again. This is that alarm.
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
import { findSurfaceFollowTarget } from '../src/companion/movement/MovementController.js';
import { findNearbyClimbColumn } from '../src/companion/movement/climbColumn.js';
import { FOLLOW_GOAL_RANGE } from '../src/companion/movement/followConstants.js';

const VERSION = '1.21.4';
const registry = minecraftData(VERSION);
const Block = prismarineBlock(registry);

const GROUND_Y = 63;
const FEET_Y = 64;
/** The vines, and the only cell from which the climb can ever start. */
const COLUMN = { x: 0, y: FEET_Y, z: 0 };
/** Walkable top of the stone wall the vines hang on. */
const WALL_TOP_Y = 67;

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
 * Open ground, a three-high stone wall at x = 1..3, and one vine column on its
 * west face. Nothing anywhere leads up: no stairs, no ledge, no gap. The only
 * way onto the wall is the vines.
 */
function makeWorld() {
    const states = new Map();
    const at = (pos) => `${pos.x},${pos.y},${pos.z}`;
    const set = (pos, name, props) => states.set(at(pos), stateId(name, props));

    for (let x = -8; x <= 8; x++) {
        for (let z = -8; z <= 8; z++) set({ x, y: GROUND_Y, z }, 'stone');
    }
    for (let x = 1; x <= 3; x++) {
        for (let y = FEET_Y; y < WALL_TOP_Y; y++) {
            for (let z = -3; z <= 3; z++) set({ x, y, z }, 'stone');
        }
    }
    for (let y = FEET_Y; y < WALL_TOP_Y; y++) {
        set({ x: COLUMN.x, y, z: COLUMN.z }, 'vine', { east: 'true' });
    }

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
        }
    };
}

function makeBot(world, position) {
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.version = VERSION;
    bot.entity = { position: position.clone(), height: 1.8, onGround: true };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null, getBlock: (pos) => world.blockAt(pos) };
    bot.blockAt = (pos) => world.blockAt(pos);
    bot.entities = {};
    bot.inventory = { items: () => [], slots: [] };
    bot.canDigBlock = () => false;
    return bot;
}

/**
 * Real A* over the real Movements. A* yields `partial` whenever it runs past its
 * per-tick budget, and mineflayer-pathfinder resumes the same context until it
 * settles; do the same rather than race a timer.
 */
function planRoute(bot, movements, goal) {
    const from = bot.entity.position.floored();
    const start = new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
    const context = new AStar(start, movements, goal, 10_000, 40, -1);
    let result = context.compute();
    for (let resumes = 0; result.status === 'partial' && resumes < 40; resumes++) {
        result = context.compute();
    }
    return result;
}

function endpointOf(result) {
    const node = result.path.at(-1);
    return { x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) };
}

/** Where the companion is left standing: open ground, south of the vines. */
const OPEN_GROUND = new Vec3(0.5, FEET_Y, 4.5);

describe('climb approach against the real pathfinder', () => {
    it('confirms the follow target is the owner cell on top, and is unreachable', () => {
        const world = makeWorld();
        const bot = makeBot(world, OPEN_GROUND);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        // The owner has topped the wall. findSurfaceFollowTarget scans their own
        // x,z from the top down and finds solid ground on the first try.
        const target = findSurfaceFollowTarget(bot, new Vec3(1.5, WALL_TOP_Y, 0.5));
        assert.deepEqual(
            { x: target.x, y: target.y, z: target.z },
            { x: 1.5, y: WALL_TOP_Y, z: 0.5 },
            'the follow target is the wall top, not the foot of the wall'
        );

        const result = planRoute(
            bot,
            movements,
            new pf.goals.GoalNear(target.x, target.y, target.z, FOLLOW_GOAL_RANGE)
        );
        assert.equal(
            result.status,
            'noPath',
            'this is why the companion never even walks toward the wall'
        );
    });

    it('stops beside the column at the follow range, never inside it', () => {
        const world = makeWorld();
        const bot = makeBot(world, OPEN_GROUND);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(
            bot,
            movements,
            new pf.goals.GoalNear(COLUMN.x, COLUMN.y, COLUMN.z, FOLLOW_GOAL_RANGE)
        );

        assert.equal(result.status, 'success');
        assert.notDeepEqual(
            endpointOf(result),
            COLUMN,
            'GoalNear accepts the horizontal neighbours, and A* takes the first one'
        );
    });

    it('routes into the column itself at range 0', () => {
        const world = makeWorld();
        const bot = makeBot(world, OPEN_GROUND);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        const result = planRoute(
            bot,
            movements,
            new pf.goals.GoalNear(COLUMN.x + 0.5, COLUMN.y, COLUMN.z + 0.5, 0)
        );

        assert.equal(result.status, 'success', 'the vines are walkable, so A* can enter them');
        assert.deepEqual(
            endpointOf(result),
            COLUMN,
            'the route ends on the one cell the climb can start from'
        );
    });

    it('finds the column from wherever the follow range left the companion', () => {
        const world = makeWorld();
        const bot = makeBot(world, OPEN_GROUND);
        const movements = createSafeMovements(bot, { allowSprinting: false });

        // Exactly the spot the second test proved A* stops at.
        const stranded = endpointOf(planRoute(
            bot,
            movements,
            new pf.goals.GoalNear(COLUMN.x, COLUMN.y, COLUMN.z, FOLLOW_GOAL_RANGE)
        ));
        const found = findNearbyClimbColumn(
            bot,
            new Vec3(stranded.x + 0.5, stranded.y, stranded.z + 0.5)
        );

        assert.ok(found, 'the approach must see the column from where follow gives up');
        assert.deepEqual(
            { x: found.cell.x, y: found.cell.y, z: found.cell.z },
            COLUMN
        );
        assert.deepEqual(found.push, { x: 1, z: 0 }, 'pressed east, into the wall');
    });
});
