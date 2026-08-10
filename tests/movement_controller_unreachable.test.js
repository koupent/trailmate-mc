import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import {
    MovementController,
    retainProgressingCutoffPath
} from '../src/companion/movement/MovementController.js';

function makeHarness() {
    const now = 10_000;
    let moving = false;
    const blocks = new Map();
    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = {
        position: new Vec3(0, 64, 0),
        height: 1.8,
        onGround: true
    };
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
        },
        *getPathFromTo(_movements, _start, goal) {
            yield {
                result: {
                    status: 'success',
                    path: [{ x: goal.x, y: goal.y, z: goal.z }]
                }
            };
        }
    };

    const movement = new MovementController(bot, { now: () => now });

    return {
        bot,
        movement,
        setBlock(name, position, properties) {
            const block = {
                name,
                position: new Vec3(position.x, position.y, position.z),
                _properties: { ...properties },
                boundingBox: name === 'air' ? 'empty' : 'block'
            };
            blocks.set(`${position.x},${position.y},${position.z}`, block);
            return block;
        },
        setMoving(value) {
            moving = value;
        }
    };
}

function ownerAt(x) {
    return {
        id: 7,
        position: new Vec3(x, 64, 0),
        height: 1.8
    };
}

async function startUnreachableCutoff(bot, movement, owner, path = [
    { x: 4, y: 64, z: 0 }
]) {
    movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });
    const result = { status: 'partial', path };
    bot.emit('path_update', result);
    await Promise.resolve();
    return result;
}

