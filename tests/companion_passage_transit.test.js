/**
 * End-to-end passage transit against the real orchestrator.
 *
 * The reported failure was a route through two gates: the companion opened the
 * first without closing it, walked to the second, turned back to close the
 * first, shut the second in its own face on the way, and stalled for seconds at
 * every step. The two-gate case is therefore the headline test here, and what
 * it asserts is that the bot only ever moves forward.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DoorTracker,
    PASSAGE_FAIL_COOLDOWN_MS,
    PASSAGE_JOB_TIMEOUT_MS
} from '../src/companion/movement/DoorTracker.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';

/** Everything happens in a one-block corridor along z. */
const GATE_POS = { x: 0, y: 64, z: 0 };
/** Second gate of the reported route, far enough to need its own approach. */
const FAR_GATE_POS = { x: 0, y: 64, z: -6 };
/** Where a closed gate stops the walk, and so where it is operated from. */
const APPROACH_Z = 1.5;
/** One tick of walking. A bot that teleports past a gate proves nothing. */
const WALK_STEP = 2;
/** Milliseconds one orchestrator tick stands for. */
const TICK_MS = 50;

function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Minimal but faithful world: pathfinder-shaped routes whose nodes are consumed
 * as the bot walks them, gates that only let the bot through while open, and
 * block state that follows activation.
 */
