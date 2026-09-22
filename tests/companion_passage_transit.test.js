/**
 * End-to-end passage transit: a closed gate between the companion and its
 * target must be opened, crossed, and confirmed closed by one FSM state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
    DoorTracker,
    PASSAGE_STAGE,
    PASSAGE_TIMEOUT_MS
} from '../src/companion/movement/DoorTracker.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';

/** Everything happens in a one-block corridor along z, with a gate at z=0. */
const GATE_POS = { x: 0, y: 64, z: 0 };
const GATE_CENTER_Z = GATE_POS.z + 0.5;
/** Route stand point on the approach side, as the analyzer derives it. */
const APPROACH_Z = 1.5;
/** Route stand point past the gate, far enough to close it safely. */
const EXIT_Z = -1.5;

function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Minimal but faithful world: pathfinder-shaped routes, a gate that only lets
 * the bot through while open, and block state that follows activation.
 */
function makePassageWorld(options = {}) {
    const blocks = new Map();
    const activations = [];
    let now = 100_000;

    const world = {
        activations,
        /** Drop block-state updates so an activation stays unconfirmed. */
        suspendBlockUpdates: false,
        activationFailures: 0,
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
    world.gate = () => blocks.get(blockKey(GATE_POS));
    world.isGateOpen = () => world.gate()?._properties?.open === true;
    world.setGateOpen = (open) => {
        const gate = world.gate();
        if (gate) gate._properties.open = open;
    };
    world.setBlock(options.gateName || 'oak_fence_gate', GATE_POS, {
        facing: 'north',
        open: false
    });

    bot.activateBlock = (block) => {
        activations.push({ name: block.name, open: block._properties?.open === true });
        if (world.activationFailures > 0) {
            world.activationFailures -= 1;
            return Promise.reject(new Error('activation failed'));
        }
        if (!world.suspendBlockUpdates) {
            world.setGateOpen(!world.isGateOpen());
        }
        return Promise.resolve();
    };

    /** Pathfinder-shaped corridor route, with the door action a closed gate gets. */
    function buildPath(from, to) {
        const startZ = Math.floor(from.z);
        const endZ = Math.floor(to.z);
        if (startZ === endZ) return [];
        const step = endZ > startZ ? 1 : -1;
        const path = [];
        for (let z = startZ + step; ; z += step) {
            const node = { x: GATE_POS.x, y: GATE_POS.y, z, toPlace: [] };
            if (z === GATE_POS.z && !world.isGateOpen()) {
                node.toPlace.push({ ...GATE_POS, useOne: true });
            }
            path.push(node);
            if (z === endZ) break;
        }
        return path;
    }

    /** A closed gate stops the walk on its near side; an open one lets it pass. */
    function walkTo(target) {
        const from = bot.entity.position;
        const crossesGate = (from.z - GATE_CENTER_Z) * (target.z - GATE_CENTER_Z) < 0;
        if (crossesGate && !world.isGateOpen()) {
            const side = Math.sign(from.z - GATE_CENTER_Z) || 1;
            bot.entity.position = { x: 0.5, y: 64, z: GATE_CENTER_Z + side };
            return;
        }
        bot.entity.position = { x: 0.5, y: 64, z: target.z };
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
            const path = buildPath(bot.entity.position, pos);
            if (path.length > 0) bot.emit('path_update', { status: 'success', path });
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

    world.dispose = () => ctx.doors.dispose();
    world.transaction = () => ctx.doors.passageTransaction;
    return world;
}

/** Run ticks until `done()` holds, so a test never depends on a tick count. */
async function tickUntil(world, done, limit = 12) {
    for (let i = 0; i < limit; i++) {
        await world.manager.tick();
        if (done()) return i + 1;
    }
    assert.fail(`condition not reached after ${limit} ticks`);
}

describe('passage transit', () => {
    it('opens a closed gate, crosses it, and confirms the close before pickup resumes', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            // Pickup walks up to the gate and hands control to passage transit.
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            assert.equal(world.ctx.bot.entity.position.z, APPROACH_Z);
            assert.equal(world.activations.length, 0, 'no door is operated outside the state');
            assert.equal(world.transaction().stage, PASSAGE_STAGE.approach);

            // Open, confirm the open state, then cross to the far stand point.
            await tickUntil(world, () => world.transaction()?.stage === PASSAGE_STAGE.crossing);
            assert.equal(world.isGateOpen(), true);
            assert.equal(world.ctx.bot.entity.position.z, EXIT_Z);

            // Close, then wait for the confirmed closed state before leaving.
            await tickUntil(world, () => world.isGateOpen() === false);
            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            assert.equal(world.activations.length, 2);

            await tickUntil(world, () => manager.getActiveFsmId() === 'duty');
            assert.equal(world.ctx.doors.passagePending, false);

            // Normal pickup owns movement again and reaches the drop.
            await tickUntil(world, () => world.ctx.bot.entity.position.z === -3);
        } finally {
            world.dispose();
        }
    });

    it('keeps the transaction when stopping normal work resets the route', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            const acquired = world.transaction();
            assert.equal(acquired.claimed, true);

            // Exactly the events a stop produces, before and after the transition.
            world.bot.emit('path_reset', 'goal_updated');
            world.bot.emit('goal_updated', null);
            world.ctx.movement.stop();

            assert.equal(world.ctx.doors.passagePending, true);
            assert.equal(world.transaction().key, acquired.key);

            await tickUntil(world, () => world.isGateOpen());
        } finally {
            world.dispose();
        }
    });

    it('waits at the gate and retries while the open state is delayed', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);
        world.suspendBlockUpdates = true;

        try {
            await tickUntil(world, () => world.activations.length === 1);
            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            assert.equal(world.isGateOpen(), false);

            // Confirmation window plus retry backoff, without walking away.
            world.advance(2501);
            await manager.tick();
            world.advance(600);
            await tickUntil(world, () => world.activations.length === 2);
            assert.equal(world.ctx.bot.entity.position.z, APPROACH_Z);

            world.suspendBlockUpdates = false;
            world.setGateOpen(true);
            await tickUntil(world, () => world.transaction()?.stage === PASSAGE_STAGE.crossing);
        } finally {
            world.dispose();
        }
    });

    it('suspends for combat and resumes at the same stage afterwards', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            await tickUntil(world, () => world.transaction()?.stage === PASSAGE_STAGE.crossing);

            world.agent.reflexes.wantsCombat = true;
            await tickUntil(world, () => manager.getActiveFsmId() === 'combat');
            const stage = world.transaction().stage;

            // A long fight must not consume the transaction deadline.
            world.advance(PASSAGE_TIMEOUT_MS * 3);
            await manager.tick();
            assert.equal(world.ctx.doors.passagePending, true);
            assert.equal(world.transaction().stage, stage);

            world.agent.reflexes.wantsCombat = false;
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            await tickUntil(world, () => world.isGateOpen() === false);
            assert.equal(world.ctx.bot.entity.position.z, EXIT_Z);
        } finally {
            world.dispose();
        }
    });

    it('records a reason and returns control when the deadline expires', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);
        world.suspendBlockUpdates = true;

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            world.advance(PASSAGE_TIMEOUT_MS + 1);

            await tickUntil(world, () => manager.getActiveFsmId() !== 'passage_transit');
            assert.equal(world.ctx.doors.passagePending, false);
            assert.ok(
                warnings.some((line) => /passage transit failed \(timeout\)/.test(line)),
                'expected a recorded failure reason'
            );
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });

    it('returns control when the passage cannot be reached', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        const warnings = [];
        const originalWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            world.movement.status = 'noPath';

            await tickUntil(world, () => manager.getActiveFsmId() !== 'passage_transit');
            assert.equal(world.ctx.doors.passagePending, false);
            assert.ok(warnings.some((line) => /passage transit failed \(unreachable\)/.test(line)));
        } finally {
            console.warn = originalWarn;
            world.dispose();
        }
    });

    it('enters the same state for normal movement that is not item pickup', async () => {
        const world = makePassageWorld();
        const manager = world.start([]);
        let walks = 0;
        manager.fsmStates.follow.runTick = async () => {
            walks += 1;
            if (walks === 1) world.ctx.movement.goToward({ x: 0.5, y: 64, z: -3 }, 1);
        };

        try {
            await tickUntil(world, () => manager.getActiveFsmId() === 'passage_transit');
            await tickUntil(world, () => world.isGateOpen() === false && world.activations.length === 2);
            assert.equal(world.ctx.bot.entity.position.z, EXIT_Z);

            await tickUntil(world, () => manager.getActiveFsmId() === 'follow');
        } finally {
            world.dispose();
        }
    });

    it('completes the acquired transaction even if the drop disappears', async () => {
        const world = makePassageWorld();
        world.addDrop(1, -3);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            await tickUntil(world, () => world.transaction()?.stage === PASSAGE_STAGE.crossing);
            world.removeDrop(1);

            await tickUntil(world, () => world.isGateOpen() === false);
            assert.equal(world.ctx.doors.passagePending, true, 'close is confirmed by the state');

            await tickUntil(world, () => manager.getActiveFsmId() === 'follow');
            assert.equal(world.ctx.doors.passagePending, false);
        } finally {
            world.dispose();
        }
    });

    it('never touches a gate the route does not cross', async () => {
        const world = makePassageWorld();
        world.addDrop(1, 6);
        const manager = world.start([new NearbyLootInterrupt()]);

        try {
            for (let i = 0; i < 4; i++) {
                await manager.tick();
                assert.notEqual(manager.getActiveFsmId(), 'passage_transit');
            }
            assert.equal(world.activations.length, 0);
            assert.equal(world.isGateOpen(), false);
        } finally {
            world.dispose();
        }
    });

    it('never touches iron doors or trapdoors on the route', async () => {
        for (const gateName of ['iron_door', 'oak_trapdoor']) {
            const world = makePassageWorld({ gateName });
            world.addDrop(1, -3);
            const manager = world.start([new NearbyLootInterrupt()]);

            try {
                for (let i = 0; i < 4; i++) {
                    await manager.tick();
                    assert.notEqual(manager.getActiveFsmId(), 'passage_transit', gateName);
                }
                assert.equal(world.activations.length, 0, gateName);
            } finally {
                world.dispose();
            }
        }
    });
});
