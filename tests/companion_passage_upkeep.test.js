import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startPassageUpkeep } from '../src/companion/stateMachine/passageUpkeep.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';
import { DoorTracker } from '../src/companion/movement/DoorTracker.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startPassageUpkeep', () => {
    it('ticks doors periodically until stopped', async () => {
        let ticks = 0;
        const ctx = { doors: { tick: async () => { ticks += 1; } } };

        const upkeep = startPassageUpkeep(ctx, { paused: false }, 5);
        await sleep(60);
        upkeep.stop();
        const atStop = ticks;
        assert.ok(atStop >= 3, `expected periodic ticks, got ${atStop}`);

        await sleep(30);
        assert.equal(ticks, atStop);
    });

    it('does not tick while the FSM is paused', async () => {
        let ticks = 0;
        const ctx = { doors: { tick: async () => { ticks += 1; } } };
        const targets = { paused: true };

        const upkeep = startPassageUpkeep(ctx, targets, 5);
        await sleep(40);
        assert.equal(ticks, 0);

        targets.paused = false;
        await sleep(40);
        upkeep.stop();
        assert.ok(ticks >= 1);
    });

    it('never overlaps a tick that is still in flight', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const ctx = {
            doors: {
                tick: async () => {
                    inFlight += 1;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await sleep(20);
                    inFlight -= 1;
                }
            }
        };

        const upkeep = startPassageUpkeep(ctx, { paused: false }, 2);
        await sleep(70);
        upkeep.stop();
        assert.equal(maxInFlight, 1);
    });

    it('is a no-op without a door tracker', () => {
        const upkeep = startPassageUpkeep({}, { paused: false }, 5);
        assert.doesNotThrow(() => upkeep.stop());
    });
});

describe('CompanionOrchestrator passage upkeep', () => {
    function makeBlock(name, pos, props) {
        return {
            name,
            position: { x: pos.x, y: pos.y, z: pos.z },
            _properties: { ...props }
        };
    }

    function makeWorld() {
        const blocks = new Map();
        const activations = [];
        let now = 0;
        const owner = {
            id: 42,
            position: { x: 0.5, y: 64, z: 0.8, offset() { return this; } },
            height: 1.62,
            pitch: 0,
            yaw: 0
        };
        const bot = new EventEmitter();
        bot.entity = { position: { x: 0.5, y: 64, z: 3 } };
        bot.entities = {};
        bot.blockAtEntityCursor = () => null;
        bot.blockAt = (pos) => blocks.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || null;
        bot.activateBlock = (block) => {
            activations.push(block);
            return Promise.resolve();
        };
        const setBlock = (name, pos, props) => {
            const block = makeBlock(name, pos, props);
            blocks.set(`${pos.x},${pos.y},${pos.z}`, block);
            return block;
        };
        return {
            bot,
            owner,
            activations,
            setBlock,
            now: () => now,
            advance: (ms) => { now += ms; }
        };
    }

    /** Minimal ctx accepted by prepareCompanionWorldTick. */
    function makeCtx(world) {
        const ctx = {
            bot: world.bot,
            config: { tick_ms: 5, owner_work: { enabled: false } },
            ownerEntity: world.owner,
            playerWorkById: new Map(),
            worldState: { update() {} },
            stuck: { update() {}, seconds: 0 },
            movement: {
                isTryingToMove: false,
                hasGoal: false,
                isBlocked: false,
                isUnreachable: false,
                stop() {},
                goToward() {}
            },
            deathRecovery: { active: false }
        };
        ctx.doors = new DoorTracker(world.bot, {
            getOwnerEntity: () => world.owner,
            now: world.now
        });
        return ctx;
    }

    it('yields normal work and waits for confirmed closing before resuming', async () => {
        const world = makeWorld();
        const ctx = makeCtx(world);
        const manager = new CompanionOrchestrator(ctx, {}, [], 'follow');
        ctx.agent = { companion: { manager } };

        // Owner opens the gate while standing at it; the bot approaches from +z.
        const gatePos = { x: 0, y: 64, z: 0 };
        const closed = world.setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });
        world.bot.emit('blockUpdate', closed, makeBlock('oak_fence_gate', gatePos, { facing: 'north', open: true }));
        world.setBlock('oak_fence_gate', gatePos, { facing: 'north', open: true });
        assert.equal(ctx.doors.trackedCount, 1);

        let normalRuns = 0;
        let resumed = false;
        manager.root.activeState.runTick = async () => {
            normalRuns += 1;
            if (normalRuns > 1) {
                resumed = true;
                return;
            }

            // A loot-equivalent long action crosses the gate, then cooperates
            // with the common FSM yield signal instead of walking farther away.
            world.bot.entity.position = { x: 0.5, y: 64, z: -2 };
            while (!ctx.shouldYieldNormalAction()) await sleep(5);
        };

        try {
            await manager.tick();

            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            assert.equal(world.activations.length, 0, 'detection must not close outside the FSM state');
            assert.equal(world.bot.entity.position.z, -2, 'normal movement must yield within reach');

            await manager.tick();
            assert.equal(world.activations.length, 1);
            assert.equal(manager.getActiveFsmId(), 'passage_transit');
            assert.equal(resumed, false);

            // The first close request is not reflected by the server.
            world.advance(1201);
            await manager.tick();
            assert.equal(world.activations.length, 1);
            assert.equal(resumed, false);

            // Retry succeeds, but normal work still waits for world-state confirmation.
            world.advance(600);
            await manager.tick();
            assert.equal(world.activations.length, 2);
            assert.equal(resumed, false);
            world.setBlock('oak_fence_gate', gatePos, { facing: 'north', open: false });

            await manager.tick();
            assert.equal(manager.getActiveFsmId(), 'follow');

            await manager.tick();
            assert.equal(resumed, true);
        } finally {
            ctx.doors.dispose();
        }
    });

    it('stops upkeep once the behavior tick returns', async () => {
        const world = makeWorld();
        const ctx = makeCtx(world);
        let ticks = 0;
        ctx.doors.dispose();
        ctx.doors = { tick: async () => { ticks += 1; } };
        const manager = new CompanionOrchestrator(ctx, {}, [], 'follow');
        manager.root.activeState.runTick = async () => { await sleep(30); };

        await manager.tick();
        const afterTick = ticks;
        await sleep(40);

        assert.ok(afterTick >= 2, `expected upkeep ticks during the run, got ${afterTick}`);
        assert.equal(ticks, afterTick);
    });
});