function makePassageWorld(options = {}) {
    const blocks = new Map();
    const activations = [];
    const gates = options.gates || [GATE_POS];
    let now = 100_000;

    const world = {
        activations,
        gates,
        /** Every position the bot has stood at, oldest first. */
        track: [],
        /** How often anything stopped ordinary movement. */
        stops: 0,
        /** Drop block-state updates so an activation stays unconfirmed. */
        suspendBlockUpdates: false,
        /** The live route array, exactly as mineflayer-pathfinder holds it. */
        route: [],
        now: () => now,
        advance(ms) { now += ms; }
    };

    const bot = new EventEmitter();
    world.bot = bot;
    bot.entity = { position: { x: 0.5, y: 64, z: 3.5 } };
    bot.entities = {};
    bot.players = {};
    bot.inventory = { emptySlotCount: () => 5, items: () => [{ name: 'iron_sword' }] };
    bot.heldItem = { name: 'iron_sword' };
    bot.pvp = { target: null };
    bot.blockAtEntityCursor = () => null;
    bot.blockAt = (pos) => blocks.get(blockKey(pos)) || null;

    world.setBlock = (name, pos, props) => {
        const block = {
            name,
            position: { x: pos.x, y: pos.y, z: pos.z },
            _properties: { ...props }
        };
        blocks.set(blockKey(pos), block);
        return block;
    };
    world.blockFor = (pos) => blocks.get(blockKey(pos));
    world.isOpen = (pos) => world.blockFor(pos)?._properties?.open === true;
    world.setOpen = (pos, open) => {
        const block = world.blockFor(pos);
        if (block) block._properties.open = open;
    };
    world.openGates = () => gates.filter((pos) => world.isOpen(pos));
    for (const pos of gates) {
        world.setBlock(options.gateName || 'oak_fence_gate', pos, {
            facing: 'north',
            open: false
        });
    }

    bot.activateBlock = (block) => {
        activations.push({ name: block.name, at: blockKey(block.position) });
        if (!world.suspendBlockUpdates) {
            block._properties.open = block._properties.open !== true;
        }
        return Promise.resolve();
    };

    /** Pathfinder-shaped corridor, with the door action a closed gate gets. */
    function buildPath(fromZ, toZ) {
        const startZ = Math.floor(fromZ);
        const endZ = Math.floor(toZ);
        if (startZ === endZ) return [];
        const step = endZ > startZ ? 1 : -1;
        const path = [];
        for (let z = startZ + step; ; z += step) {
            const node = { x: GATE_POS.x, y: GATE_POS.y, z, toPlace: [] };
            const gate = gates.find((pos) => pos.z === z);
            if (gate && !world.isOpen(gate)) node.toPlace.push({ ...gate, useOne: true });
            path.push(node);
            if (z === endZ) break;
        }
        return path;
    }

    /**
     * One tick of walking: a couple of blocks toward the goal, stopping on the
     * near side of the first closed gate. Consumed nodes leave the live route,
     * which is how the tracker learns a passage is behind the bot.
     */
    function walkTo(target) {
        const from = bot.entity.position.z;
        const direction = Math.sign(target.z - from);
        if (direction === 0) return;
        const short = (a, b) => (direction > 0 ? a < b : a > b);

        let z = from + direction * WALK_STEP;
        if (short(target.z, z)) z = target.z;
        for (const gate of gates) {
            if (world.isOpen(gate)) continue;
            const center = gate.z + 0.5;
            if (!short(from, center)) continue;
            const nearSide = center - direction;
            if (short(nearSide, z)) z = nearSide;
        }

        bot.entity.position = { x: 0.5, y: 64, z };
        world.track.push(z);
        const passed = (nodeZ) => (direction > 0 ? nodeZ + 0.5 <= z : nodeZ + 0.5 >= z);
        while (world.route.length && passed(world.route[0].z)) world.route.shift();
    }

    const movement = {
        status: 'idle',
        goal: null,
        isHeld: false,
        get isBlocked() { return this.status === 'noPath' || this.status === 'timeout'; },
        get isUnreachable() { return this.status === 'unreachable'; },
        get hasGoal() { return this.goal != null; },
        get isTryingToMove() { return this.goal != null; },
        tickHoldWatchdog() {},
        stop() {
            world.stops += 1;
            this.goal = null;
            this.status = 'idle';
            bot.emit('goal_updated', null);
            bot.emit('path_reset', 'goal_updated');
        },
        goToward(pos) {
            this.goal = { ...pos };
            bot.emit('goal_updated', this.goal);
            bot.emit('path_reset', 'goal_updated');
            if (this.status === 'noPath') return true;
            this.status = 'searching';
            const path = buildPath(bot.entity.position.z, pos.z);
            if (path.length > 0) {
                world.route = path;
                bot.emit('path_update', { status: 'success', path });
            }
            walkTo(pos);
            return true;
        }
    };
    world.movement = movement;

    world.addDrop = (id, z) => {
        bot.entities[id] = { id, name: 'item', position: { x: 0.5, y: 64, z } };
        return bot.entities[id];
    };
    world.removeDrop = (id) => { delete bot.entities[id]; };

    const ctx = {
        bot,
        movement,
        config: {
            tick_ms: 5,
            awareness_radius: 12,
            nearby_loot: { enabled: true, radius: 12, max_ms: 400, quiet_ms: 50, grace_ms: 50 },
            owner_work: { enabled: false },
            reflexes: { hostile_range: 16 },
            own_grave: { scan_radius: 10 }
        },
        ownerName: null,
        ownerEntity: null,
        worldState: { update() {} },
        stuck: { update() {}, seconds: 0 },
        hazardEscape: { active: false },
        playerWorkById: new Map(),
        deathRecovery: { active: false },
        graveLoot: { active: false },
        nearbyLoot: {
            active: false,
            suppressUntil: 0,
            priorityUntil: 0,
            priorityOrigin: null,
            pickupSettle: null
        },
        holdReflexes: false,
        invalidateCompanionAwareness() {},
        shouldYieldNormalAction: () => false
    };
    ctx.doors = new DoorTracker(bot, {
        getOwnerEntity: () => null,
        now: world.now
    });
    world.ctx = ctx;

    const agent = {
        reflexes: {
            isControllingMovement: false,
            wantsCombat: false,
            tick: async () => {}
        }
    };
    world.agent = agent;
    ctx.agent = agent;

    world.start = (interrupts = []) => {
        const manager = new CompanionOrchestrator(ctx, agent, interrupts, 'follow');
        agent.companion = { manager };
        // Owner search is irrelevant here; normal movement is driven explicitly.
        manager.fsmStates.follow.runTick = async () => {};
        world.manager = manager;
        return manager;
    };

    /** Ordinary follow: walk toward a fixed point, tick after tick. */
    world.followToward = (z) => {
        world.manager.fsmStates.follow.runTick = async () => {
            movement.goToward({ x: 0.5, y: 64, z }, 1);
        };
    };

    world.dispose = () => ctx.doors.dispose();
    world.job = () => ctx.doors.passageJob;
    return world;
}

/** Run ticks until `done()` holds, so a test never depends on a tick count. */
async function tickUntil(world, done, limit = 20) {
    for (let i = 0; i < limit; i++) {
        await world.manager.tick();
        world.advance(TICK_MS);
        if (done()) return i + 1;
    }
    assert.fail(`condition not reached after ${limit} ticks`);
}

