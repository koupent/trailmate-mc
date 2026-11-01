/**
 * Drops one or two blocks below the bot used to freeze it on the adjacent
 * block. The approach goal measured horizontal closeness only, so GoalNear's
 * radius swallowed the step and the path ended where the bot was already
 * standing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import AStar from 'mineflayer-pathfinder/lib/astar.js';
import Move from 'mineflayer-pathfinder/lib/move.js';
import pf from 'mineflayer-pathfinder';
import { createSafeMovements } from '../src/companion/blockProtection.js';
import { pickupNearbyItems } from '../src/companion/utils/pickupItems.js';

const VERSION = '1.21.4';
const registry = minecraftData(VERSION);
const Block = prismarineBlock(registry);
const AIR = registry.blocksByName.air.minStateId;
const STONE = registry.blocksByName.stone.minStateId;

function makeWorld(cells) {
    const states = new Map(cells);
    return {
        blockAt(pos) {
            const x = Math.floor(pos.x);
            const y = Math.floor(pos.y);
            const z = Math.floor(pos.z);
            const block = Block.fromStateId(states.get(`${x},${y},${z}`) ?? AIR, 0);
            block.position = new Vec3(x, y, z);
            return block;
        }
    };
}

/** Solid floor at `floorY`, plus any extra solid cells. */
function floorWorld(floorY, extra = []) {
    const cells = [];
    for (let x = -4; x <= 6; x++) {
        for (let z = -4; z <= 4; z++) {
            cells.push([`${x},${floorY},${z}`, STONE]);
        }
    }
    for (const [x, y, z] of extra) cells.push([`${x},${y},${z}`, STONE]);
    return makeWorld(cells);
}

function makeBot(world, position) {
    const bot = new EventEmitter();
    bot.registry = registry;
    bot.version = VERSION;
    bot.entity = {
        position: position.clone(),
        height: 1.8,
        width: 0.6,
        onGround: true,
        name: 'player'
    };
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null, getBlock: (pos) => world.blockAt(pos) };
    bot.blockAt = (pos) => world.blockAt(pos);
    bot.entities = {};
    bot.inventory = { items: () => [], slots: [], emptySlotCount: () => 8 };
    bot.canDigBlock = () => false;
    bot.players = {};
    bot.interrupt_code = false;
    bot.controlState = {};
    bot.setControlState = (name, value) => {
        bot.controlState[name] = value;
    };
    return bot;
}

function planRoute(bot, goal) {
    const movements = createSafeMovements(bot, { allowSprinting: false });
    const from = bot.entity.position.floored();
    const start = new Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
    const context = new AStar(start, movements, goal, 10_000, 40, -1);
    let result = context.compute();
    for (let resumes = 0; result.status === 'partial' && resumes < 40; resumes++) {
        result = context.compute();
    }
    const node = result.path?.at(-1);
    return {
        status: result.status,
        end: node ? { x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) } : null,
        pathLen: result.path?.length ?? 0
    };
}

function standingNode(position) {
    return {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} itemPos
 */
function makeCtx(bot, itemPos) {
    const item = { id: 1, name: 'item', position: itemPos, width: 0.25, height: 0.25 };
    bot.entities[1] = item;
    /** @type {Array<{ x: number, y: number, z: number, range: number, already: boolean }>} */
    const goals = [];
    const movement = {
        goals,
        jumps: 0,
        stop() {},
        goToward(pos, range) {
            const goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, range);
            goals.push({
                x: pos.x,
                y: pos.y,
                z: pos.z,
                range,
                already: goal.isEnd(standingNode(bot.entity.position))
            });
            return true;
        }
    };
    bot.setControlState = (name, value) => {
        bot.controlState[name] = value;
        if (name === 'jump' && value) movement.jumps += 1;
    };
    const ctx = {
        bot,
        movement,
        ownerName: null,
        ownerEntity: null,
        config: {
            awareness_radius: 10,
            nearby_loot: { enabled: true, radius: 8 },
            owner_work: { enabled: true }
        },
        playerWorkById: new Map(),
        deathRecovery: { active: false },
        graveLoot: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        holdReflexes: false,
        invalidateCompanionAwareness() {},
        getCompanionAwareness() {
            return {
                dropItems: [item],
                displayEntities: [],
                blocks: [],
                entities: [item],
                origin: bot.entity.position,
                radius: 10
            };
        }
    };
    return { ctx, goals, movement };
}

