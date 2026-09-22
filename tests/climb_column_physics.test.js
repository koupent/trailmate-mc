import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';
import physicsLoader from 'prismarine-physics';
import { ColumnClimber } from '../src/companion/movement/climbColumn.js';
import { FollowMode } from '../src/companion/modes/FollowMode.js';

/**
 * The unit tests above assert what the state machine decides. This file runs
 * the real prismarine-physics engine over a hand-built voxel world instead, so
 * the premise the whole fix rests on is checked end to end: stand in the
 * column, face the wall, hold forward, and the bot actually goes up.
 *
 * prismarine-registry / -block / -physics arrive with mineflayer rather than as
 * direct dependencies, which is why they appear only here.
 */
const VERSION = '1.21.6';
const registry = registryLoader(VERSION);
const Block = blockLoader(registry);
const { Physics, PlayerState } = physicsLoader;

const PHYSICS_TICK_MS = 50;
/** config.tick_ms — the companion decides four times per second. */
const COMPANION_TICK_MS = 250;

function stateIdOf(name, properties) {
    const data = registry.blocksByName[name];
    if (!properties) return data.defaultState;
    for (let id = data.minStateId; id <= data.maxStateId; id += 1) {
        const block = Block.fromStateId(id, 0);
        const matches = Object.entries(properties)
            .every(([key, value]) => block._properties?.[key] === value);
        if (matches) return id;
    }
    throw new Error(`no state of ${name} matches ${JSON.stringify(properties)}`);
}

/** Minimal `world` shape: prismarine-physics only ever calls getBlock. */
class VoxelWorld {
    constructor() {
        this.cells = new Map();
        this.cache = new Map();
        this.airState = registry.blocksByName.air.defaultState;
    }

    fill(name, { x, y, z }, properties) {
        const state = stateIdOf(name, properties);
        for (let bx = x[0]; bx <= x[1]; bx += 1) {
            for (let by = y[0]; by <= y[1]; by += 1) {
                for (let bz = z[0]; bz <= z[1]; bz += 1) {
                    this.cells.set(`${bx},${by},${bz}`, state);
                }
            }
        }
        return this;
    }

    getBlock(pos) {
        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        const key = `${x},${y},${z}`;
        const cached = this.cache.get(key);
        if (cached) return cached;
        const block = Block.fromStateId(this.cells.get(key) ?? this.airState, 0);
        block.position = new Vec3(x, y, z);
        this.cache.set(key, block);
        return block;
    }
}

function makeBot(world, position) {
    const controlState = {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false
    };
    const bot = {
        version: VERSION,
        jumpTicks: 0,
        jumpQueued: false,
        fireworkRocketDuration: 0,
        controlState,
        inventory: { slots: [] },
        entity: {
            id: 1,
            position: position.clone(),
            velocity: new Vec3(0, 0, 0),
            onGround: true,
            isInWater: false,
            isInLava: false,
            isInWeb: false,
            isCollidedHorizontally: false,
            isCollidedVertically: false,
            elytraFlying: false,
            yaw: 0,
            pitch: 0,
            height: 1.8,
            width: 0.6,
            eyeHeight: 1.62,
            effects: {},
            attributes: {}
        },
        setControlState(name, state) {
            controlState[name] = state;
        },
        getControlState(name) {
            return controlState[name];
        },
        async look(yaw, pitch) {
            bot.entity.yaw = yaw;
            bot.entity.pitch = pitch;
        },
        blockAt(pos) {
            return world.getBlock(pos);
        }
    };
    return bot;
}

/**
 * Step physics at 20 tps and let `decide` run on the companion tick boundary.
 * @returns {{ bot: object, simTime: number }}
 */
async function simulate(world, bot, seconds, decide) {
    const physics = Physics(registry, world);
    let simTime = 0;
    const totalTicks = Math.round((seconds * 1000) / PHYSICS_TICK_MS);
    for (let tick = 0; tick < totalTicks; tick += 1) {
        if (simTime % COMPANION_TICK_MS === 0) await decide(simTime);
        const state = new PlayerState(bot, bot.controlState);
        physics.simulatePlayer(state, world).apply(bot);
        simTime += PHYSICS_TICK_MS;
    }
    return { bot, simTime };
}

