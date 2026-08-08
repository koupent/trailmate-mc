import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import {
    MovementController,
    UNREACHABLE_SEARCH_GRACE_MS
} from '../src/companion/movement/MovementController.js';

function makeHarness() {
    let now = 10_000;
    const scheduled = [];
    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = {
        position: new Vec3(0, 64, 0),
        height: 1.8,
        onGround: true
    };
    bot.world = { raycast: () => null };
    bot.blockAt = () => null;
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
            return false;
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

    const movement = new MovementController(bot, {
        now: () => now,
        schedule(callback, delay) {
            const handle = { callback, delay, cancelled: false };
            scheduled.push(handle);
            return handle;
        },
        cancelSchedule(handle) {
            handle.cancelled = true;
        }
    });

    return {
        bot,
        movement,
        scheduled,
        setNow(value) {
            now = value;
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

describe('MovementController unreachable cutoff', () => {
    it('freezes the first incomplete owner position and follows a door-free partial route after two seconds', async () => {
        const { bot, movement, scheduled } = makeHarness();
        const owner = ownerAt(10);
        movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });

        const firstPartial = {
            status: 'partial',
            path: [{ x: 4, y: 64, z: 0 }]
        };
        bot.emit('path_update', firstPartial);
        await Promise.resolve();
        assert.deepEqual(firstPartial.path, []);
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].delay, UNREACHABLE_SEARCH_GRACE_MS);

        owner.position = new Vec3(20, 64, 0);
        bot.emit('path_update', {
            status: 'partial',
            path: [{ x: 6, y: 64, z: 0 }]
        });
        assert.equal(scheduled.length, 1, 'the cutoff must not move with the owner');

        scheduled[0].callback();
        assert.equal(movement.isUnreachableFallback, true);
        assert.equal(bot.pathfinder.goal.x, 10);
        assert.equal(bot.pathfinder.goal.y, 64);
        assert.equal(bot.pathfinder.goal.z, 0);
        assert.equal(bot.pathfinder.movements.canOpenDoors, false);

        const bestEffort = {
            status: 'partial',
            path: [{ x: 8, y: 64, z: 0 }]
        };
        bot.emit('path_update', bestEffort);
        assert.equal(bestEffort.path.length, 1, 'best-effort movement should execute');
    });

    it('uses a complete detour to the frozen cutoff when it appears during the grace period', async () => {
        const { bot, movement, scheduled } = makeHarness();
        const owner = ownerAt(10);
        movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });

        bot.emit('path_update', {
            status: 'partial',
            path: [{ x: 4, y: 64, z: 0 }]
        });
        await Promise.resolve();
        const completeDetour = {
            status: 'success',
            path: [{
                x: 9.5,
                y: 64,
                z: 0.5,
                toPlace: [{ x: 5, y: 64, z: 5, useOne: true }]
            }]
        };
        bot.emit('path_update', completeDetour);

        assert.equal(scheduled[0].cancelled, true);
        assert.equal(completeDetour.path.length, 1);
        scheduled[0].callback();
        assert.equal(movement.isUnreachableFallback, true);
        assert.equal(bot.pathfinder.goal.x, 10);
    });

    it('reprobes the live owner and resumes after reaching the cutoff frontier', async () => {
        const { bot, movement, scheduled, setNow } = makeHarness();
        const owner = ownerAt(10);
        movement.followEntity(owner, 1, { endpointVisibilityTarget: owner });
        bot.emit('path_update', {
            status: 'partial',
            path: [{ x: 4, y: 64, z: 0 }]
        });
        await Promise.resolve();
        scheduled[0].callback();
        bot.emit('goal_reached');

        owner.position = new Vec3(14, 64, 0);
        setNow(11_000);
        const resumed = movement.followEntity(owner, 1, {
            endpointVisibilityTarget: owner
        });

        assert.equal(resumed, true);
        assert.equal(movement.isUnreachableFallback, false);
        assert.equal(bot.pathfinder.goal.entity, owner);
    });
});
