import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    CLOSE_MAX_DISTANCE,
    DoorTracker,
    PASSAGE_DONE_COOLDOWN_MS,
    PASSAGE_FAIL_COOLDOWN_MS,
    PASSAGE_JOB_TIMEOUT_MS,
    doorSide,
    isCloseablePassage,
    isDoorBetween,
    normalizeDoorPos,
    posKey,
    selectPassageJob
} from '../src/companion/movement/DoorTracker.js';
import { evaluatePassage, isClosedToOpen } from '../src/companion/movement/ownerDoors.js';

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
            normalizeDoorPos({ position: { x: 1, y: 70, z: 2 }, _properties: {} }),
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
        const tracked = { approachSide: null, facing: 'north', passagePos: { x: 0, y: 64, z: 0 } };
        const near = evaluatePassage(tracked, { x: 0.5, y: 64, z: 1.5 });
        assert.equal(near.approachSide, 1);
        assert.equal(near.readyToClose, false);
    });

    it('is ready to close only after crossing to the opposite side with clearance', () => {
        const tracked = { approachSide: 1, facing: 'north', passagePos: { x: 0, y: 64, z: 0 } };
        assert.equal(evaluatePassage(tracked, { x: 0.5, y: 64, z: -0.2 }).readyToClose, false);
        assert.equal(evaluatePassage(tracked, { x: 0.5, y: 64, z: -2 }).readyToClose, true);
    });
});

describe('isDoorBetween', () => {
    const door = { x: 22, y: 63, z: 551 };

    it('rejects owner perched on the door sill (repro case)', () => {
        // Bot inside (south), owner 4cm past door center — must NOT open.
        assert.equal(
            isDoorBetween({ x: 22.5, z: 550.05 }, { x: 22.54, z: 551.51 }, door, 'north'),
            false
        );
    });

    it('accepts owner clearly through the door', () => {
        assert.equal(
            isDoorBetween({ x: 22.5, z: 550.05 }, { x: 22.5, z: 553.5 }, door, 'north'),
            true
        );
    });

    it('rejects when both are on the same side', () => {
        assert.equal(
            isDoorBetween({ x: 22.5, z: 549.5 }, { x: 22.5, z: 550.5 }, door, 'north'),
            false
        );
    });

    it('rejects an unrelated passage whose infinite plane crosses the owner', () => {
        assert.equal(
            isDoorBetween({ x: 0.5, z: 0.5 }, { x: 0.5, z: 6.5 }, { x: 2, z: 1 }, 'north'),
            false
        );
    });
});

describe('selectPassageJob', () => {
    /** @returns {import('../src/companion/movement/DoorTracker.js').PassageCandidate} */
    function candidate(key, overrides = {}) {
        return {
            key,
            passagePos: { x: 0, y: 64, z: 0 },
            facing: 'north',
            approachPoint: null,
            open: false,
            needed: false,
            owed: false,
            distance: 2,
            inReach: true,
            cooldown: false,
            ...overrides
        };
    }

    it('opens a passage the route needs and finds closed', () => {
        assert.deepEqual(
            selectPassageJob([candidate('a', { needed: true })]),
            { key: 'a', intent: 'open', reason: 'needed' }
        );
    });

    it('opens the nearest of several needed passages first', () => {
        const job = selectPassageJob([
            candidate('far', { needed: true, distance: 9 }),
            candidate('near', { needed: true, distance: 3 })
        ]);
        assert.equal(job.key, 'near');
    });

    it('never closes a passage the route still goes through', () => {
        assert.equal(
            selectPassageJob([candidate('a', { needed: true, owed: true, open: true })]),
            null
        );
    });

    it('closes a passage the bot owes once the route stops needing it', () => {
        assert.deepEqual(
            selectPassageJob([candidate('a', { owed: true, open: true })]),
            { key: 'a', intent: 'close', reason: 'crossed' }
        );
    });

    it('opens before walking back to close: the bot never turns around', () => {
        const job = selectPassageJob([
            candidate('behind', { owed: true, open: true, distance: 8, inReach: false }),
            candidate('ahead', { needed: true, distance: 9 })
        ]);
        assert.deepEqual(job, { key: 'ahead', intent: 'open', reason: 'needed' });
    });

    it('closes first when it costs no movement at all', () => {
        const job = selectPassageJob([
            candidate('justCrossed', { owed: true, open: true, distance: 2, inReach: true }),
            candidate('ahead', { needed: true, distance: 9 })
        ]);
        assert.deepEqual(job, { key: 'justCrossed', intent: 'close', reason: 'crossed' });
    });

    it('ignores a passage still on cooldown', () => {
        assert.equal(
            selectPassageJob([candidate('a', { needed: true, cooldown: true })]),
            null
        );
    });

    it('does not close a passage the bot is still standing in', () => {
        assert.equal(
            selectPassageJob([candidate('a', { owed: true, open: true, distance: 0.8 })]),
            null
        );
    });

    it('does not close a passage too far to be worth the walk back', () => {
        assert.equal(
            selectPassageJob([candidate('a', {
                owed: true,
                open: true,
                distance: CLOSE_MAX_DISTANCE + 0.1,
                inReach: false
            })]),
            null
        );
    });
});

