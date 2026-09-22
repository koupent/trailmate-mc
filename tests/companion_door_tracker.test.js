import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DoorTracker,
    doorSide,
    PASSAGE_ABANDON_DISTANCE,
    PASSAGE_ABANDON_MAX_DISTANCE,
    PASSAGE_RETRY_COOLDOWN_MS,
    PASSAGE_STAGE,
    PASSAGE_TIMEOUT_MS,
    evaluatePassage,
    isAbandonedPassage,
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

describe('isAbandonedPassage', () => {
    /** Door at 0,64,0 puts its center at x 0.5 / z 0.5, at the bot's own level. */
    const openedByBot = { openedByBot: true, doorPos: { x: 0, y: 64, z: 0 } };

    it('fires once the bot leaves a passage it opened itself', () => {
        assert.equal(isAbandonedPassage(openedByBot, { x: 0.5, y: 64, z: 6.5 }), true);
    });

    it('does not fire while the bot is still at the passage', () => {
        assert.equal(isAbandonedPassage(openedByBot, { x: 0.5, y: 64, z: 3.5 }), false);
    });

    it('does not fire from too far to be worth walking back', () => {
        assert.equal(isAbandonedPassage(openedByBot, { x: 0.5, y: 64, z: 12.5 }), false);
    });

    it('never fires for a passage the owner opened', () => {
        assert.equal(
            isAbandonedPassage(
                { openedByBot: false, doorPos: { x: 0, y: 64, z: 0 } },
                { x: 0.5, y: 64, z: 6.5 }
            ),
            false
        );
    });

    it('measures in three dimensions, so leaving upwards counts', () => {
        assert.equal(isAbandonedPassage(openedByBot, { x: 0.5, y: 70, z: 0.5 }), true);
    });

    it('takes the departure distance as still at the passage', () => {
        assert.equal(
            isAbandonedPassage(openedByBot, {
                x: 0.5,
                y: 64,
                z: 0.5 + PASSAGE_ABANDON_DISTANCE
            }),
            false
        );
    });

    it('still returns from exactly the maximum distance', () => {
        assert.equal(
            isAbandonedPassage(openedByBot, {
                x: 0.5,
                y: 64,
                z: 0.5 + PASSAGE_ABANDON_MAX_DISTANCE
            }),
            true
        );
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

describe('DoorTracker passage transactions', () => {
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

    /**
     * Pathfinder-shaped route crossing a north/south passage from +z to -z,
     * with the integer node coordinates mineflayer-pathfinder emits.
     */
    function routeThrough(pos) {
        return [
            { x: pos.x, y: pos.y, z: pos.z + 2, toPlace: [] },
            { x: pos.x, y: pos.y, z: pos.z + 1, toPlace: [] },
            { x: pos.x, y: pos.y, z: pos.z, toPlace: [{ ...pos, useOne: true }] },
            { x: pos.x, y: pos.y, z: pos.z - 1, toPlace: [] },
            { x: pos.x, y: pos.y, z: pos.z - 2, toPlace: [] }
        ];
    }

    function emitRoute(pos, status = 'success') {
        const result = { status, path: routeThrough(pos) };
        bot.emit('path_update', result);
        return result;
    }

    /** Owner swing + look + closed-to-open update, leaving the door open. */
    function ownerOpens(name, pos, props) {
        const closed = setBlock(name, pos, { ...props, open: false });
        bot.blockAtEntityCursor = () => closed;
        bot.emit('entitySwingArm', owner);
        const openProps = { ...props, open: true };
        bot.emit('blockUpdate', closed, makeBlock(name, pos, openProps));
        return setBlock(name, pos, openProps);
    }

    /** Collect the warnings a failing transaction records. */
    async function withWarnings(fn) {
        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await fn();
        } finally {
            console.warn = originalWarn;
        }
        return warnings;
    }

    /** Drive the transaction exactly the way PassageTransitBehavior does. */
    async function runStep() {
        const step = tracker.advancePassage();
        if (step.action === 'open') await tracker.openPassage();
        else if (step.action === 'close') await tracker.closePassage();
        else if (step.action === 'done') tracker.finishPassage();
        else if (step.action === 'fail') tracker.failPassage(step.reason);
        return step;
    }

    beforeEach(() => {
        blocks = new Map();
        activations = [];
        now = 10_000;
        activationFailures = 0;
        owner = {
            id: 42,
            position: { x: 0.5, y: 64, z: 0, offset() { return this; } },
            height: 1.62,
            pitch: 0,
            yaw: 0
        };
        bot = new EventEmitter();
        bot.entity = { position: { x: 0.5, y: 64, z: 2.5 } };
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

    it('requests a transaction for the first closed passage a route crosses', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });

        emitRoute({ x: 0, y: 64, z: 0 });

        assert.equal(tracker.passagePending, true);
        const transaction = tracker.passageTransaction;
        assert.equal(transaction.key, '0,64,0');
        assert.equal(transaction.stage, PASSAGE_STAGE.approach);
        assert.equal(transaction.source, 'route');
        assert.equal(transaction.claimed, false);
    });

    it('strips the pathfinder door action so nothing opens beside the FSM', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });

        const result = emitRoute({ x: 0, y: 64, z: 0 });

        assert.deepEqual(result.path[2].toPlace, []);
        assert.equal(activations.length, 0);
    });

    it('handles only the first passage of a route that crosses several', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
        setBlock('oak_fence_gate', { x: 0, y: 64, z: -4 }, { facing: 'north', open: false });
        const path = [
            ...routeThrough({ x: 0, y: 64, z: 0 }),
            { x: 0, y: 64, z: -3, toPlace: [] },
            { x: 0, y: 64, z: -4, toPlace: [{ x: 0, y: 64, z: -4, useOne: true }] },
            { x: 0, y: 64, z: -5, toPlace: [] },
            { x: 0, y: 64, z: -6, toPlace: [] }
        ];

        bot.emit('path_update', { status: 'success', path });

        assert.equal(tracker.passageTransaction.key, '0,64,0');
        assert.deepEqual(path[6].toPlace, []);
    });

    it('drops an unclaimed route candidate when the route is invalidated', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
        emitRoute({ x: 0, y: 64, z: 0 });

        bot.emit('path_reset', 'goal_updated');

        assert.equal(tracker.passagePending, false);
    });

    it('keeps an acquired transaction across path_reset and goal_updated', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
        emitRoute({ x: 0, y: 64, z: 0 });
        tracker.claimPassage();

        bot.emit('goal_updated', { name: 'replacement' });
        bot.emit('path_reset', 'goal_updated');

        assert.equal(tracker.passagePending, true);
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.approach);
    });

    it('ignores incomplete routes', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });

        emitRoute({ x: 0, y: 64, z: 0 }, 'partial');

        assert.equal(tracker.passagePending, false);
    });

    it('ignores a route that returns through the same passage', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
        const path = [
            { x: 0, y: 64, z: 1, toPlace: [] },
            { x: 0, y: 64, z: 0, toPlace: [{ x: 0, y: 64, z: 0, useOne: true }] },
            { x: 0, y: 64, z: -1, toPlace: [] },
            { x: 0, y: 64, z: 1, toPlace: [] }
        ];

        bot.emit('path_update', { status: 'success', path });

        assert.equal(tracker.passagePending, false);
    });

    it('ignores routes that never cross a passage', () => {
        setBlock('oak_fence_gate', { x: 4, y: 64, z: 4 }, { facing: 'north', open: false });

        bot.emit('path_update', {
            status: 'success',
            path: [
                { x: 0, y: 64, z: 1, toPlace: [] },
                { x: 0, y: 64, z: 2, toPlace: [] }
            ]
        });

        assert.equal(tracker.passagePending, false);
    });

    it('never requests a transaction for iron doors or trapdoors', () => {
        for (const name of ['iron_door', 'iron_trapdoor', 'oak_trapdoor']) {
            setBlock(name, { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
            emitRoute({ x: 0, y: 64, z: 0 });
            assert.equal(tracker.passagePending, false, name);
        }
    });

    it('refuses passage activation requested outside passage transit', async () => {
        const gate = setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            open: false
        });
        emitRoute({ x: 0, y: 64, z: 0 });

        await assert.rejects(() => bot.activateBlock(gate), /passage_transit/);
        assert.equal(activations.length, 0);
    });

    it('still forwards non-passage activations, such as graves', async () => {
        const grave = setBlock('player_head', { x: 3, y: 64, z: 3 }, {});

        await bot.activateBlock(grave);

        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'player_head');
    });

    it('walks to the route stand point while out of activation range', () => {
        setBlock('oak_fence_gate', { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
        emitRoute({ x: 0, y: 64, z: 0 });
        bot.entity.position = { x: 0.5, y: 64, z: 9 };

        const step = tracker.advancePassage();

        assert.equal(step.action, 'move');
        assert.deepEqual(step.target, { x: 0.5, y: 64, z: 1.5 });
    });

    it('runs open, crossing, and close as one transaction', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        // 1-2. Already within reach: stop and open.
        assert.equal((await runStep()).action, 'open');
        assert.equal(activations.length, 1);
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.approach);

        // 3. Nothing advances until the world publishes the open state.
        assert.equal((await runStep()).action, 'hold');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });

        // 4. Confirmed open: walk to the far side of the passage.
        const crossing = await runStep();
        assert.equal(crossing.action, 'move');
        assert.deepEqual(crossing.target, { x: 0.5, y: 64, z: -1.5 });
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.crossing);

        // 5. Clear of the passage: close it.
        bot.entity.position = { x: 0.5, y: 64, z: -1.5 };
        assert.equal((await runStep()).action, 'close');
        assert.equal(activations.length, 2);
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.closing);

        // 6. Only the confirmed closed state ends the transaction.
        assert.equal((await runStep()).action, 'hold');
        assert.equal(tracker.passagePending, true);
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');
        assert.equal(tracker.passagePending, false);
    });

    it('stays at the passage and retries when the open state is delayed', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        await runStep();
        assert.equal(activations.length, 1);

        // Confirmation window: hold in reach instead of walking away.
        now += 2500;
        assert.equal((await runStep()).action, 'hold');
        assert.equal(activations.length, 1);

        // Window expired, short retry backoff.
        now += 1;
        assert.equal((await runStep()).action, 'hold');
        now += 600;
        assert.equal((await runStep()).action, 'open');
        assert.equal(activations.length, 2);
    });

    it('retries an open whose activation failed', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();
        activationFailures = 1;

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await runStep();
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(activations.length, 1);
        assert.equal(tracker.passagePending, true);
        assert.match(warnings[0], /passage open failed/);

        now += 600;
        assert.equal((await runStep()).action, 'open');
        assert.equal(activations.length, 2);
    });

    it('retries a close that the world state does not reflect', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        ownerOpens('oak_fence_gate', gatePos, { facing: 'north' });
        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.closing);
        assert.equal((await runStep()).action, 'close');
        assert.equal(activations.length, 1);

        now += 1201;
        assert.equal((await runStep()).action, 'hold');
        now += 600;
        assert.equal((await runStep()).action, 'close');
        assert.equal(activations.length, 2);
    });

    it('starts at the closing stage for a passage the owner opened', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, { facing: 'north', half: 'lower' });
        assert.equal(tracker.trackedCount, 1);
        assert.equal(tracker.passagePending, false);

        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        assert.equal(tracker.passagePending, false, 'not crossed yet');

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();

        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.closing);
        assert.equal(tracker.passageTransaction.source, 'tracked');
        assert.equal(activations.length, 0, 'detection never operates the door');
    });

    it('forgets a tracked passage that closes on its own', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, { facing: 'north', half: 'lower' });
        setBlock('oak_door', { x: 0, y: 64, z: 0 }, {
            facing: 'north',
            half: 'lower',
            open: false
        });

        await tracker.tick();

        assert.equal(tracker.trackedCount, 0);
        assert.equal(tracker.passagePending, false);
    });

    it('does not consume the deadline while suspended for safety', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();

        tracker.resumePassage();
        now += 10_000;
        tracker.suspendPassage();
        now += 60_000;

        tracker.resumePassage();
        assert.equal((await runStep()).action, 'open');
        assert.equal(tracker.passagePending, true);
    });

    it('fails with a recorded reason after the deadline and backs off', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();
        now += PASSAGE_TIMEOUT_MS + 1;

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            assert.equal((await runStep()).action, 'fail');
        } finally {
            console.warn = originalWarn;
        }

        assert.equal(tracker.passagePending, false);
        assert.match(warnings[0], /passage transit failed \(timeout\) at 0,64,0/);

        // The same passage must not immediately request another transaction.
        emitRoute(gatePos);
        assert.equal(tracker.passagePending, false);

        now += PASSAGE_RETRY_COOLDOWN_MS + 1;
        emitRoute(gatePos);
        assert.equal(tracker.passagePending, true);
    });

    it('ends the transaction when the passage block disappears', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        blocks.delete('0,64,0');

        assert.equal((await runStep()).action, 'done');
        assert.equal(tracker.passagePending, false);
    });

    it('reopens from the same transaction when the passage closes mid-crossing', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        await runStep();
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        assert.equal((await runStep()).action, 'move');
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.crossing);

        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'hold');
        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.approach);

        now += 600;
        assert.equal((await runStep()).action, 'open');
    });

    it('goes back to close a gate it opened but never crossed (timeout)', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'open');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });

        now += PASSAGE_TIMEOUT_MS + 1;
        const warnings = await withWarnings(async () => {
            assert.equal((await runStep()).action, 'fail');
        });

        // The failure hands back an open gate the bot is responsible for.
        assert.match(warnings[0], /passage transit failed \(timeout\) at 0,64,0, left open/);
        assert.equal(tracker.passagePending, false);
        assert.equal(blocks.get('0,64,0')._properties.open, true);
        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: true, openObserved: false }
        ]);

        // The bot turns back to the side it approached from, so the crossing
        // rule can never fire: only the departure rule closes this gate.
        now += PASSAGE_RETRY_COOLDOWN_MS + 1;
        bot.entity.position = { x: 0.5, y: 64, z: 6.5 };
        await tracker.tick();

        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.closing);
        assert.equal(tracker.passageTransaction.source, 'tracked');

        assert.equal((await runStep()).action, 'move');
        bot.entity.position = { x: 0.5, y: 64, z: 2 };
        assert.equal((await runStep()).action, 'close');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');

        assert.equal(tracker.passagePending, false);
        assert.equal(activations.length, 2);
    });

    it('goes back to close a gate left open by an unreachable route', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'open');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        await withWarnings(async () => tracker.failPassage('unreachable'));

        now += PASSAGE_RETRY_COOLDOWN_MS + 1;
        bot.entity.position = { x: 0.5, y: 64, z: 6.5 };
        await tracker.tick();

        assert.equal(tracker.passageTransaction.stage, PASSAGE_STAGE.closing);

        bot.entity.position = { x: 0.5, y: 64, z: 2 };
        assert.equal((await runStep()).action, 'close');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');
        assert.equal(activations.length, 2);
    });

    it('does not walk back to a gate it opened from too far away', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'open');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        await withWarnings(async () => tracker.failPassage('unreachable'));
        now += PASSAGE_RETRY_COOLDOWN_MS + 1;

        bot.entity.position = { x: 0.5, y: 64, z: 15.5 };
        await tracker.tick();
        assert.equal(tracker.passagePending, false, 'too far to be worth the walk');

        bot.entity.position = { x: 0.5, y: 64, z: 6.5 };
        await tracker.tick();
        assert.equal(tracker.passagePending, true);
    });

    it('leaves a passage the owner opened alone when the bot only turns back', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, { facing: 'north', half: 'lower' });

        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        bot.entity.position = { x: 0.5, y: 64, z: 8.5 };
        await tracker.tick();

        assert.equal(tracker.passagePending, false);
        assert.equal(activations.length, 0);
        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: false, openObserved: true }
        ]);
    });

    it('records the bot as the opener even when the owner stands at the passage', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        const closed = setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();
        owner.position = { x: 0.5, y: 64, z: 0.5, offset() { return this; } };

        assert.equal((await runStep()).action, 'open');
        // Origin is recorded at the request, before the world confirms anything.
        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: true, openObserved: false }
        ]);

        // The server's update lands with the owner standing at the gate; the
        // established origin must win over the owner-proximity attribution.
        bot.emit('blockUpdate', closed, makeBlock('oak_fence_gate', gatePos, {
            facing: 'north',
            open: true
        }));

        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: true, openObserved: true }
        ]);
    });

    it('keeps the bot as the opener when the open is confirmed late', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'open');

        // The record expires while the open is still unconfirmed.
        now += 2501;
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);

        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        assert.equal((await runStep()).action, 'move');
        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: true, openObserved: true }
        ]);
    });

    it('drops the record when the open never takes effect', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        emitRoute(gatePos);
        tracker.claimPassage();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'open');
        assert.equal(tracker.trackedCount, 1);

        // The gate never publishes an open state: nothing is left to close.
        now += 2501;
        await tracker.tick();

        assert.equal(tracker.trackedCount, 0);
    });
});
