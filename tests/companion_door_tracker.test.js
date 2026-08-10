import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DoorTracker,
    doorSide,
    evaluatePassage,
    isCloseablePassage,
    isClosedToOpen,
    isDoorBetween,
    normalizeDoorPos,
    posKey
} from '../src/companion/movement/DoorTracker.js';

describe('isCloseablePassage', () => {
    it('accepts wooden doors and fence gates', () => {
        assert.equal(isCloseablePassage({ name: 'oak_door' }), true);
        assert.equal(isCloseablePassage({ name: 'spruce_fence_gate' }), true);
    });

    it('rejects iron, trapdoors, and unrelated blocks', () => {
        assert.equal(isCloseablePassage({ name: 'iron_door' }), false);
        assert.equal(isCloseablePassage({ name: 'oak_trapdoor' }), false);
        assert.equal(isCloseablePassage({ name: 'iron_trapdoor' }), false);
        assert.equal(isCloseablePassage({ name: 'stone' }), false);
        assert.equal(isCloseablePassage(null), false);
    });
});

describe('normalizeDoorPos / posKey', () => {
    it('maps upper half doors to the lower block', () => {
        const pos = normalizeDoorPos({
            position: { x: 3, y: 65, z: 7 },
            _properties: { half: 'upper' }
        });
        assert.deepEqual(pos, { x: 3, y: 64, z: 7 });
        assert.equal(posKey(pos), '3,64,7');
    });

    it('keeps lower half and fence gates as-is', () => {
        assert.deepEqual(
            normalizeDoorPos({
                position: { x: 1, y: 70, z: 2 },
                _properties: { half: 'lower' }
            }),
            { x: 1, y: 70, z: 2 }
        );
        assert.deepEqual(
            normalizeDoorPos({
                position: { x: 1, y: 70, z: 2 },
                _properties: {}
            }),
            { x: 1, y: 70, z: 2 }
        );
    });
});

describe('isClosedToOpen', () => {
    it('detects closed to open on a wooden door', () => {
        assert.equal(
            isClosedToOpen(
                { name: 'oak_door', _properties: { open: false } },
                { name: 'oak_door', _properties: { open: true } }
            ),
            true
        );
    });

    it('ignores already-open and non-passages', () => {
        assert.equal(
            isClosedToOpen(
                { name: 'oak_door', _properties: { open: true } },
                { name: 'oak_door', _properties: { open: true } }
            ),
            false
        );
        assert.equal(
            isClosedToOpen(
                { name: 'stone', _properties: {} },
                { name: 'oak_door', _properties: { open: true } }
            ),
            false
        );
    });
});

describe('doorSide / evaluatePassage', () => {
    it('uses Z for north/south facing doors', () => {
        assert.equal(doorSide({ x: 0.5, z: 2 }, { x: 0, z: 0 }, 'north'), 1);
        assert.equal(doorSide({ x: 0.5, z: -1 }, { x: 0, z: 0 }, 'south'), -1);
    });

    it('uses X for east/west facing doors', () => {
        assert.equal(doorSide({ x: 3, z: 0.5 }, { x: 0, z: 0 }, 'east'), 1);
        assert.equal(doorSide({ x: -2, z: 0.5 }, { x: 0, z: 0 }, 'west'), -1);
    });

    it('records approach side when near, but does not close yet', () => {
        const tracked = {
            approachSide: null,
            facing: 'north',
            doorPos: { x: 0, y: 64, z: 0 }
        };
        const near = evaluatePassage(tracked, { x: 0.5, y: 64, z: 1.5 });
        assert.equal(near.approachSide, 1);
        assert.equal(near.readyToClose, false);
    });

    it('is ready to close only after crossing to the opposite side with clearance', () => {
        const tracked = {
            approachSide: 1,
            facing: 'north',
            doorPos: { x: 0, y: 64, z: 0 }
        };
        const stillNear = evaluatePassage(tracked, { x: 0.5, y: 64, z: -0.2 });
        assert.equal(stillNear.readyToClose, false);

        const crossed = evaluatePassage(tracked, { x: 0.5, y: 64, z: -2 });
        assert.equal(crossed.readyToClose, true);
    });
});