describe('DoorTracker passage jobs', () => {
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
    /** @type {string[]} */
    let logs;
    /** @type {Array<any>} The live route array, as mineflayer-pathfinder holds it. */
    let route;
    let now;
    let activationFailures;
    let originalLog;

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

    function gateAt(pos, props = {}) {
        return setBlock('oak_fence_gate', pos, { facing: 'north', open: false, ...props });
    }

    function isOpen(pos) {
        return blocks.get(`${pos.x},${pos.y},${pos.z}`)?._properties?.open === true;
    }

    /**
     * Pathfinder-shaped corridor along z at x=0, with the door action a closed
     * passage gets. Nodes carry the integer coordinates A* emits.
     */
    function corridor(fromZ, toZ, gates = []) {
        const step = toZ > fromZ ? 1 : -1;
        const path = [];
        for (let z = Math.floor(fromZ) + step; ; z += step) {
            const node = { x: 0, y: 64, z, toPlace: [] };
            const gate = gates.find((pos) => pos.z === z);
            if (gate && !isOpen(gate)) node.toPlace.push({ ...gate, useOne: true });
            path.push(node);
            if (z === toZ) break;
        }
        return path;
    }

    function emitRoute(fromZ, toZ, gates, status = 'success') {
        route = corridor(fromZ, toZ, gates);
        bot.emit('path_update', { status, path: route });
        return route;
    }

    /**
     * Walk the bot along the live route. mineflayer-pathfinder shifts each node
     * off the array as the bot reaches it, and the tracker reads what is left.
     */
    function walkTo(z) {
        bot.entity.position = { x: 0.5, y: 64, z };
        while (route.length && route[0].z + 0.5 >= z) route.shift();
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

    /** Collect the warnings a failing job records. */
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

    /** Drive the job exactly the way PassageTransitBehavior does. */
    async function runStep() {
        const step = tracker.advancePassage();
        if (step.action === 'activate') await tracker.activatePassage();
        else if (step.action === 'done') tracker.finishPassage();
        else if (step.action === 'fail') tracker.failPassage(step.reason);
        return step;
    }

    beforeEach(() => {
        blocks = new Map();
        activations = [];
        logs = [];
        route = [];
        now = 10_000;
        activationFailures = 0;
        originalLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
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
        bot.blockAt = (pos) => blocks.get(
            `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
        ) || null;
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
        console.log = originalLog;
    });

    it('takes an open job for a closed passage the route goes through', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);

        await tracker.tick();

        assert.equal(tracker.passagePending, true);
        assert.deepEqual(tracker.passageJob, {
            key: '0,64,0',
            intent: 'open',
            reason: 'needed',
            passagePos: { x: 0, y: 64, z: 0 },
            facing: 'north'
        });
    });

    it('strips the pathfinder door action so nothing opens beside the FSM', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        const path = emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);

        await tracker.tick();

        assert.deepEqual(path.find((node) => node.z === 0).toPlace, []);
        assert.equal(activations.length, 0);
    });

    it('takes on every passage of a route, not only the first', async () => {
        const gates = [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: -4 }];
        gates.forEach((pos) => gateAt(pos));
        const path = emitRoute(2.5, -7, gates);

        await tracker.tick();

        // Every door action is stripped, so every passage must be handled: one
        // left out would be a gate nobody can open.
        assert.deepEqual(path.flatMap((node) => node.toPlace), []);
        assert.deepEqual(tracker.neededPassages.sort(), ['0,64,-4', '0,64,0']);
        assert.equal(tracker.passageJob.key, '0,64,0', 'nearest first');
    });

    it('ignores routes that never reach a passage', async () => {
        gateAt({ x: 4, y: 64, z: 4 });

        bot.emit('path_update', {
            status: 'success',
            path: [
                { x: 0, y: 64, z: 1, toPlace: [] },
                { x: 0, y: 64, z: 2, toPlace: [] }
            ]
        });
        await tracker.tick();

        assert.equal(tracker.passagePending, false);
        assert.deepEqual(tracker.neededPassages, []);
    });

    it('never takes a job for iron doors or trapdoors', async () => {
        for (const name of ['iron_door', 'iron_trapdoor', 'oak_trapdoor']) {
            setBlock(name, { x: 0, y: 64, z: 0 }, { facing: 'north', open: false });
            emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);
            await tracker.tick();
            assert.equal(tracker.passagePending, false, name);
        }
    });

    it('refuses passage activation requested outside passage transit', async () => {
        const gate = gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);
        await tracker.tick();

        await assert.rejects(() => bot.activateBlock(gate), /passage_transit/);
        assert.equal(activations.length, 0);
    });

    it('still forwards non-passage activations, such as graves', async () => {
        const grave = setBlock('player_head', { x: 3, y: 64, z: 3 }, {});

        await bot.activateBlock(grave);

        assert.equal(activations.length, 1);
        assert.equal(activations[0].name, 'player_head');
    });

    it('walks to the route stand point while out of activation range', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(9, -3, [{ x: 0, y: 64, z: 0 }]);
        bot.entity.position = { x: 0.5, y: 64, z: 9 };
        await tracker.tick();

        const step = tracker.advancePassage();

        assert.equal(step.action, 'move');
        assert.deepEqual(step.target, { x: 0.5, y: 64, z: 1.5 });
    });

    it('opens, hands movement back, and closes only once the route is past it', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();

        // 1. Already within reach: activate straight away, no crossing stage.
        assert.equal((await runStep()).action, 'activate');
        assert.equal(activations.length, 1);

        // 2. Nothing advances until the world publishes the open state.
        assert.equal((await runStep()).action, 'hold');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        assert.equal((await runStep()).action, 'done');
        assert.equal(tracker.passagePending, false, 'movement goes back to normal work');

        // 3. Ordinary movement carries the bot through. Until a route says the
        //    gate is behind the bot, it stays owed but untouched.
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        assert.deepEqual(tracker.neededPassages, ['0,64,0']);
        assert.equal(tracker.passagePending, false, 'never shut in the bot\'s own face');

        // 4. Through it: the very next selection closes it, from where it stands.
        walkTo(-1.5);
        await tracker.tick();
        assert.equal(tracker.passageJob.intent, 'close');
        assert.equal(tracker.passageJob.reason, 'crossed');

        assert.equal((await runStep()).action, 'activate');
        assert.equal(activations.length, 2);
        assert.equal((await runStep()).action, 'hold');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');
        assert.equal(tracker.passagePending, false);
        assert.equal(tracker.trackedCount, 0, 'the debt is settled');
    });

    it('logs the completion of every open and close', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();

        await runStep();
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        await runStep();

        assert.ok(logs.some((line) => /passage job open at 0,64,0 \(needed\)/.test(line)));
        assert.ok(logs.some((line) => /passage open done at 0,64,0 \(needed\)/.test(line)));
    });

    it('never closes a gate it is about to walk through again', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos, { open: true });
        // The bot owes this gate and has already walked past it.
        emitRoute(2.5, -3, [gatePos]);
        walkTo(-1.5);
        await tracker.tick();
        tracker._owed.set('0,64,0', {
            key: '0,64,0',
            passagePos: gatePos,
            facing: 'north',
            openedAt: now,
            openObserved: true,
            awaitingRoute: false,
            via: 'bot'
        });
        await tracker.tick();
        assert.equal(tracker.passageJob.intent, 'close');

        // The owner doubles back, so the new route goes through it once more.
        emitRoute(-1.5, 4, [gatePos]);
        await tracker.tick();

        assert.equal(tracker.passagePending, false);
        assert.deepEqual(tracker.neededPassages, ['0,64,0']);
    });

    it('does not reopen a gate the moment it finishes closing it', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos, { open: true });
        tracker._owed.set('0,64,0', {
            key: '0,64,0',
            passagePos: gatePos,
            facing: 'north',
            openedAt: now,
            openObserved: true,
            awaitingRoute: false,
            via: 'bot'
        });
        bot.entity.position = { x: 0.5, y: 64, z: -2.5 };
        await tracker.tick();

        assert.equal((await runStep()).action, 'activate');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');

        // The close publishes a block update, and the replan that follows puts
        // the door action straight back on the route.
        emitRoute(-2.5, 4, [gatePos]);
        await tracker.tick();
        assert.equal(tracker.passagePending, false, 'no immediate reopen');

        now += PASSAGE_DONE_COOLDOWN_MS + 1;
        await tracker.tick();
        assert.equal(tracker.passageJob.intent, 'open');
    });

    it('stays at the passage and retries when the open state is delayed', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();

        await runStep();
        assert.equal(activations.length, 1);

        // Confirmation window: hold in reach instead of walking away.
        now += 1200;
        assert.equal((await runStep()).action, 'hold');
        assert.equal(activations.length, 1);

        // Window expired: retry from where the bot already stands.
        now += 1;
        assert.equal((await runStep()).action, 'activate');
        assert.equal(activations.length, 2);
    });

    it('gives up on a passage whose state never follows the activation', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();

        const warnings = await withWarnings(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.equal((await runStep()).action, 'activate', `attempt ${attempt}`);
                now += 1201;
            }
            assert.equal((await runStep()).action, 'fail');
        });

        assert.equal(activations.length, 3);
        assert.equal(tracker.passagePending, false);
        assert.match(warnings[0], /passage open failed \(unconfirmed\) at 0,64,0/);
    });

    it('retries an open whose activation threw', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();
        activationFailures = 1;

        const warnings = await withWarnings(async () => runStep());
        assert.equal(activations.length, 1);
        assert.equal(tracker.passagePending, true);
        assert.match(warnings[0], /passage open failed/);

        assert.equal((await runStep()).action, 'activate');
        assert.equal(activations.length, 2);
    });

    it('does not consume the deadline while suspended for safety', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);
        await tracker.tick();

        tracker.resumePassage();
        now += 5_000;
        tracker.suspendPassage();
        now += 60_000;

        tracker.resumePassage();
        assert.equal((await runStep()).action, 'activate');
        assert.equal(tracker.passagePending, true);
    });

    it('fails with a recorded reason after the deadline and backs off', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();
        now += PASSAGE_JOB_TIMEOUT_MS + 1;

        const warnings = await withWarnings(async () => {
            assert.equal((await runStep()).action, 'fail');
        });

        assert.equal(tracker.passagePending, false);
        assert.match(warnings[0], /passage open failed \(timeout\) at 0,64,0/);

        // The same passage must not immediately request another job.
        await tracker.tick();
        assert.equal(tracker.passagePending, false);

        now += PASSAGE_FAIL_COOLDOWN_MS + 1;
        await tracker.tick();
        assert.equal(tracker.passagePending, true);
    });

    it('ends the job when the passage block disappears', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);
        await tracker.tick();
        blocks.delete('0,64,0');

        assert.equal((await runStep()).action, 'done');
        assert.equal(tracker.passagePending, false);
    });

    it('walks back to close a gate it opened but never went through', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'activate');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        await withWarnings(async () => tracker.failPassage('unreachable'));

        // The bot turns back the way it came, so no crossing ever happens: only
        // "the route no longer goes through it" can close this gate.
        now += PASSAGE_FAIL_COOLDOWN_MS + 1;
        emitRoute(2.5, 9, []);
        bot.entity.position = { x: 0.5, y: 64, z: 6.5 };
        await tracker.tick();

        assert.equal(tracker.passageJob.intent, 'close');
        assert.equal(tracker.passageJob.reason, 'left-open');

        assert.equal((await runStep()).action, 'move');
        bot.entity.position = { x: 0.5, y: 64, z: 2.5 };
        assert.equal((await runStep()).action, 'activate');
        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        assert.equal((await runStep()).action, 'done');
        assert.equal(activations.length, 2);
    });

    it('stands on its own side of the gate when it walks back to close', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos, { open: true });
        tracker._owed.set('0,64,0', {
            key: '0,64,0',
            passagePos: gatePos,
            facing: 'north',
            openedAt: now,
            openObserved: true,
            awaitingRoute: false,
            via: 'bot'
        });
        bot.entity.position = { x: 0.5, y: 64, z: -6.5 };
        await tracker.tick();

        const step = tracker.advancePassage();

        assert.equal(step.action, 'move');
        // Straight out from the doorway on the bot's own side, not a point
        // beyond the gate and not somewhere off along the fence.
        assert.deepEqual(step.target, { x: 0.5, y: 64, z: -1.75 });
    });

    it('does not walk back to a gate it opened from too far away', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos, { open: true });
        tracker._owed.set('0,64,0', {
            key: '0,64,0',
            passagePos: gatePos,
            facing: 'north',
            openedAt: now,
            openObserved: true,
            awaitingRoute: false,
            via: 'bot'
        });

        bot.entity.position = { x: 0.5, y: 64, z: CLOSE_MAX_DISTANCE + 2 };
        await tracker.tick();
        assert.equal(tracker.passagePending, false, 'too far to be worth the walk');

        bot.entity.position = { x: 0.5, y: 64, z: 6.5 };
        await tracker.tick();
        assert.equal(tracker.passagePending, true);
    });

    it('stops owing a close on a gate it never got back to', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        gateAt(gatePos, { open: true });
        tracker._owed.set('0,64,0', {
            key: '0,64,0',
            passagePos: gatePos,
            facing: 'north',
            openedAt: now,
            openObserved: true,
            awaitingRoute: false,
            via: 'bot'
        });
        // Far enough away that the debt can never come due from here.
        bot.entity.position = { x: 0.5, y: 64, z: 40 };

        now += 45_001;
        await tracker.tick();

        assert.equal(tracker.trackedCount, 0);
    });

    it('closes a passage the owner opened once the bot has gone through it', async () => {
        ownerOpens('oak_door', { x: 0, y: 64, z: 0 }, { facing: 'north', half: 'lower' });
        assert.equal(tracker.trackedCount, 1);

        bot.entity.position = { x: 0.5, y: 64, z: 1.8 };
        await tracker.tick();
        assert.equal(tracker.passagePending, false, 'not crossed yet');

        bot.entity.position = { x: 0.5, y: 64, z: -2 };
        await tracker.tick();

        assert.equal(tracker.passageJob.intent, 'close');
        assert.equal(tracker.passageJob.reason, 'crossed');
        assert.equal(activations.length, 0, 'detection never operates the door');
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

    it('records the bot as the opener even when the owner stands at the passage', async () => {
        const gatePos = { x: 0, y: 64, z: 0 };
        const closed = gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();
        owner.position = { x: 0.5, y: 64, z: 0.5, offset() { return this; } };

        assert.equal((await runStep()).action, 'activate');
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
        gateAt(gatePos);
        emitRoute(2.5, -3, [gatePos]);
        await tracker.tick();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'activate');

        // The debt expires while the open is still unconfirmed.
        now += 1201;
        await tracker.tick();
        assert.equal(tracker.trackedCount, 0);

        setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        assert.equal((await runStep()).action, 'done');
        assert.deepEqual(tracker.trackedPassages, [
            { key: '0,64,0', openedByBot: true, openObserved: true }
        ]);
    });

    it('drops the record when the open never takes effect', async () => {
        gateAt({ x: 0, y: 64, z: 0 });
        emitRoute(2.5, -3, [{ x: 0, y: 64, z: 0 }]);
        await tracker.tick();
        tracker.resumePassage();

        assert.equal((await runStep()).action, 'activate');
        assert.equal(tracker.trackedCount, 1);

        // The gate never publishes an open state: nothing is left to close.
        now += 1201;
        await tracker.tick();

        assert.equal(tracker.trackedCount, 0);
    });
});