describe('passage transit', () => {
    it('crosses two gates in order, closing each behind it, never turning back', async () => {
        const world = makePassageWorld({ gates: [GATE_POS, FAR_GATE_POS] });
        const manager = world.start();
        world.followToward(-10);

        const logs = [];
        const originalLog = console.log;
        console.log = (...args) => logs.push(args.join(' '));
        try {
            await tickUntil(world, () => world.ctx.bot.entity.position.z <= -10, 60);

            // Both gates were opened and closed again, and nothing else was.
            assert.deepEqual(world.activations.map((entry) => entry.at), [
                '0,64,0', '0,64,0', '0,64,-6', '0,64,-6'
            ]);
            assert.deepEqual(world.openGates(), []);

            // The first gate is shut before the bot reaches the second one.
            const closedFirst = logs.findIndex((l) => /passage close done at 0,64,0/.test(l));
            const openedSecond = logs.findIndex((l) => /passage open done at 0,64,-6/.test(l));
            assert.ok(closedFirst >= 0 && openedSecond > closedFirst, logs.join('\n'));

            // No step of the walk ever went back the way the bot came.
            const backwards = world.track.filter((z, i) => i > 0 && z > world.track[i - 1]);
            assert.deepEqual(backwards, [], `walked backwards to ${backwards.join(', ')}`);
        } finally {
            console.log = originalLog;
            world.dispose();
        }
    });

    it('takes on every gate of the route, so a stripped door action is never a wall', async () => {
        const world = makePassageWorld({ gates: [GATE_POS, FAR_GATE_POS] });
        world.start();
        world.followToward(-10);

        try {
            await tickUntil(world, () => world.ctx.doors.neededPassages.length === 2);
            assert.deepEqual(world.ctx.doors.neededPassages.sort(), ['0,64,-6', '0,64,0']);
            assert.deepEqual(
                world.route.flatMap((node) => node.toPlace),
                [],
                'the pathfinder opens nothing itself'
            );
        } finally {
            world.dispose();
        }
    });

    it('stops ordinary movement only to activate a passage', async () => {
        const world = makePassageWorld();
        world.start();
        world.followToward(-6);

        try {
            await tickUntil(world, () => world.ctx.bot.entity.position.z <= -6, 30);
            assert.equal(world.activations.length, 2, 'one open and one close');
            // A stop resets the pathfinder, so it happens once per activation
            // and never on a tick that is merely waiting for the server.
            assert.equal(world.stops, world.activations.length);
        } finally {
            world.dispose();
        }
    });

    it('does not fail on a route that died before the job started', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);
        // Hold the gate unconfirmed so the job is still running below.
        world.suspendBlockUpdates = true;

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await tickUntil(world, () => world.activations.length === 1);
            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            // The follow route that ran before the job left this behind. The
            // job never issued a move of its own, so this is not its failure.
            world.movement.status = 'noPath';

            await manager.tick();
            assert.equal(world.ctx.doors.passagePending, true, 'the job survives');
            assert.deepEqual(warnings, []);
            assert.equal(world.activations.length, 1, 'still inside the confirm window');
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });

    it('opens a closed gate, crosses it, and confirms the close before pickup resumes', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            // Pickup walks up to the gate and hands control to passage transit.
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            assert.equal(world.ctx.bot.entity.position.z, APPROACH_Z);
            assert.equal(world.activations.length, 0, 'no door is operated outside the state');
            assert.deepEqual(world.job(), {
                key: '0,64,0',
                intent: 'open',
                reason: 'needed',
                passagePos: GATE_POS,
                facing: 'north'
            });

            // Open, confirm the open state, then hand movement straight back:
            // there is no crossing stage for the state to drive.
            await tickUntil(world, () => world.isOpen(GATE_POS));
            await tickUntil(world, () => manager.getActiveFsmId() !== 'passage_transit');

            // Pickup owns movement again, walks the bot through, and the gate
            // is shut from the far side without pickup ever backtracking.
            await tickUntil(world, () => world.ctx.bot.entity.position.z < 0, 20);
            await tickUntil(
                world,
                () => !world.isOpen(GATE_POS) && world.ctx.doors.passagePending === false,
                20
            );
            assert.equal(world.activations.length, 2);
        } finally {
            world.dispose();
        }
    });

    it('waits at the gate and retries while the open state is delayed', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);
        world.suspendBlockUpdates = true;

        try {
            await tickUntil(world, () => world.activations.length === 1);
            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            assert.equal(world.isOpen(GATE_POS), false);

            // The confirmation window passes without the bot walking away.
            world.advance(1201);
            await tickUntil(world, () => world.activations.length === 2);
            assert.equal(world.ctx.bot.entity.position.z, APPROACH_Z);

            world.suspendBlockUpdates = false;
            world.setOpen(GATE_POS, true);
            await tickUntil(world, () => manager.getActiveFsmId() !== 'passage_transit');
        } finally {
            world.dispose();
        }
    });

    it('suspends for combat and resumes the same job afterwards', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);
        world.suspendBlockUpdates = true;

        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            const job = world.job();

            world.agent.reflexes.wantsCombat = true;
            await tickUntil(world, () => manager.getActiveFsmId() === 'combat');

            // A long fight must not consume the job deadline.
            world.advance(PASSAGE_JOB_TIMEOUT_MS * 3);
            await manager.tick();
            assert.equal(world.ctx.doors.passagePending, true);
            assert.deepEqual(world.job(), job);

            world.agent.reflexes.wantsCombat = false;
            world.suspendBlockUpdates = false;
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            await tickUntil(world, () => world.isOpen(GATE_POS));
        } finally {
            world.dispose();
        }
    });

    it('records a reason and returns control when the deadline expires', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);
        world.suspendBlockUpdates = true;

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            world.advance(PASSAGE_JOB_TIMEOUT_MS + 1);

            await tickUntil(world, () => manager.getActiveFsmId() !== 'passage_transit');
            assert.equal(world.ctx.doors.passagePending, false);
            assert.ok(
                warnings.some((line) => /passage open failed \(timeout\)/.test(line)),
                'expected a recorded failure reason'
            );
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });

    it('comes back to close a gate it opened but never went through', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await tickUntil(world, () => world.isOpen(GATE_POS));
            assert.equal(world.ctx.bot.entity.position.z, APPROACH_Z);

            // Nothing pulls the bot through any more: it turns back and leaves.
            world.followToward(8);
            await tickUntil(world, () => world.ctx.bot.entity.position.z >= 5, 20);

            // The gate is behind the bot on a route that no longer uses it, so
            // the debt comes due and is walked back to.
            await tickUntil(world, () => world.isOpen(GATE_POS) === false, 30);
            assert.deepEqual(warnings, []);
            assert.equal(world.activations.length, 2);
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });

    it('never touches a gate the route does not reach', async () => {
        const world = makePassageWorld();
        world.start();
        world.followToward(8);

        try {
            for (let i = 0; i < 6; i++) {
                await world.manager.tick();
                world.advance(TICK_MS);
                assert.notEqual(world.manager.getActiveFsmId(), 'passage_transit');
            }
            assert.equal(world.activations.length, 0);
            assert.equal(world.isOpen(GATE_POS), false);
        } finally {
            world.dispose();
        }
    });

    it('never touches iron doors or trapdoors on the route', async () => {
        for (const gateName of ['iron_door', 'oak_trapdoor']) {
            const world = makePassageWorld({ gateName });
            world.start();
            world.followToward(-6);

            try {
                for (let i = 0; i < 6; i++) {
                    await world.manager.tick();
                    world.advance(TICK_MS);
                    assert.notEqual(world.manager.getActiveFsmId(), 'passage_transit', gateName);
                }
                assert.equal(world.activations.length, 0, gateName);
            } finally {
                world.dispose();
            }
        }
    });

    it('backs off a failed passage instead of retrying it every tick', async () => {
        const world = makePassageWorld();
        const manager = world.start();
        world.followToward(-6);
        world.suspendBlockUpdates = true;

        const originalWarn = console.warn;
        console.warn = () => {};
        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            world.advance(PASSAGE_JOB_TIMEOUT_MS + 1);
            await tickUntil(world, () => world.ctx.doors.passagePending === false);
            const attempts = world.activations.length;

            await manager.tick();
            assert.equal(world.activations.length, attempts, 'still on cooldown');

            world.advance(PASSAGE_FAIL_COOLDOWN_MS + 1);
            world.suspendBlockUpdates = false;
            await tickUntil(world, () => world.activations.length > attempts);
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });
});
