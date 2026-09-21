import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import {
    canPlaceUnderProtection,
    disableCompanionBlockProtection,
    enableCompanionBlockProtection
} from '../src/companion/blockProtection.js';

const CROP_BY_ITEM = new Map([
    ['wheat_seeds', 'wheat'],
    ['beetroot_seeds', 'beetroots'],
    ['pumpkin_seeds', 'pumpkin_stem'],
    ['melon_seeds', 'melon_stem'],
    ['torchflower_seeds', 'torchflower_crop'],
    ['pitcher_pod', 'pitcher_crop'],
    ['carrot', 'carrots'],
    ['potato', 'potatoes']
]);

function positionKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function makeCtx(options = {}) {
    const botPos = options.botPos || new Vec3(0, 64, 0);
    const ownerPos = options.ownerPos || new Vec3(2, 64, 0);
    const owner = { id: 7, position: ownerPos, height: 1.8, yaw: 0 };
    const farmlandPositions = (options.farmland || [new Vec3(1, 63, 0)]).map((pos) => pos.clone());
    const occupied = new Set(options.occupied || []);
    const planted = [];
    const equipped = [];
    let findCalls = 0;

    const blockAt = (pos) => {
        const floored = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
        if (farmlandPositions.some((farm) => farm.equals(floored))) {
            return { name: 'farmland', position: floored };
        }
        const farmBelow = farmlandPositions.find((farm) => farm.offset(0, 1, 0).equals(floored));
        if (farmBelow) {
            return {
                name: occupied.has(positionKey(floored)) ? 'wheat' : 'air',
                position: floored,
                boundingBox: occupied.has(positionKey(floored)) ? 'empty' : 'empty'
            };
        }
        return { name: 'air', position: floored, boundingBox: 'empty' };
    };

    const item = options.itemName === null
        ? null
        : { name: options.itemName || 'wheat_seeds', type: 1, count: 4 };
    const bot = {
        entity: { id: 1, position: botPos, height: 1.8 },
        players: { Steve: { entity: owner } },
        inventory: {
            items: () => item ? [item] : [],
            emptySlotCount: () => 1
        },
        blockAt,
        findBlock(query) {
            findCalls++;
            assert.equal(query.maxDistance, 16);
            assert.equal(query.matching({ name: 'farmland' }), true);
            assert.equal(query.matching({ name: 'dirt' }), false);
            return farmlandPositions
                .map((position) => blockAt(position))
                .filter((block) => query.useExtraInfo(block))
                .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0] || null;
        },
        async equip(selected, destination) {
            equipped.push({ selected, destination });
        },
        async placeBlock(reference, face) {
            if (options.placeError) throw new Error('placement rejected');
            planted.push({ reference, face, itemName: item?.name });
            item.count--;
            occupied.add(positionKey(reference.position.offset(0, 1, 0)));
        },
        world: { raycast: () => null }
    };

    const calls = [];
    const movement = {
        isHeld: false,
        isBlocked: false,
        isUnreachable: false,
        status: 'idle',
        tickHoldWatchdog() {},
        stop() { calls.push({ type: 'stop' }); },
        goToward(pos, range) { calls.push({ type: 'goToward', pos, range }); return true; },
        followEntity(entity, range) { calls.push({ type: 'followEntity', entity, range }); return true; }
    };

    const agent = { reflexes: options.reflexes || null };
    if (options.fsmId || options.dutyPending) {
        agent.companion = {
            manager: {
                getActiveFsmId: () => options.fsmId || 'follow',
                targets: { _dutyPending: Boolean(options.dutyPending) }
            }
        };
    }

    const ctx = {
        bot,
        ownerName: 'Steve',
        ownerEntity: owner,
        movement,
        config: {
            follow_distance: 3,
            follow_min_distance: 2,
            owner_near_radius: 12,
            owner_work: { enabled: false },
            nearby_loot: { collector_enabled: false }
        },
        playerWorkById: new Map(),
        deathRecovery: { active: Boolean(options.recoveryActive) },
        nearbyLoot: { active: false, suppressUntil: 0 },
        doors: { findSeparatingPassage: () => false },
        agent
    };

    return {
        ctx,
        calls,
        planted,
        equipped,
        item,
        get findCalls() { return findCalls; }
    };
}

