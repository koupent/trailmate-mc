import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DoorTracker,
    doorSide,
    evaluatePassage,
    isCloseablePassage,
    isClosedToOpen,
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
            return Promise.resolve();
        };
        tracker = new DoorTracker(bot, { getOwnerEntity: () => owner });
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
        assert.equal(tracker.trackedCount, 0);

        // Already forgotten: a second tick must not activate again.
        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            open: true,
            facing: 'north',
            half: 'lower'
        });
        await tracker.tick();
        assert.equal(activations.length, 1);
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

        bot.entity.position = { x: 3.5, y: 64, z: 2.5 };
        await tracker.tick();
        bot.entity.position = { x: 0.2, y: 64, z: 2.5 };
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
        assert.equal(tracker.trackedCount, 0);
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

        assert.equal(tracker.trackedCount, 0);
        assert.equal(activations.length, 2);
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
        await bot.activateBlock(closed);
        await bot.activateBlock(closed);
        assert.equal(tracker.trackedCount, 1);
    });
});