function itemGoals(goals, itemPos) {
    return goals.filter((goal) => (
        Math.abs(goal.x - itemPos.x) < 0.001
        && Math.abs(goal.y - itemPos.y) < 0.001
        && Math.abs(goal.z - itemPos.z) < 0.001
    ));
}

describe('pickup across a step', () => {
    it('1段下の隣接ブロックを到着扱いにして棒立ちしない', async () => {
        const world = floorWorld(63, [[0, 64, 0]]);
        const bot = makeBot(world, new Vec3(0.5, 65, 0.5));
        const itemPos = new Vec3(1.5, 64.05, 0.5);
        const { ctx, goals } = makeCtx(bot, itemPos);

        await pickupNearbyItems(ctx, {
            durationMs: 2400,
            pollMs: 100,
            settleMs: 10,
            untilClear: false
        });

        const aimed = itemGoals(goals, itemPos);
        assert.ok(aimed.length >= 1, 'ドロップそのものへ詰めるゴールが無い');
        assert.equal(
            aimed.some((goal) => goal.already),
            false,
            '隣接ブロックの上がゴール到達扱いで、降りずに棒立ちする'
        );

        const route = planRoute(
            bot,
            new pf.goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, aimed[0].range)
        );
        assert.equal(route.status, 'success');
        assert.deepEqual(
            route.end,
            { x: 1, y: 64, z: 0 },
            '回収経路は一段下のドロップの足場で終わる'
        );
    });

    it('2段下でも途中の段を到着にして棒立ちしない', async () => {
        const world = floorWorld(62, [
            [0, 63, 0],
            [0, 64, 0],
            [1, 63, 0]
        ]);
        const bot = makeBot(world, new Vec3(0.5, 65, 0.5));
        const itemPos = new Vec3(2.5, 63.05, 0.5);
        const { ctx, goals } = makeCtx(bot, itemPos);

        await pickupNearbyItems(ctx, {
            durationMs: 2400,
            pollMs: 100,
            settleMs: 10,
            untilClear: false
        });

        const aimed = itemGoals(goals, itemPos);
        assert.ok(aimed.length >= 1, 'ドロップそのものへ詰めるゴールが無い');
        const route = planRoute(
            bot,
            new pf.goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, aimed[0].range)
        );
        assert.equal(route.status, 'success');
        assert.deepEqual(
            route.end,
            { x: 2, y: 63, z: 0 },
            `途中の段 y=${route.end?.y} で止まり、2段下のドロップまで降りない`
        );
    });

    it('同じ距離なら1段上のドロップも足場まで詰める', async () => {
        const world = floorWorld(63, [[1, 64, 0]]);
        const bot = makeBot(world, new Vec3(0.9, 64, 0.5));
        const itemPos = new Vec3(1.2, 65.15, 0.5);
        const { ctx, goals } = makeCtx(bot, itemPos);

        await pickupNearbyItems(ctx, {
            durationMs: 400,
            pollMs: 50,
            settleMs: 10,
            untilClear: false
        });

        const aimed = itemGoals(goals, itemPos);
        assert.ok(aimed.length >= 1, '上のドロップを水平距離だけで磁石扱いして棒立ちする');
        assert.equal(aimed[0].already, false);
        const route = planRoute(
            bot,
            new pf.goals.GoalNear(itemPos.x, itemPos.y, itemPos.z, aimed[0].range)
        );
        assert.equal(route.status, 'success');
        assert.deepEqual(route.end, { x: 1, y: 65, z: 0 });
    });

    it('届かない深穴は既存の降下限界のまま飛び降りない', async () => {
        const cells = [];
        for (let x = -2; x <= 2; x++) {
            for (let z = -2; z <= 2; z++) {
                cells.push([`${x},55,${z}`, STONE]);
            }
        }
        // Pillar under the bot only. The column beside it drops 9 blocks.
        for (let y = 56; y <= 64; y++) cells.push([`0,${y},0`, STONE]);
        const world = makeWorld(cells);
        const bot = makeBot(world, new Vec3(0.5, 65, 0.5));
        const itemPos = new Vec3(1.5, 56.05, 0.5);
        const { ctx, goals, movement } = makeCtx(bot, itemPos);

        await pickupNearbyItems(ctx, {
            durationMs: 700,
            pollMs: 50,
            settleMs: 10,
            untilClear: false
        });

        assert.equal(movement.jumps, 0);
        assert.equal(bot.controlState.jump, undefined);
        assert.equal(
            itemGoals(goals, itemPos).length,
            0,
            '垂直スキャンを超える穴へは近づかず、飛び降りもしない'
        );
    });
});
