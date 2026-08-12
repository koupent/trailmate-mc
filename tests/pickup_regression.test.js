import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { scanCompanionAwareness } from '../src/world/companionAwareness.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import {
    applyOwnerWorkRetreat,
    isBotInOwnerWorkFov,
    isPositionInOwnerWorkFov,
    wouldEnterOwnerWorkFov
} from '../src/companion/ownerWorkMovement.js';
import {
    OWNER_WORK_PHASES,
    seedPlayerWorkPhase
} from '../src/companion/ownerWorkTracker.js';
import {
    DEFAULT_APPROACH_RANGE,
    pickupNearbyItems,
    PICKUP_CLOSE_APPROACH_RANGE,
    PICKUP_MAGNET_RANGE,
    PICKUP_SETTLE_MS,
    resolvePickupRadius,
    resolveOwnerWorkLootClearance,
    hasNearbyDrops,
    hasOnlyMagnetRangeDrops,
    buildPickupExclude
} from '../src/companion/utils/pickupItems.js';
import { tryOpportunisticCollect } from '../src/companion/utils/opportunisticCollector.js';

function mockMovement() {
    const calls = [];
    return {
        calls,
        isHeld: false,
        stop() {},
        goToward(pos, range) {
            calls.push({ x: pos.x, y: pos.y, z: pos.z, range });
            return true;
        }
    };
}

/**
 * @param {Partial<{
 *   botPos: import('vec3').Vec3,
 *   itemPos: import('vec3').Vec3,
 *   ownerPos: import('vec3').Vec3 | null,
 *   ownerYaw: number,
 *   ownerWorkPhase: string,
 *   workerEntityId: number,
 *   awarenessRadius: number,
 *   nearbyLootRadius: number,
 *   movement: ReturnType<typeof mockMovement>
 * }>} [opts]
 */
function makePickupCtx(opts = {}) {
    const botPos = opts.botPos || new Vec3(0, 64, 0);
    const itemPos = opts.itemPos || new Vec3(1, 64, 0);
    const movement = opts.movement || mockMovement();
    const ownerId = 7;
    const bot = {
        entity: { position: botPos },
        entities: {
            1: { id: 1, name: 'item', position: itemPos }
        },
        inventory: {
            emptySlotCount: () => 1,
            items: () => []
        },
        players: opts.ownerPos
            ? { Steve: { entity: { id: ownerId, position: opts.ownerPos, yaw: opts.ownerYaw ?? 0 } } }
            : {},
        interrupt_code: false
    };
    if (opts.ownerPos) {
        bot.entities[ownerId] = bot.players.Steve.entity;
    }
    const ctx = {
        bot,
        movement,
        ownerName: opts.ownerPos ? 'Steve' : null,
        ownerEntity: opts.ownerPos
            ? bot.players.Steve.entity
            : null,
        config: {
            awareness_radius: opts.awarenessRadius ?? 10,
            owner_near_radius: opts.ownerNearRadius ?? 12,
            nearby_loot: { enabled: true, radius: opts.nearbyLootRadius ?? 8 },
            owner_work: { enabled: true, all_players: true, fov_degrees: 100 }
        },
        playerWorkById: new Map(),
        deathRecovery: { active: false },
        graveLoot: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        holdReflexes: false
    };
    const workPhase = opts.ownerWorkPhase || OWNER_WORK_PHASES.idle;
    if (workPhase !== OWNER_WORK_PHASES.idle) {
        const workerId = opts.workerEntityId ?? ownerId;
        seedPlayerWorkPhase(ctx, workerId, workPhase);
        if (workerId !== ownerId && !bot.entities[workerId]) {
            bot.entities[workerId] = {
                id: workerId,
                type: 'player',
                position: opts.ownerPos || new Vec3(0, 64, 0),
                yaw: opts.ownerYaw ?? 0
            };
            bot.players.Worker = { entity: bot.entities[workerId] };
        }
    }
    const radius = resolvePickupRadius(ctx);
    ctx.getCompanionAwareness = () => scanCompanionAwareness(bot, radius, botPos);
    ctx.invalidateCompanionAwareness = () => {};
    return ctx;
}