/** Vines on the west face (x=0) of a stone wall whose top is walkable at y=70. */
function vineWall({ vineTop = 69, wallTop = 69, plateauZ = 3 } = {}) {
    return new VoxelWorld()
        .fill('stone', { x: [-4, 12], y: [63, 63], z: [-4, 12] })
        .fill('stone', { x: [1, 3], y: [64, wallTop], z: [-3, plateauZ] })
        .fill('vine', { x: [0, 0], y: [64, vineTop], z: [0, 0] });
}

/** North-facing ladder at z=0, held by the stone at z=1. */
function ladderWall() {
    return new VoxelWorld()
        .fill('stone', { x: [-4, 4], y: [63, 63], z: [-4, 4] })
        .fill('stone', { x: [-3, 3], y: [64, 69], z: [1, 3] })
        .fill('ladder', { x: [0, 0], y: [64, 69], z: [0, 0] }, { facing: 'north', waterlogged: false });
}

function makeClimbCtx(bot, ownerPosition) {
    const movement = { stops: 0, stop() { this.stops += 1; } };
    return {
        bot,
        movement,
        ownerEntity: { id: 7, position: ownerPosition },
        deathRecovery: { active: false },
        agent: { reflexes: null }
    };
}

/**
 * Drive one climb with a simulated clock, and report whether the climber ever
 * claimed a tick.
 */
async function runClimb(world, start, owner, seconds = 12) {
    const bot = makeBot(world, start);
    const ctx = makeClimbCtx(bot, owner);
    let simTime = 0;
    let engaged = false;
    const climber = new ColumnClimber({ now: () => simTime });

    await simulate(world, bot, seconds, (now) => {
        simTime = now;
        if (climber.tick(ctx)) engaged = true;
    });

    return { bot, ctx, climber, engaged };
}

describe('column climb against real physics', () => {
    it('carries the companion up a vine wall and onto the top', async () => {
        const { bot, ctx, climber } = await runClimb(
            vineWall(),
            new Vec3(0.5, 64, 0.5),
            new Vec3(2.5, 70, 0.5)
        );

        assert.ok(
            bot.entity.position.y >= 70,
            `expected the wall top at y=70, ended at y=${bot.entity.position.y}`
        );
        assert.equal(bot.entity.onGround, true, 'must end standing, not hanging');
        assert.equal(bot.getControlState('forward'), false);
        assert.equal(climber.phase, 'idle');
        assert.equal(ctx.movement.stops, 1, 'the follow goal is dropped exactly once');
    });

    it('carries the companion up a ladder the same way', async () => {
        const { bot } = await runClimb(
            ladderWall(),
            new Vec3(0.5, 64, 0.5),
            new Vec3(0.5, 70, 2.5)
        );

        assert.ok(
            bot.entity.position.y >= 70,
            `expected the wall top at y=70, ended at y=${bot.entity.position.y}`
        );
        assert.equal(bot.entity.onGround, true);
        assert.equal(bot.getControlState('forward'), false);
    });

    it('never moves while the owner stands on the same level', async () => {
        const { bot, ctx, engaged } = await runClimb(
            vineWall(),
            new Vec3(0.5, 64, 0.5),
            new Vec3(-2.5, 64, 0.5),
            3
        );

        assert.equal(engaged, false);
        assert.equal(ctx.movement.stops, 0);
        assert.equal(bot.getControlState('forward'), false);
        assert.equal(bot.entity.position.y, 64);
    });

    it('never engages on a vine with no wall behind it', async () => {
        const hanging = new VoxelWorld()
            .fill('stone', { x: [-4, 4], y: [63, 63], z: [-4, 4] })
            .fill('vine', { x: [0, 0], y: [64, 69], z: [0, 0] });
        const { ctx, engaged } = await runClimb(
            hanging,
            new Vec3(0.5, 64, 0.5),
            new Vec3(0.5, 70, 0.5),
            3
        );

        assert.equal(engaged, false);
        assert.equal(ctx.movement.stops, 0);
    });

    it('gives up on a vine that breaks halfway instead of hanging on the wall', async () => {
        // Vines stop at y=66 while the wall carries on to y=69, so the push pins
        // the bot above the last vine without ever landing anywhere.
        const { bot, ctx, climber } = await runClimb(
            vineWall({ vineTop: 66 }),
            new Vec3(0.5, 64, 0.5),
            new Vec3(2.5, 70, 0.5),
            10
        );

        assert.equal(climber.phase, 'idle', 'the attempt must end');
        assert.equal(bot.getControlState('forward'), false);
        assert.equal(bot.entity.onGround, true, 'must fall back down, not stay pinned');
        assert.ok(bot.entity.position.y < 70, 'the wall was never cleared');
        assert.ok(
            ctx.movement.stops <= 4,
            `retries must stay bounded, got ${ctx.movement.stops} attempts in 10s`
        );
    });
});