describe('isDoorBetween', () => {
    const door = { x: 22, y: 63, z: 551 };

    it('rejects owner perched on the door sill (repro case)', () => {
        // Bot inside (south), owner 4cm past door center — must NOT open.
        assert.equal(
            isDoorBetween(
                { x: 22.5, z: 550.05 },
                { x: 22.54, z: 551.51 },
                door,
                'north'
            ),
            false
        );
    });

    it('accepts owner clearly through the door', () => {
        assert.equal(
            isDoorBetween(
                { x: 22.5, z: 550.05 },
                { x: 22.5, z: 553.5 },
                door,
                'north'
            ),
            true
        );
    });

    it('rejects when both are on the same side', () => {
        assert.equal(
            isDoorBetween(
                { x: 22.5, z: 549.5 },
                { x: 22.5, z: 550.5 },
                door,
                'north'
            ),
            false
        );
    });

    it('rejects an unrelated passage whose infinite plane crosses the owner', () => {
        assert.equal(
            isDoorBetween(
                { x: 0.5, z: 0.5 },
                { x: 0.5, z: 6.5 },
                { x: 2, z: 1 },
                'north'
            ),
            false
        );
    });

});

describe('DoorTracker integration', () => {
    /** @type {any} */
    let bot;
    /** @type {any} */
    let owner;
    /** @type {DoorTracker} */
    let tracker;
    /** @type {Map<string, any>} */
    let blocks;
    /** @type {any[]} */
    let activations;
    let now;
    let activationFailures;

    function makeBlock(name, pos, props) {
        return {
            name,
            position: { x: pos.x, y: pos.y, z: pos.z },
            _properties: { ...props }
        };
    }

    function setBlock(name, pos, props) {
        const block = makeBlock(name, pos, props);
        blocks.set(`${pos.x},${pos.y},${pos.z}`, block);
        return block;
    }

    function routeThrough(block) {
        const doorPos = normalizeDoorPos(block);
        const center = { x: doorPos.x + 0.5, y: doorPos.y, z: doorPos.z + 0.5 };
        const acrossX = block._properties?.facing === 'east'
            || block._properties?.facing === 'west';
        const approach = acrossX
            ? { ...center, x: center.x + 1.5 }
            : { ...center, z: center.z + 1.5 };
        const passage = {
            ...center,
            toPlace: [{ ...doorPos, useOne: true }]
        };
        const exit = acrossX
            ? { ...center, x: center.x - 1.5 }
            : { ...center, z: center.z - 1.5 };
        return [approach, passage, exit];
    }

    function authorizePathDoor(block, status = 'success') {
        const path = routeThrough(block);
        if (status === 'success') bot.entity.position = { ...path[0] };
        bot.emit('path_update', {
            status,
            path
        });
    }

    /**
     * Owner swing + look + closed→open update, then leave the door open in the world.
     * @returns {any} open block
     */
    function ownerOpens(name, pos, props) {
        const closed = setBlock(name, pos, { ...props, open: false });
        bot.blockAtEntityCursor = () => closed;
        bot.emit('entitySwingArm', owner);
        const openProps = { ...props, open: true };
        bot.emit('blockUpdate', closed, makeBlock(name, pos, openProps));
        return setBlock(name, pos, openProps);
    }

    beforeEach(() => {
        blocks = new Map();
        activations = [];
        now = 10_000;
        activationFailures = 0;
        owner = {
            id: 42,
            position: { x: 0, y: 64, z: 0, offset() { return this; } },
            height: 1.62,
            pitch: 0,
            yaw: 0
        };
        bot = new EventEmitter();
        bot.entity = {
            position: { x: 0.5, y: 64, z: 3 }
        };
        bot.blockAtEntityCursor = () => null;
        bot.blockAt = (pos) => blocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || null;
        bot.activateBlock = (block) => {
            activations.push(block);
            if (activationFailures > 0) {
                activationFailures--;
                return Promise.reject(new Error('activation failed'));
            }
            return Promise.resolve();
        };
        tracker = new DoorTracker(bot, {
            getOwnerEntity: () => owner,
            now: () => now
        });
    });

    afterEach(() => {
        tracker.dispose();
    });

    it('tracks a wooden door only when owner swing + look + closed→open match', () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });
        assert.equal(tracker.trackedCount, 1);
    });

    it('ignores doors that were already open when looked at', () => {
        // Keep owner away so a later closed→open is not treated as owner-near open.
        owner.position = { x: 40, y: 64, z: 40, offset() { return this; } };
        const openDoor = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        bot.blockAtEntityCursor = () => openDoor;
        bot.emit('entitySwingArm', owner);
        bot.emit('blockUpdate',
            makeBlock('oak_door', { x: 0, y: 64, z: 0 }, { open: false, facing: 'north', half: 'lower' }),
            makeBlock('oak_door', { x: 0, y: 64, z: 0 }, { open: true, facing: 'north', half: 'lower' })
        );
        assert.equal(tracker.trackedCount, 0);
    });

    it('ignores swings from non-owner entities', () => {
        owner.position = { x: 40, y: 64, z: 40, offset() { return this; } };
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        bot.blockAtEntityCursor = () => closed;
        bot.emit('entitySwingArm', { id: 99 });
        bot.emit('blockUpdate', closed, makeBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        }));
        assert.equal(tracker.trackedCount, 0);
    });

    it('ignores redstone-style opens without a matching owner swing', () => {
        // Owner far away: must not treat as a companion passage to close.
        owner.position = { x: 40, y: 64, z: 40, offset() { return this; } };
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        bot.emit('blockUpdate', closed, makeBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        }));
        assert.equal(tracker.trackedCount, 0);
    });

    it('tracks owner-near opens even when the swing did not target the door', () => {
        owner.position = { x: 0.5, y: 64, z: 0.8, offset() { return this; } };
        bot.entity.position = { x: 0.5, y: 64, z: 2 };
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        bot.emit('blockUpdate', closed, makeBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        }));
        assert.equal(tracker.trackedCount, 1);
    });

    it('matches an owner-open update delayed by network latency', () => {
        owner.position = { x: 3.5, y: 64, z: 0.5, offset() { return this; } };
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        bot.blockAtEntityCursor = () => closed;
        bot.emit('entitySwingArm', owner);

        now += 1000;
        bot.emit('blockUpdate', closed, makeBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        }));

        assert.equal(tracker.trackedCount, 1);
    });

    it('ignores iron doors and trapdoors', () => {
        for (const name of ['iron_door', 'oak_trapdoor']) {
            const closed = setBlock(name, { x: 1, y: 64, z: 1 }, { open: false, facing: 'north' });
            bot.blockAtEntityCursor = () => closed;
            bot.emit('entitySwingArm', owner);
            bot.emit('blockUpdate', closed, makeBlock(name, { x: 1, y: 64, z: 1 }, {
                open: true,
                facing: 'north'
            }));
        }
        assert.equal(tracker.trackedCount, 0);
    });

    it('does not close when only approaching the door', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });

        bot.entity.position = { x: 0.5, y: 64, z: 1.5 };
        await tracker.tick();
        assert.equal(activations.length, 0);
        assert.equal(tracker.trackedCount, 1);
    });

    it('closes once after crossing to the opposite side', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });

        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        assert.equal(activations.length, 0);

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();
        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'oak_door');
        assert.equal(tracker.trackedCount, 1);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);
        assert.equal(activations.length, 1);
    });

    it('closes after a fast crossing between ticks', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();

        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'oak_door');
    });

    it('forgets a tracked door that closes on its own', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });
        assert.equal(tracker.trackedCount, 1);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);
        assert.equal(activations.length, 0);
    });

    it('tracks fence gates the same way as wooden doors', async () => {
        ownerOpens('oak_fence_gate', { x: 2, y: 64, z: 2 }, {
            facing: 'east'
        });

        bot.entity.position = { x: 1, y: 64, z: 2.5 };
        await tracker.tick();
        bot.entity.position = { x: 4, y: 64, z: 2.5 };
        await tracker.tick();
        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'oak_fence_gate');
    });

    it('tracks a door the bot opens via activateBlock', async () => {
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        authorizePathDoor(closed);
        await bot.activateBlock(closed);
        assert.equal(tracker.trackedCount, 1);
        assert.equal(activations.length, 1);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        assert.equal(activations.length, 1);

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();
        assert.equal(activations.length, 2);
        assert.equal(activations[1].name, 'oak_door');
        assert.equal(tracker.trackedCount, 1);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);
    });

    it('blocks a door action from an incomplete path to an unreachable owner', async () => {
        const gate = setBlock('pale_oak_fence_gate', { x: -329, y: 75, z: 226 }, {
            open: false,
            facing: 'north'
        });
        bot.entity.position = { x: -327.5, y: 75, z: 226.5 };
        owner.position = { x: -331.28, y: 75, z: 230.75 };
        authorizePathDoor(gate, 'partial');

        await bot.activateBlock(gate);

        assert.equal(activations.length, 0);
        assert.equal(tracker.trackedCount, 0);
    });

    it('allows an authorized detour passage outside the direct bot-owner line', async () => {
        const gate = setBlock('pale_oak_fence_gate', { x: -329, y: 75, z: 226 }, {
            open: false,
            facing: 'north'
        });
        authorizePathDoor(gate, 'success');

        await bot.activateBlock(gate);

        assert.equal(activations.length, 1);
        assert.equal(tracker.trackedCount, 1);
    });

    it('opens an authorized passage on approach without pathfinder executing useOne', async () => {
        const gate = setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north'
        });
        const path = routeThrough(gate);
        bot.entity.position = { ...path[0] };
        const result = { status: 'success', path };

        bot.emit('path_update', result);

        assert.deepEqual(result.path[1].toPlace, []);
        assert.equal(activations.length, 0);

        await tracker.tick();

        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'oak_fence_gate');
        assert.equal(tracker.trackedCount, 1);
    });

    it('blocks a stale authorization when the bot is no longer on the planned approach side', async () => {
        const gate = setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north'
        });
        authorizePathDoor(gate);
        bot.entity.position = { x: 0.5, y: 64, z: -1 };

        await bot.activateBlock(gate);

        assert.equal(activations.length, 0);
        assert.equal(tracker.trackedCount, 0);
    });

    it('keeps bot-opened tracking while the open state is delayed', async () => {
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        authorizePathDoor(closed);
        await bot.activateBlock(closed);

        await tracker.tick();
        now += 2000;
        await tracker.tick();

        assert.equal(tracker.trackedCount, 1);
        assert.equal(activations.length, 1);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 1);
    });

    it('retries closing after activateBlock fails', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });
        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        activationFailures = 1;

        await tracker.tick();
        assert.equal(activations.length, 1);
        assert.equal(tracker.trackedCount, 1);

        now += 599;
        await tracker.tick();
        assert.equal(activations.length, 1);

        now += 1;
        await tracker.tick();
        assert.equal(activations.length, 2);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);
    });

    it('retries closing when the world state stays open', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower'
        });
        bot.entity.position = { x: 0.5, y: 64, z: -2 };

        await tracker.tick();
        assert.equal(activations.length, 1);

        now += 1201;
        await tracker.tick();
        assert.equal(activations.length, 1);

        now += 600;
        await tracker.tick();
        assert.equal(activations.length, 2);
        assert.equal(tracker.trackedCount, 1);
    });

    it('does not track already-open doors activated by the bot', async () => {
        const openDoor = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        await bot.activateBlock(openDoor);
        assert.equal(tracker.trackedCount, 0);
        assert.equal(activations.length, 1);
    });

    it('does not re-track when closing a tracked door', async () => {
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        authorizePathDoor(closed);
        await bot.activateBlock(closed);
        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });

        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();

        assert.equal(tracker.trackedCount, 1);
        assert.equal(activations.length, 2);

        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);
    });

    it('does not track iron doors or trapdoors opened by the bot', async () => {
        for (const name of ['iron_door', 'oak_trapdoor']) {
            const closed = setBlock(name, { x: 4, y: 64, z: 4 }, {
                open: false,
                facing: 'north'
            });
            await bot.activateBlock(closed);
        }
        assert.equal(tracker.trackedCount, 0);
    });

    it('does not duplicate tracking for the same bot-opened door', async () => {
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        authorizePathDoor(closed);
        await bot.activateBlock(closed);
        await bot.activateBlock(closed);
        assert.equal(tracker.trackedCount, 1);
        assert.equal(activations.length, 1);
    });

    it('does not proactively open an unrelated gate when owner is unreachable', async () => {
        setBlock('oak_fence_gate', { x: 2, y: 64, z: 1 }, {
            open: false,
            facing: 'north',
        });
        bot.entity.position = { x: 0.5, y: 64, z: 0.5 };
        owner.position = { x: 0.5, y: 64, z: 6.5 };

        await tracker.tick();
        assert.equal(activations.length, 0);
    });

    it('blocks the reproduced flying-owner route that ends on the opening side', async () => {
        const gate = setBlock('pale_oak_fence_gate', { x: -359, y: 75, z: 226 }, {
            open: false,
            facing: 'west'
        });
        bot.entity.position = { x: -357.5, y: 75, z: 226.5 };
        owner.position = { x: -355.31, y: 78.24, z: 236.04 };
        bot.emit('path_update', {
            status: 'success',
            path: [
                {
                    x: -358.5,
                    y: 75,
                    z: 226.5,
                    toPlace: [{ x: -359, y: 75, z: 226, useOne: true }]
                },
                { x: -355.51, y: 75, z: 232.21 }
            ]
        });

        await bot.activateBlock(gate);

        assert.equal(activations.length, 0);
        assert.equal(tracker.trackedCount, 0);
    });

    it('allows a wide detour that crosses the gate plane away from the gate', async () => {
        setBlock('pale_oak_fence_gate', { x: -359, y: 75, z: 226 }, {
            open: false,
            facing: 'west'
        });
        bot.entity.position = { x: -356.3, y: 75, z: 231.15 };
        owner.position = { x: -354.24, y: 78.62, z: 230.3 };
        const result = {
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

        bot.emit('path_update', result);

        assert.equal(result.path[5].toPlace.length, 0);
        assert.equal(activations.length, 0);

        bot.entity.position = { x: -357.5, y: 75, z: 226.5 };
        await tracker.tick();

        assert.equal(activations.length, 1);
        assert.equal(tracker.trackedCount, 1);
    });

    it('rejects a route that crosses and then returns through the same gate', async () => {
        setBlock('pale_oak_fence_gate', { x: -359, y: 75, z: 226 }, {
            open: false,
            facing: 'west'
        });
        bot.entity.position = { x: -356.3, y: 75, z: 226.5 };
        const result = {
            status: 'success',
            path: [
                { x: -357.5, y: 75, z: 226.5, toPlace: [] },
                {
                    x: -359,
                    y: 75,
                    z: 226.5,
                    toPlace: [{ x: -359, y: 75, z: 226, useOne: true }]
                },
                { x: -360, y: 75, z: 226.5, toPlace: [] },
                { x: -357.5, y: 75, z: 226.5, toPlace: [] }
            ]
        };

        bot.emit('path_update', result);

        assert.equal(result.path[1].toPlace.length, 1);
        bot.entity.position = { x: -357.5, y: 75, z: 226.5 };
        await tracker.tick();
        assert.equal(activations.length, 0);
        assert.equal(tracker.trackedCount, 0);
    });

    it('accepts the logged wide gate detour before the owner moves farther away', async () => {
        setBlock('pale_oak_fence_gate', { x: -329, y: 75, z: 226 }, {
            open: false,
            facing: 'west'
        });
        bot.entity.position = { x: -335.94, y: 75, z: 243.5 };
        const result = {
            status: 'success',
            path: [
                { x: -330, y: 75, z: 227.5, toPlace: [] },
                {
                    x: -329,
                    y: 75,
                    z: 226.5,
                    toPlace: [{ x: -329, y: 75, z: 226, useOne: true }]
                },
                { x: -327.5, y: 75, z: 226.5, toPlace: [] },
                { x: -327.5, y: 75, z: 240.5, toPlace: [] },
                { x: -329, y: 75, z: 246, toPlace: [] }
            ]
        };

        bot.emit('path_update', result);

        assert.equal(result.path.length, 5);
        bot.entity.position = { x: -330, y: 75, z: 227.5 };
        await tracker.tick();
        assert.equal(activations.length, 1);
        assert.equal(tracker.trackedCount, 1);
    });

    it('closes a bot-opened passage only after crossing, even if the goal changes', async () => {
        const closed = setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: false,
            facing: 'north',
            half: 'lower'
        });
        authorizePathDoor(closed);
        await bot.activateBlock(closed);
        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        bot.emit('goal_updated', { name: 'replacement' });
        await tracker.tick();
        assert.equal(activations.length, 1);

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();
        assert.equal(activations.length, 2);
    });

});