describe('pickup regression', () => {
    it('resolvePickupRadius uses the larger of awareness and nearby_loot.radius', () => {
        assert.equal(resolvePickupRadius({
            config: { awareness_radius: 10, nearby_loot: { radius: 8 } }
        }), 10);
        assert.equal(resolvePickupRadius({
            config: { awareness_radius: 6, nearby_loot: { radius: 12 } }
        }), 12);
    });

    it('approaches the nearest visible drop first when several are present', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(8, 64, 0),
            movement
        });
        ctx.bot.entities[2] = { id: 2, name: 'item', position: new Vec3(2, 64, 0) };

        await pickupNearbyItems(ctx, {
            durationMs: 120,
            pollMs: 20,
            untilClear: false
        });

        assert.ok(movement.calls.length >= 1, 'expected movement toward nearest drop');
        const first = movement.calls[0];
        assert.ok(Math.abs(first.x - 2) < Math.abs(first.x - 8));
    });

    it('re-targets to a closer drop instead of committing to a distant one', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(8, 64, 0),
            movement
        });
        ctx.bot.entities[2] = { id: 2, name: 'item', position: new Vec3(2, 64, 0) };

        await pickupNearbyItems(ctx, {
            durationMs: 200,
            pollMs: 30,
            untilClear: false
        });

        const towardNear = movement.calls.some((call) => Math.abs(call.x - 2) < 1);
        assert.equal(towardNear, true);
        const onlyFar = movement.calls.every((call) => Math.abs(call.x - 8) < 1);
        assert.equal(onlyFar, false);
    });

    it('moves toward items that are nearby but outside magnet range', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0, 64, 1.5),
            movement
        });

        await pickupNearbyItems(ctx, {
            durationMs: 400,
            pollMs: 20,
            untilClear: false
        });

        assert.ok(movement.calls.length >= 1, 'expected pathfinder movement before magnet range');
    });

    it('uses a sub-block path range so an adjacent block is not treated as pickup arrival', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(1.1, 64, 0),
            movement
        });
        const originalGoToward = movement.goToward.bind(movement);
        movement.goToward = (pos, range) => {
            const result = originalGoToward(pos, range);
            delete ctx.bot.entities[1];
            return result;
        };

        await pickupNearbyItems(ctx, {
            durationMs: 200,
            pollMs: 10,
            settleMs: 10,
            untilClear: false
        });

        assert.ok(movement.calls.length >= 1, 'expected movement for a drop 1.1 blocks away');
        assert.equal(movement.calls[0].range, DEFAULT_APPROACH_RANGE);
        assert.ok(movement.calls[0].range < 1);
    });

    it('moves closer when a drop remains after the initial pickup settle', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0.9, 64, 0),
            movement
        });
        const originalGoToward = movement.goToward.bind(movement);
        movement.goToward = (pos, range) => {
            const result = originalGoToward(pos, range);
            if (range === PICKUP_CLOSE_APPROACH_RANGE) {
                delete ctx.bot.entities[1];
            }
            return result;
        };

        await pickupNearbyItems(ctx, {
            durationMs: 200,
            pollMs: 10,
            settleMs: 10,
            untilClear: false
        });

        assert.ok(
            movement.calls.some((call) => call.range === PICKUP_CLOSE_APPROACH_RANGE),
            'expected a tighter approach after the item remained visible'
        );
    });

    it('hands a persistent magnet-range drop from passive settle to active pickup', () => {
        const movement = mockMovement();
        let stops = 0;
        movement.stop = () => { stops += 1; };
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0.9, 64, 0),
            movement
        });

        assert.equal(tryOpportunisticCollect(ctx, 1000), true);
        assert.equal(tryOpportunisticCollect(ctx, 1000 + PICKUP_SETTLE_MS - 1), true);
        assert.equal(hasOnlyMagnetRangeDrops(ctx, 1000 + PICKUP_SETTLE_MS - 1), true);
        assert.equal(hasOnlyMagnetRangeDrops(ctx, 1000 + PICKUP_SETTLE_MS), false);
        assert.equal(tryOpportunisticCollect(ctx, 1000 + PICKUP_SETTLE_MS), false);
        assert.equal(stops, 1, 'settle should stop movement only once in this sequence');

        delete ctx.bot.entities[1];
        assert.equal(tryOpportunisticCollect(ctx, 1000 + PICKUP_SETTLE_MS + 1), false);
        assert.equal(ctx.nearbyLoot.pickupSettle, null, 'pickup state should clear after collection');
    });

    it('treats a drop 1.1 blocks away as requiring active pickup', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(1.1, 64, 0)
        });
        assert.equal(PICKUP_MAGNET_RANGE, 0.95);
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('approaches a nearby drop when owner work is idle', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(2, 64, 0),
            movement
        });
        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.ok(attempts >= 1);
        assert.ok(movement.calls.length >= 1);
    });

    it('owner作業中でもドロップがあればshouldRunがtrueになる', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makePickupCtx({
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            itemPos: new Vec3(5, 64, 0)
        });
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('owner作業中は視界内の遠方ドロップへは近づかない', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 6),
            itemPos: new Vec3(0, 64, -3),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: -3 }), true);

        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.equal(attempts, 0);
        assert.equal(movement.calls.length, 0);
    });

    it('owner作業中はオーナー視界内のドロップを横取りしない', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -3),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(hasNearbyDrops(ctx), false);

        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.equal(attempts, 0);
        assert.equal(movement.calls.length, 0);
    });

    it('owner作業中はオーナー近傍のドロップだけではshouldRunがfalse', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -1),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(interrupt.shouldRun(ctx), false);
    });

    it('owner作業中でもオーナー視界外のドロップがあればshouldRunがtrue', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 6),
            itemPos: new Vec3(0, 64, 12),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(interrupt.shouldRun(ctx), true);
    });

    it('マグネット範囲内だけのドロップではshouldRunがfalseになる', () => {
        const interrupt = new NearbyLootInterrupt();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(0.5, 64, 0),
            ownerPos: new Vec3(0, 64, 0)
        });
        assert.equal(interrupt.shouldRun(ctx), false);
    });

    it('exits immediately after the last drop is gone instead of waiting grace+quiet', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 0),
            itemPos: new Vec3(2, 64, 0),
            movement
        });
        let scans = 0;
        const baseAwareness = ctx.getCompanionAwareness;
        ctx.getCompanionAwareness = () => {
            const snap = baseAwareness();
            scans += 1;
            if (scans >= 3) {
                return { ...snap, dropItems: [] };
            }
            return snap;
        };
        const started = Date.now();
        await pickupNearbyItems(ctx, {
            durationMs: 15000,
            pollMs: 20,
            untilClear: true,
            graceMs: 2500,
            quietMs: 1500
        });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1500, `expected fast release after pickup, elapsed=${elapsed}`);
    });

    it('拾えないドロップだけのときは長時間ブロックしない', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -1),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        const started = Date.now();
        await pickupNearbyItems(ctx, {
            durationMs: 15000,
            pollMs: 20,
            untilClear: true,
            graceMs: 2500,
            quietMs: 1500
        });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1000, `expected quick exit, elapsed=${elapsed}`);
    });

    it('resolveOwnerWorkLootClearance prefers nearby_loot.owner_clearance', () => {
        assert.equal(resolveOwnerWorkLootClearance({
            config: { nearby_loot: { owner_clearance: 5 }, owner_near_radius: 12 }
        }), 5);
        assert.equal(resolveOwnerWorkLootClearance({
            config: { follow_distance: 3, owner_near_radius: 12 }
        }), 4);
    });

    it('buildPickupExclude blocks owner-FOV drops during deferring', () => {
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -1),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        const exclude = buildPickupExclude(ctx, { magnetRange: PICKUP_MAGNET_RANGE });
        assert.equal(exclude(ctx.bot.entities[1]), true);
    });

    it('excludes a protected player-mined drop from active pickup until protection expires', () => {
        const ctx = makePickupCtx({ itemPos: new Vec3(0.5, 64, 0) });
        let protectedDrop = true;
        ctx.playerDropGuard = {
            isProtected(entity) {
                return protectedDrop && entity.id === 1;
            }
        };

        const exclude = buildPickupExclude(ctx, { magnetRange: PICKUP_MAGNET_RANGE });
        assert.equal(exclude(ctx.bot.entities[1]), true);

        protectedDrop = false;
        assert.equal(exclude(ctx.bot.entities[1]), false);
    });

    it('excludes a protected player-mined drop from opportunistic pickup', () => {
        const ctx = makePickupCtx({ itemPos: new Vec3(0.5, 64, 0) });
        let protectedDrop = true;
        ctx.playerDropGuard = {
            isProtected(entity) {
                return protectedDrop && entity.id === 1;
            }
        };

        assert.equal(tryOpportunisticCollect(ctx, 1000), false);

        protectedDrop = false;
        assert.equal(tryOpportunisticCollect(ctx, 1001), true);
    });

    it('keeps approaching a drop outside worker FOV even when path crosses FOV', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 6),
            itemPos: new Vec3(0, 64, 8),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(isBotInOwnerWorkFov(ctx), false);
        assert.equal(isPositionInOwnerWorkFov(ctx, { x: 0, y: 64, z: 8 }), false);

        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.ok(attempts >= 1);
        assert.ok(movement.calls.length >= 1);
    });

    it('owner作業中は視界外の近傍ドロップへ近づく', async () => {
        const movement = mockMovement();
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 4),
            itemPos: new Vec3(0, 64, 8),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: 8 }), false);

        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.ok(attempts >= 1);
        assert.ok(movement.calls.length >= 1);
    });

    it('magnet range allows pickup beside owner FOV without entering it', () => {
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, 6),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        const besideBot = { x: 0, y: 64, z: 6.5 };
        assert.ok(
            wouldEnterOwnerWorkFov(ctx, besideBot, { withinPickupRange: PICKUP_MAGNET_RANGE }) === false
        );
    });

    it('hasNearbyDrops ignores blocked owner-work drops', () => {
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -1),
            ownerPos: new Vec3(0, 64, 0),
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            movement: mockMovement()
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(hasNearbyDrops(ctx), false);
    });

    it('hasNearbyDrops rescans instead of trusting an empty cached snapshot', () => {
        const botPos = new Vec3(0, 64, 0);
        const bot = {
            entity: { position: botPos },
            entities: {}
        };
        const ctx = makePickupCtx({ botPos, movement: mockMovement() });
        ctx._awareness = { dropItems: [], radius: 12 };
        bot.entities[1] = { name: 'item', position: new Vec3(2, 64, 0) };
        assert.equal(hasNearbyDrops(ctx), true);
    });

    it('オーナー未設定でも他プレイヤー作業中は視界内ドロップを横取りしない', async () => {
        const movement = mockMovement();
        const workerPos = new Vec3(0, 64, 0);
        const ctx = makePickupCtx({
            botPos: new Vec3(0, 64, -3),
            itemPos: new Vec3(0, 64, -1),
            ownerPos: null,
            ownerWorkPhase: OWNER_WORK_PHASES.deferring,
            workerEntityId: 42,
            movement
        });
        ctx.bot.entities[42] = { id: 42, type: 'player', position: workerPos, yaw: 0 };
        ctx.bot.players.Worker = { entity: ctx.bot.entities[42] };
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);

        const attempts = await pickupNearbyItems(ctx, {
            durationMs: 300,
            pollMs: 20,
            untilClear: false
        });
        assert.equal(attempts, 0);
        assert.equal(hasNearbyDrops(ctx), false);
    });

    it('detects drops out to the configured pickup radius', () => {
        const botPos = new Vec3(0, 64, 0);
        const bot = {
            entity: { position: botPos },
            entities: {
                1: { name: 'item', position: new Vec3(9.5, 64, 0) },
                2: { name: 'item', position: new Vec3(10.5, 64, 0) }
            }
        };
        const snap = scanCompanionAwareness(bot, 10, botPos);
        assert.equal(snap.dropItems.length, 1);
    });
});