function makeFollowCtx(bot, ownerPosition) {
    const calls = [];
    const ownerEntity = { id: 7, position: ownerPosition, yaw: 0, height: 1.8 };
    bot.players = { Steve: { entity: ownerEntity } };
    bot.world = { raycast: () => null };
    return {
        calls,
        ctx: {
            bot,
            ownerName: 'Steve',
            ownerEntity,
            movement: {
                isHeld: false,
                hasGoal: false,
                isMoving: false,
                isBlocked: false,
                status: 'idle',
                tickHoldWatchdog() {},
                stop() {
                    calls.push('stop');
                    this.hasGoal = false;
                },
                followEntity() {
                    calls.push('followEntity');
                    this.hasGoal = true;
                    return true;
                },
                goToward() {
                    calls.push('goToward');
                    this.hasGoal = true;
                    return true;
                }
            },
            config: {
                follow_distance: 3,
                follow_min_distance: 2,
                owner_work: { enabled: false, all_players: true, fov_degrees: 100 },
                nearby_loot: { collector_enabled: false }
            },
            playerWorkById: new Map(),
            deathRecovery: { active: false },
            nearbyLoot: { active: false, suppressUntil: 0 },
            doors: { findSeparatingPassage: () => false, tick: async () => {} },
            agent: { reflexes: null }
        }
    };
}

describe('FollowMode column climb against real physics', () => {
    it('climbs the wall, then hands the tick back to ordinary follow', async () => {
        const world = vineWall({ plateauZ: 10 });
        const bot = makeBot(world, new Vec3(0.5, 64, 0.5));
        const { ctx, calls } = makeFollowCtx(bot, new Vec3(2.5, 70, 9.5));
        const mode = new FollowMode();

        await simulate(world, bot, 5, () => mode.tick(ctx));

        assert.ok(bot.entity.position.y >= 70, 'expected to reach the wall top');
        assert.equal(bot.entity.onGround, true);
        assert.equal(bot.getControlState('forward'), false);

        const firstFollow = calls.indexOf('followEntity');
        assert.notEqual(firstFollow, -1, 'ordinary follow must resume once on top');
        assert.deepEqual(
            [...new Set(calls.slice(0, firstFollow))],
            ['stop'],
            'pathfinder must not be asked for a route mid-climb'
        );
    });

    it('lets go of forward the moment combat takes the tick over', async () => {
        const world = vineWall();
        const bot = makeBot(world, new Vec3(0.5, 64, 0.5));
        const { ctx } = makeFollowCtx(bot, new Vec3(2.5, 70, 0.5));
        const mode = new FollowMode();
        let heldForwardAfterCombat = false;
        let climbedBeforeCombat = 64;

        await simulate(world, bot, 4, async (now) => {
            if (now === 1000) climbedBeforeCombat = bot.entity.position.y;
            if (now >= 1000) ctx.agent.reflexes = { wantsCombat: true };
            await mode.tick(ctx);
            if (now >= 1000 && bot.getControlState('forward')) heldForwardAfterCombat = true;
        });

        assert.ok(climbedBeforeCombat > 64, 'the climb must have been under way');
        assert.equal(heldForwardAfterCombat, false, 'forward must never stay pressed');
        assert.equal(bot.getControlState('forward'), false);
    });
});