describe('MovementController unreachable cutoff', () => {
    it('freezes the first incomplete owner position while safe partial progress continues', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        const firstPartial = await startUnreachableCutoff(bot, movement, owner);
        assert.deepEqual(firstPartial.path, []);
        assert.equal(movement.isUnreachableFallback, true);
        assert.equal(bot.pathfinder.goal.x, 10);
        assert.equal(bot.pathfinder.movements, movement.movements);
        assert.equal(bot.pathfinder.movements.canOpenDoors, true);

        owner.position = new Vec3(20, 64, 0);
        const progressingPartial = {
            status: 'partial',
            path: [{ x: 6, y: 64, z: 0 }]
        };
        bot.emit('path_update', progressingPartial);
        assert.equal(
            progressingPartial.path.length,
            1,
            'safe progress should execute during complete-route search'
        );
        assert.equal(bot.pathfinder.goal.x, 10, 'the cutoff must not move with the owner');
        bot.pathfinder.getPathFromTo = function* () {
            yield {
                result: {
                    status: 'partial',
                    path: [{ x: 7, y: 64, z: 0, toPlace: [] }]
                }
            };
        };
        assert.equal(
            movement.followEntity(owner, 1, { endpointVisibilityTarget: owner }),
            false,
            'an incomplete live probe must not restart the active A* search'
        );
    });

    it('uses a complete validated gate detour without switching movement modes', async () => {
        const { bot, movement, setBlock } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        setBlock('oak_fence_gate', { x: 5, y: 64, z: 5 }, {
            open: false,
            facing: 'east'
        });
        const completeDetour = {
            status: 'success',
            path: [
                { x: 4, y: 64, z: 5.5 },
                {
                    x: 5.5,
                    y: 64,
                    z: 5.5,
                    toPlace: [{ x: 5, y: 64, z: 5, useOne: true }]
                },
                { x: 7, y: 64, z: 5.5 },
                { x: 9.5, y: 64, z: 0.5 }
            ]
        };
        bot.emit('path_update', completeDetour);

        assert.equal(completeDetour.path.length, 4);
        assert.equal(movement.isUnreachableFallback, true);
        assert.equal(bot.pathfinder.goal.x, 10);
        assert.equal(bot.pathfinder.movements, movement.movements);
        assert.equal(bot.pathfinder.movements.canOpenDoors, true);
    });

    it('rejects the reproduced same-side gate action and waits without changing movements', async () => {
        const { bot, movement, setBlock } = makeHarness();
        bot.entity.position = new Vec3(-356.3, 75, 231.15);
        const owner = {
            id: 7,
            position: new Vec3(-354.24, 78.62, 230.3),
            height: 1.8
        };
        setBlock('pale_oak_fence_gate', { x: -359, y: 75, z: 226 }, {
            open: false,
            facing: 'west'
        });
        await startUnreachableCutoff(bot, movement, owner, [
            { x: -356, y: 75, z: 230 }
        ]);

        const falseComplete = {
            status: 'success',
            path: [
                { x: -357.5, y: 75, z: 230.5, toPlace: [] },
                { x: -357.5, y: 75, z: 229.5, toPlace: [] },
                { x: -357.5, y: 75, z: 228.5, toPlace: [] },
                { x: -357.5, y: 75, z: 227.5, toPlace: [] },
                { x: -357.5, y: 75, z: 226.5, toPlace: [] },
                {
                    x: -359,
                    y: 75,
                    z: 226,
                    toPlace: [{ x: -359, y: 75, z: 226, useOne: true }]
                },
                { x: -360, y: 76, z: 226, toPlace: [] },
                { x: -359, y: 76, z: 226, toPlace: [] },
                { x: -359, y: 77, z: 224, toPlace: [] },
                { x: -359, y: 77, z: 230, toPlace: [] },
                { x: -356, y: 77, z: 230, toPlace: [] }
            ]
        };
        bot.emit('path_update', falseComplete);

        assert.deepEqual(falseComplete.path, []);
        assert.equal(movement.isUnreachable, true);
        assert.equal(bot.pathfinder.movements, movement.movements);
        assert.equal(bot.pathfinder.movements.canOpenDoors, true);
        assert.equal(movement.isUnreachableFallback, true);
    });

    it('finishes a terminal best-effort prefix, waits, then resumes when the owner moves', async () => {
        const { bot, movement, setMoving } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        setMoving(true);
        const timedOut = {
            status: 'timeout',
            path: [{ x: 8, y: 64, z: 0, toPlace: [] }]
        };
        bot.emit('path_update', timedOut);
        assert.equal(timedOut.path.length, 1);
        assert.equal(bot.pathfinder.movements.canOpenDoors, true);

        setMoving(false);
        movement.tickHoldWatchdog();
        assert.equal(movement.isUnreachable, true);

        owner.position = new Vec3(14, 64, 0);
        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(resumed, true);
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal.entity, owner);
    });

    it('does not restart an active cutoff search while a flying owner keeps moving', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        assert.equal(movement.isUnreachableFallback, true);
        bot.pathfinder.getPathFromTo = function* () {
            yield {
                result: {
                    status: 'partial',
                    path: [{ x: 6, y: 64, z: 2, toPlace: [] }]
                }
            };
        };

        owner.position = new Vec3(18, 64, 6);
        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(resumed, false);
        assert.equal(movement.isUnreachableFallback, true);
        assert.equal(bot.pathfinder.goal.x, 10);
        assert.equal(bot.pathfinder.goal.z, 0);
    });

    it('resumes promptly when the owner exits an unreachable enclosure elsewhere', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        assert.equal(bot.pathfinder.goal.x, 10);
        assert.equal(bot.pathfinder.goal.z, 0);

        bot.pathfinder.getPathFromTo = function* () {
            yield {
                result: {
                    status: 'partial',
                    path: [{ x: 5, y: 64, z: 3, toPlace: [] }]
                }
            };
            yield {
                result: {
                    status: 'success',
                    path: [{ x: 10, y: 64, z: 6, toPlace: [] }]
                }
            };
        };

        // The owner exits at a different point and then remains stationary.
        owner.position = new Vec3(10, 64, 6);
        const firstProbe = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });
        assert.equal(firstProbe, false);
        assert.equal(bot.pathfinder.goal.x, 10, 'main cutoff A* must remain active');
        assert.equal(bot.pathfinder.goal.z, 0, 'the main search must not be reset');

        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });
        assert.equal(resumed, true);
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal.entity, owner);
        assert.deepEqual(owner.position, new Vec3(10, 64, 6));
    });

    it('reprobes a stationary owner after the cutoff route has ended', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        bot.emit('path_update', { status: 'noPath', path: [] });
        assert.equal(movement.isUnreachable, true);
        bot.pathfinder.getPathFromTo = function* () {
            yield {
                result: {
                    status: 'success',
                    path: [{ x: 10, y: 64, z: 0, toPlace: [] }]
                }
            };
        };

        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(resumed, true);
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal.entity, owner);
    });

    it('targets the standable surface below a high owner without relying on onGround', () => {
        const { bot, movement, setBlock } = makeHarness();
        const owner = {
            id: 7,
            position: new Vec3(12, 74, 8),
            height: 1.8
        };
        setBlock('stone', { x: 12, y: 63, z: 8 }, {});
        setBlock('air', { x: 12, y: 64, z: 8 }, {});
        setBlock('air', { x: 12, y: 65, z: 8 }, {});

        const started = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(started, true);
        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
        assert.equal(bot.pathfinder.goal.x, 12);
        assert.equal(bot.pathfinder.goal.y, 64);
        assert.equal(bot.pathfinder.goal.z, 8);
    });

    it('keeps the surface position as the cutoff target after an airborne route is incomplete', async () => {
        const { bot, movement, setBlock } = makeHarness();
        const owner = {
            id: 7,
            position: new Vec3(12, 84, 8),
            height: 1.8
        };
        setBlock('stone', { x: 12, y: 63, z: 8 }, {});
        setBlock('air', { x: 12, y: 64, z: 8 }, {});
        setBlock('air', { x: 12, y: 65, z: 8 }, {});
        await startUnreachableCutoff(bot, movement, owner, [
            { x: 4, y: 64, z: 2 }
        ]);

        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNear');
        assert.equal(bot.pathfinder.goal.x, 12);
        assert.equal(bot.pathfinder.goal.y, 64);
        assert.equal(bot.pathfinder.goal.z, 8);
    });

    it('falls back to horizontal tracking when the surface column is unavailable', () => {
        const { bot, movement } = makeHarness();
        const owner = {
            id: 7,
            position: new Vec3(12, 84, 8),
            height: 1.8
        };

        movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });

        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalNearXZ');
        assert.equal(bot.pathfinder.goal.x, 12);
        assert.equal(bot.pathfinder.goal.z, 8);
    });

    it('switches from horizontal airborne tracking to normal 3D follow on landing', () => {
        const { bot, movement } = makeHarness();
        const owner = {
            id: 7,
            position: new Vec3(12, 74, 8),
            height: 1.8,
            onGround: false
        };
        movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });

        owner.position = new Vec3(12, 64, 8);
        owner.onGround = true;
        const restarted = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(restarted, true);
        assert.equal(bot.pathfinder.goal.constructor.name, 'GoalFollow');
        assert.equal(bot.pathfinder.goal.entity, owner);
    });

    it('restarts follow when combat replaced the active cutoff goal', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);
        assert.equal(movement.isUnreachableFallback, true);

        bot.pathfinder.goal = { type: 'combat-goal' };
        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(resumed, true);
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal.entity, owner);
    });

    it('clears cutoff search state when movement stops', async () => {
        const { bot, movement } = makeHarness();
        const owner = ownerAt(10);
        await startUnreachableCutoff(bot, movement, owner);

        movement.stop();
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal, null);
    });
});