describe('follow crop planting', () => {
    it('plants each supported inventory item under block protection', async () => {
        enableCompanionBlockProtection();
        try {
            for (const [itemName, cropName] of CROP_BY_ITEM) {
                const world = makeCtx({ itemName });
                await new FollowMode().tick(world.ctx);
                assert.equal(world.planted.length, 1, itemName);
                assert.equal(world.equipped[0].selected.name, itemName);
                assert.equal(world.equipped[0].destination, 'hand');
                assert.equal(canPlaceUnderProtection(cropName), true, cropName);
            }
            assert.equal(canPlaceUnderProtection('dirt'), false);
            assert.equal(canPlaceUnderProtection('oak_sapling'), false);
        } finally {
            disableCompanionBlockProtection();
        }
    });

    it('chooses the nearest empty farmland and plants only once per tick', async () => {
        const world = makeCtx({
            farmland: [new Vec3(3, 63, 0), new Vec3(1, 63, 0), new Vec3(2, 63, 0)]
        });

        await new FollowMode().tick(world.ctx);

        assert.equal(world.planted.length, 1);
        assert.equal(world.item.count, 3);
        assert.equal(world.planted[0].reference.position.x, 1);
        assert.deepEqual(world.planted[0].face, new Vec3(0, 1, 0));
    });

    it('walks toward farmland outside placement range', async () => {
        const world = makeCtx({ farmland: [new Vec3(6, 63, 0)] });

        await new FollowMode().tick(world.ctx);

        assert.equal(world.planted.length, 0);
        assert.equal(world.calls.length, 1);
        assert.equal(world.calls[0].type, 'goToward');
        assert.deepEqual(world.calls[0].pos, new Vec3(6, 64, 0));
        assert.equal(world.calls[0].range, 2);
    });

    it('completes approach then planting across consecutive follow ticks', async () => {
        const world = makeCtx({ farmland: [new Vec3(6, 63, 0)] });
        const mode = new FollowMode();

        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).type, 'goToward');
        assert.equal(world.planted.length, 0);

        world.ctx.bot.entity.position = new Vec3(4, 64, 0);
        await mode.tick(world.ctx);

        assert.equal(world.planted.length, 1);
        assert.equal(world.item.count, 3);
        assert.equal(world.planted[0].reference.position.x, 6);
    });

    it('continues planting beyond owner_near_radius up to the planting owner limit', async () => {
        const world = makeCtx({ farmland: [new Vec3(6, 63, 0)] });
        const mode = new FollowMode();

        await mode.tick(world.ctx);
        world.ctx.ownerEntity.position = new Vec3(20, 64, 0);
        world.ctx.bot.entity.position = new Vec3(4, 64, 0);
        await mode.tick(world.ctx);

        assert.equal(world.planted.length, 1);
    });

    it('skips occupied or out-of-range farmland and does nothing without a supported item', async () => {
        const occupied = makeCtx({ occupied: ['1,64,0'] });
        await new FollowMode().tick(occupied.ctx);
        assert.equal(occupied.planted.length, 0);

        const outOfRange = makeCtx({ farmland: [new Vec3(17, 63, 0)] });
        await new FollowMode().tick(outOfRange.ctx);
        assert.equal(outOfRange.planted.length, 0);
        assert.equal(outOfRange.calls.some((call) => call.type === 'goToward'), false);

        const noSeed = makeCtx({ itemName: null });
        await new FollowMode().tick(noSeed.ctx);
        assert.equal(noSeed.planted.length, 0);
        assert.equal(noSeed.findCalls, 0);
    });

    it('does not plant while the owner is far or a higher-priority action owns the bot', async () => {
        const ownerFar = makeCtx({ ownerPos: new Vec3(33, 64, 0) });
        await new FollowMode().tick(ownerFar.ctx);
        assert.equal(ownerFar.findCalls, 0);

        const waiting = makeCtx({ fsmId: 'wait' });
        await new FollowMode().tick(waiting.ctx);
        assert.equal(waiting.findCalls, 0);

        const combat = makeCtx({ fsmId: 'follow', reflexes: { wantsCombat: true } });
        await new FollowMode().tick(combat.ctx);
        assert.equal(combat.findCalls, 0);

        const recovery = makeCtx({ fsmId: 'follow', recoveryActive: true });
        await new FollowMode().tick(recovery.ctx);
        assert.equal(recovery.findCalls, 0);

        const pickupPending = makeCtx({ dutyPending: true });
        await new FollowMode().tick(pickupPending.ctx);
        assert.equal(pickupPending.findCalls, 0);
    });

    it('searches from the current bot position and continues beyond the starting radius', async () => {
        const world = makeCtx({
            ownerPos: new Vec3(0, 64, 0),
            farmland: [new Vec3(15, 63, 0), new Vec3(28, 63, 0)]
        });
        const mode = new FollowMode();

        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).pos.x, 15);

        world.ctx.bot.entity.position = new Vec3(13, 64, 0);
        await mode.tick(world.ctx);
        assert.equal(world.planted.at(-1).reference.position.x, 15);

        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).pos.x, 28);

        world.ctx.bot.entity.position = new Vec3(26, 64, 0);
        await mode.tick(world.ctx);
        assert.equal(world.planted.at(-1).reference.position.x, 28);
    });

    it('excludes farmland beyond 32 blocks from the latest owner position', async () => {
        const world = makeCtx({
            ownerPos: new Vec3(-20, 64, 0),
            farmland: [new Vec3(15, 63, 0)]
        });

        await new FollowMode().tick(world.ctx);

        assert.equal(world.findCalls, 1);
        assert.equal(world.planted.length, 0);
        assert.equal(world.calls.some((call) => call.type === 'goToward'), false);
        assert.equal(world.calls.at(-1).type, 'followEntity');
    });

    it('rechecks owner and farmland distances immediately before placement', async () => {
        const world = makeCtx({
            ownerPos: new Vec3(0, 64, 0)
        });
        const equip = world.ctx.bot.equip;
        world.ctx.bot.equip = async (...args) => {
            await equip(...args);
            world.ctx.ownerEntity.position = new Vec3(-32, 64, 0);
        };

        await new FollowMode().tick(world.ctx);

        assert.equal(world.equipped.length, 1);
        assert.equal(world.planted.length, 0);
    });

    it('returns to the last owner position while unloaded, then resumes planting once near', async () => {
        const world = makeCtx({
            ownerPos: new Vec3(10, 64, 0),
            farmland: [new Vec3(15, 63, 0)]
        });
        const mode = new FollowMode();

        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).pos.x, 15);
        world.ctx.ownerEntity = null;
        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).type, 'goToward');
        assert.deepEqual(world.calls.at(-1).pos, { x: 10, y: 64, z: 0 });

        world.ctx.ownerEntity = world.ctx.bot.players.Steve.entity;
        world.ctx.ownerEntity.position = new Vec3(40, 64, 0);
        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).type, 'followEntity');
        assert.equal(world.findCalls, 1);

        world.ctx.bot.entity.position = new Vec3(10, 64, 0);
        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).type, 'goToward');
        assert.equal(world.calls.at(-1).pos.x, 15);
        assert.equal(world.findCalls, 2);
    });

    it('temporarily excludes an unreachable farm and tries the next one', async () => {
        const world = makeCtx({
            farmland: [new Vec3(6, 63, 0), new Vec3(7, 63, 0)]
        });
        const mode = new FollowMode();

        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).pos.x, 6);

        world.ctx.movement.isBlocked = true;
        await mode.tick(world.ctx);
        assert.equal(world.calls.at(-1).type, 'goToward');
        assert.equal(world.calls.at(-1).pos.x, 7);
    });

    it('contains placement failures and resumes following on the next tick', async () => {
        const world = makeCtx({
            ownerPos: new Vec3(10, 64, 0),
            placeError: true
        });
        const mode = new FollowMode();

        await assert.doesNotReject(() => mode.tick(world.ctx));
        await mode.tick(world.ctx);

        assert.ok(world.calls.some((call) => call.type === 'followEntity'));
    });
});
