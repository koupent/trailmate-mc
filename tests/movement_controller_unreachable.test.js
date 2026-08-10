import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import {
    findSurfaceFollowTarget,
    MovementController,
    UNREACHABLE_REPROBE_MS
} from '../src/companion/movement/MovementController.js';

function makeHarness() {
    let now = 10_000;
    let moving = false;
    const blocks = new Map();
    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = {
        position: new Vec3(0, 64, 0),
        height: 1.8,
        onGround: true
    };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null };
    bot.blockAt = (pos) => blocks.get(
        `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    ) || null;
    bot.pathfinder = {
        goal: null,
        movements: null,
        setMovements(movements) {
            this.movements = movements;
        },
        setGoal(goal) {
            this.goal = goal;
        },
        isMoving() {
            return moving;
        }
    };

    const movement = new MovementController(bot, { now: () => now });
    return {
        bot,
        movement,
        setNow(value) {
            now = value;
        },
        setMoving(value) {
            moving = value;
        },
        setColumn(x, groundY, z) {
            for (const [y, name] of [
                [groundY, 'stone'],
                [groundY + 1, 'air'],
                [groundY + 2, 'air']
            ]) {
                blocks.set(`${x},${y},${z}`, {
                    name,
                    position: new Vec3(x, y, z),
                    boundingBox: name === 'air' ? 'empty' : 'block',
                    _properties: {}
                });
            }
        }
    };
}

function ownerAt(x, y = 84, z = 0) {
    return {
        id: 7,
        position: new Vec3(x, y, z),
        height: 1.8,
        onGround: false
    };
}

function successfulPath(x, y = 64, z = 0) {
    return {
        status: 'success',
        path: [{ x, y, z, toPlace: [], toBreak: [] }]
    };
}

function makeAirborneEnclosureHarness() {
    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = {
        position: new Vec3(0, 64, 0),
        height: 1.8,
        onGround: true
    };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null };

    const wallCells = new Set();
    for (let x = 4; x <= 6; x++) {
        wallCells.add(`${x},-1`);
        wallCells.add(`${x},1`);
    }
    for (let z = -1; z <= 1; z++) {
        wallCells.add(`4,${z}`);
        wallCells.add(`6,${z}`);
    }

    bot.blockAt = (pos) => {
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        const wall = wallCells.has(`${x},${z}`) && (y === 64 || y === 65);
        if (wall || y === 63) {
            return {
                name: 'stone',
                position: new Vec3(x, y, z),
                boundingBox: 'block',
                _properties: {}
            };
        }
        if (y >= 64) {
            return {
                name: 'air',
                position: new Vec3(x, y, z),
                boundingBox: 'empty',
                _properties: {}
            };
        }
        return null;
    };

    function search(start, goal) {
        const origin = { x: Math.floor(start.x), z: Math.floor(start.z) };
        const queue = [origin];
        const visited = new Set([`${origin.x},${origin.z}`]);
        const previous = new Map();

        while (queue.length > 0) {
            const current = queue.shift();
            if (goal.isEnd(new Vec3(current.x, 64, current.z))) {
                const path = [];
                let key = `${current.x},${current.z}`;
                while (previous.has(key)) {
                    const [x, z] = key.split(',').map(Number);
                    path.unshift({ x, y: 64, z, toPlace: [], toBreak: [] });
                    key = previous.get(key);
                }
                return { status: 'success', path };
            }

            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const x = current.x + dx;
                const z = current.z + dz;
                const key = `${x},${z}`;
                if (x < -2 || x > 10 || z < -4 || z > 4
                    || visited.has(key) || wallCells.has(key)) {
                    continue;
                }
                visited.add(key);
                previous.set(key, `${current.x},${current.z}`);
                queue.push({ x, z });
            }
        }
        return { status: 'noPath', path: [] };
    }

    bot.pathfinder = {
        goal: null,
        setMovements() {},
        setGoal(goal) {
            this.goal = goal;
            if (goal) bot.emit('path_update', search(bot.entity.position, goal));
        },
        isMoving() {
            return false;
        }
    };

    return { bot, movement: new MovementController(bot) };
}

describe('surface-projected owner follow', () => {
    it('targets the nearest standable surface below an airborne owner', () => {
        const { bot, movement, setColumn } = makeHarness();
        setColumn(12, 63, 8);
        const owner = ownerAt(12, 84, 8);

        assert.deepEqual(findSurfaceFollowTarget(bot, owner.position), new Vec3(12.5, 64, 8.5));
        assert.equal(movement.followEntity(owner, 1), true);
        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
        assert.deepEqual(
            [bot.pathfinder.goal.x, bot.pathfinder.goal.y, bot.pathfinder.goal.z],
            [12, 64, 8]
        );
    });

    it('uses the same surface goal while the owner walks on the ground', () => {
        const { bot, movement, setColumn } = makeHarness();
        setColumn(4, 63, 0);
        const owner = ownerAt(4, 64, 0);
        owner.onGround = true;

        movement.followEntity(owner, 1);

        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
        assert.deepEqual(
            [bot.pathfinder.goal.x, bot.pathfinder.goal.y, bot.pathfinder.goal.z],
            [4, 64, 0]
        );
    });

    it('does not invent a height-free goal when no surface is known', () => {
        const { bot, movement } = makeHarness();

        assert.equal(movement.followEntity(ownerAt(12), 1), false);
        assert.equal(bot.pathfinder.goal, null);
        assert.equal(movement.isUnreachable, true);
    });

    it('tracks the opposite exit while the owner remains airborne throughout', () => {
        const { bot, movement } = makeAirborneEnclosureHarness();
        const owner = ownerAt(2, 84, 0);

        movement.followEntity(owner, 1);
        assert.equal(bot.pathfinder.goal.x, 2);
        assert.equal(bot.pathfinder.goal.y, 64);

        owner.position = new Vec3(5, 84, 0);
        movement.followEntity(owner, 1);
        assert.equal(movement.isUnreachableFallback, true);

        owner.position = new Vec3(8, 84, 0);
        movement.followEntity(owner, 1);

        assert.equal(owner.onGround, false);
        assert.equal(owner.position.y, 84);
        assert.deepEqual(
            [bot.pathfinder.goal.x, bot.pathfinder.goal.y, bot.pathfinder.goal.z],
            [8, 64, 0]
        );
        assert.equal(movement.isUnreachableFallback, false);
    });

    it('returns toward the last reachable surface while the projection is enclosed', () => {
        const { bot, movement, setColumn } = makeHarness();
        setColumn(2, 63, 0);
        setColumn(5, 63, 0);
        const owner = ownerAt(2);

        movement.followEntity(owner, 1);
        bot.emit('path_update', successfulPath(2));

        owner.position = new Vec3(5, 84, 0);
        movement.followEntity(owner, 1);
        bot.emit('path_update', { status: 'noPath', path: [] });
        movement.followEntity(owner, 1);

        assert.equal(movement.isUnreachableFallback, true);
        assert.deepEqual(
            [bot.pathfinder.goal.x, bot.pathfinder.goal.y, bot.pathfinder.goal.z],
            [2, 64, 0]
        );
    });

    it('retries a stationary projected target after the retry interval', () => {
        const { bot, movement, setColumn, setNow } = makeHarness();
        setColumn(5, 63, 0);
        const owner = ownerAt(5);

        movement.followEntity(owner, 1);
        bot.emit('path_update', { status: 'noPath', path: [] });
        movement.followEntity(owner, 1);
        assert.equal(bot.pathfinder.goal, null);

        setNow(10_000 + UNREACHABLE_REPROBE_MS + 1);
        assert.equal(movement.followEntity(owner, 1), true);
        assert.equal(bot.pathfinder.goal.x, 5);
    });

    it('never executes a partial path toward an arbitrary frontier or door', () => {
        const { bot, movement, setColumn } = makeHarness();
        setColumn(8, 63, 0);
        movement.followEntity(ownerAt(8), 1);
        const partial = {
            status: 'partial',
            path: [{
                x: 4,
                y: 64,
                z: 2,
                toPlace: [{ x: 4, y: 64, z: 2, useOne: true }]
            }]
        };

        bot.emit('path_update', partial);

        assert.deepEqual(partial.path, []);
        assert.equal(movement.isRoutePending, true);
    });

    it('reasserts the current surface goal after another controller replaces it', () => {
        const { bot, movement, setColumn } = makeHarness();
        setColumn(8, 63, 0);
        const owner = ownerAt(8);
        movement.followEntity(owner, 1);
        bot.emit('path_update', successfulPath(8));

        bot.pathfinder.goal = { combat: true };
        assert.equal(movement.followEntity(owner, 1), true);
        assert.equal(bot.pathfinder.goal.x, 8);
    });
});