describe('cutoff partial-route progress', () => {
    it('keeps a safe partial prefix that moves closer to the cutoff', () => {
        const result = {
            status: 'partial',
            path: [
                { x: 2, y: 64, z: 0, toPlace: [] },
                { x: 5, y: 64, z: 0, toPlace: [] }
            ]
        };

        const retained = retainProgressingCutoffPath(
            result,
            new Vec3(0, 64, 0),
            new Vec3(10, 64, 0)
        );

        assert.equal(retained, true);
        assert.equal(result.path.length, 2);
    });

    it('stops a partial prefix before any door interaction', () => {
        const result = {
            status: 'partial',
            path: [
                { x: 2, y: 64, z: 0, toPlace: [] },
                {
                    x: 4,
                    y: 64,
                    z: 0,
                    toPlace: [{ x: 4, y: 64, z: 0, useOne: true }]
                },
                { x: 6, y: 64, z: 0, toPlace: [] }
            ]
        };

        const retained = retainProgressingCutoffPath(
            result,
            new Vec3(0, 64, 0),
            new Vec3(10, 64, 0)
        );

        assert.equal(retained, true);
        assert.deepEqual(result.path, [{ x: 2, y: 64, z: 0, toPlace: [] }]);
    });

    it('also stops a timed-out best-effort path before a door interaction', () => {
        const result = {
            status: 'timeout',
            path: [
                { x: 2, y: 64, z: 0, toPlace: [] },
                {
                    x: 4,
                    y: 64,
                    z: 0,
                    toPlace: [{ x: 4, y: 64, z: 0, useOne: true }]
                }
            ]
        };

        const retained = retainProgressingCutoffPath(
            result,
            new Vec3(0, 64, 0),
            new Vec3(10, 64, 0)
        );

        assert.equal(retained, true);
        assert.deepEqual(result.path, [{ x: 2, y: 64, z: 0, toPlace: [] }]);
    });

    it('rejects a partial prefix that does not approach the cutoff', () => {
        const result = {
            status: 'partial',
            path: [{ x: -1, y: 64, z: 0, toPlace: [] }]
        };

        const retained = retainProgressingCutoffPath(
            result,
            new Vec3(0, 64, 0),
            new Vec3(10, 64, 0)
        );

        assert.equal(retained, false);
        assert.deepEqual(result.path, []);
    });
});
