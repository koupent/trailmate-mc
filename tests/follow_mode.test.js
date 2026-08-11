import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import { resolveFollowPhase } from '../src/companion/movement/followPhase.js';
import { wouldPathPassNearPlayer } from '../src/companion/movement/playerPathClearance.js';
import { PICKUP_SETTLE_MS } from '../src/companion/utils/pickupItems.js';

function solidBlock() {
    return { name: 'stone', boundingBox: 'block' };
}

function airBlock() {
    return { name: 'air', boundingBox: 'empty' };
}

function mockMovement() {
    const calls = [];
    return {
        calls,
        isHeld: false,
        hasGoal: false,
        isMoving: false,
        isBlocked: false,
        stop() {
            this.hasGoal = false;
            calls.push({ type: 'stop' });
        },
        followEntity(entity, range, opts = {}) {
            const rejected = Boolean(opts.rejectIf?.());
            const skipped = this.hasGoal && !this.isBlocked;
            calls.push({
                type: 'followEntity',
                rejected,
                skipped,
                entityId: entity?.id,
                endpointVisibilityTargetId: opts.endpointVisibilityTarget?.id,
                range
            });
            if (!rejected && !skipped) this.hasGoal = true;
            return !rejected && !skipped;
        },
        goToward(pos, range, opts = {}) {
            const rejected = Boolean(opts.rejectIf?.());
            calls.push({
                type: 'goToward',
                rejected,
                endpointVisibilityTargetId: opts.endpointVisibilityTarget?.id,
                pos,
                range
            });
            if (!rejected) this.hasGoal = true;
            return !rejected;
        },
        tickHoldWatchdog() {}
    };
}

function makeFollowCtx(botPos, ownerPos, overrides = {}) {
    const owner = {
        id: 7,
        position: ownerPos,
        yaw: overrides.ownerYaw ?? 0,
        height: 1.8
    };
    const movement = mockMovement();
    if (overrides.movement) Object.assign(movement, overrides.movement);
    const bot = {
        entity: { id: 1, position: botPos, height: 1.8 },
        players: { Steve: { entity: owner } },
        blockAt: overrides.blockAt || (() => airBlock()),
        world: { raycast: () => (overrides.blockedLos ? {} : null) }
    };
    return {
        bot,
        ownerName: 'Steve',
        ownerEntity: owner,
        movement,
        config: {
            follow_distance: 3,
            follow_min_distance: 2,
            owner_work: { enabled: false, all_players: true, fov_degrees: 100 },
            nearby_loot: { collector_enabled: false }
        },
        playerWorkById: new Map(),
        deathRecovery: { active: false },
        nearbyLoot: { active: false, suppressUntil: 0 },
        doors: {
            findSeparatingPassage: overrides.doorSeparated ? () => true : () => false,
            tick: async () => {}
        },
        agent: { reflexes: null }
    };
}

describe('FollowMode merge follow', () => {
    it('lets boat boarding own the tick before normal follow movement', async () => {
        const ctx = makeFollowCtx(new Vec3(0, 64, 0), new Vec3(2, 64, 0));
        let boardCalls = 0;
        ctx.boatPassenger = {
            tryBoard(owner) {
                boardCalls += 1;
                assert.equal(owner, ctx.ownerEntity);
                return true;
            }
        };

        await new FollowMode().tick(ctx);

        assert.equal(boardCalls, 1);
        assert.equal(ctx.movement.calls.length, 0);
    });

    it('pauses once for passive pickup, then resumes follow when the item remains', async () => {
        const ctx = makeFollowCtx(new Vec3(0, 64, 0), new Vec3(12, 64, 0));
        ctx.config.nearby_loot.collector_enabled = true;
        ctx.bot.entities = {
            9: { id: 9, name: 'item', position: new Vec3(0.9, 64, 0) }
        };
        ctx.bot.inventory = { emptySlotCount: () => 1 };

        const mode = new FollowMode();
        await mode.tick(ctx);
        assert.deepEqual(
            ctx.movement.calls.map((call) => call.type),
            ['stop'],
            'the initial settle should own the tick'
        );

        ctx.nearbyLoot.pickupSettle.startedAt = Date.now() - PICKUP_SETTLE_MS;
        await mode.tick(ctx);

        assert.equal(
            ctx.movement.calls.filter((call) => call.type === 'stop').length,
            1,
            'a persistent item must not stop follow every tick'
        );
        assert.ok(
            ctx.movement.calls.some((call) => call.type === 'followEntity'),
            'follow should resume so the FSM can hand the item to active pickup'
        );
    });

    it('does not reject followEntity when path check targets the owner', async () => {
        const ownerPos = new Vec3(12, 64, 0);
        const botPos = new Vec3(0, 64, 0);
        const ctx = makeFollowCtx(botPos, ownerPos);

        assert.equal(wouldPathPassNearPlayer(ctx, ownerPos), true);

        const mode = new FollowMode();
        await mode.tick(ctx);

        const follow = ctx.movement.calls.find((call) => call.type === 'followEntity');
        assert.ok(follow, 'expected followEntity call');
        assert.equal(follow.rejected, false);
        assert.equal(follow.endpointVisibilityTargetId, ctx.ownerEntity.id);
        assert.equal(ctx.movement.hasGoal, true);
    });

    it('resumes merge follow after owner leaves near range', async () => {
        const mode = new FollowMode();
        const closeCtx = makeFollowCtx(new Vec3(0, 64, 0), new Vec3(1, 64, 0));
        await mode.tick(closeCtx);
        assert.equal(closeCtx.movement.calls.at(-1)?.type, 'stop');

        const farCtx = makeFollowCtx(new Vec3(0, 64, 0), new Vec3(12, 64, 0), { blockedLos: true });
        await mode.tick(farCtx);
        const follow = farCtx.movement.calls.find((call) => call.type === 'followEntity');
        assert.ok(follow, 'expected followEntity after owner moved away');
        assert.equal(follow.rejected, false);
        assert.equal(resolveFollowPhase(farCtx, farCtx.ownerEntity), 'merge');
    });

    it('follows through a door when owner is close but separated by a passage', async () => {
        const ownerPos = new Vec3(0, 64, 0);
        const botPos = new Vec3(0, 64, -1.5);
        const ctx = makeFollowCtx(botPos, ownerPos, { doorSeparated: true });

        assert.notEqual(resolveFollowPhase(ctx, ctx.ownerEntity), 'near');

        const mode = new FollowMode();
        await mode.tick(ctx);
        const follow = ctx.movement.calls.find((call) => call.type === 'followEntity');
        assert.ok(follow, 'expected followEntity through separating door');
        assert.equal(follow.rejected, false);
    });
});

describe('FollowMode unified owner follow', () => {
    it('uses the owner follow goal in a narrow corridor instead of a yaw-based anchor', async () => {
        const ownerPos = new Vec3(0, 64, 0);
        const botPos = new Vec3(0, 64, 3);
        const ctx = makeFollowCtx(botPos, ownerPos, {
            blockAt: ({ x }) => (x === -1 || x === 1 ? solidBlock() : airBlock())
        });

        assert.equal(resolveFollowPhase(ctx, ctx.ownerEntity), 'trail');

        const mode = new FollowMode();
        await mode.tick(ctx);

        const follow = ctx.movement.calls.find((call) => call.type === 'followEntity');
        assert.ok(follow, 'expected the same owner follow used outside corridors');
        assert.equal(follow.rejected, false);
        assert.equal(follow.endpointVisibilityTargetId, ctx.ownerEntity.id);
        assert.equal(ctx.movement.calls.some((call) => call.type === 'stop'), false);
    });

    it('keeps targeting the owner while they move through a corridor', async () => {
        const mode = new FollowMode();
        const blockAt = ({ x }) => (x === -1 || x === 1 ? solidBlock() : airBlock());

        for (let z = 3; z <= 9; z += 2) {
            const ownerPos = new Vec3(0, 64, z - 3);
            const botPos = new Vec3(0, 64, z);
            const ctx = makeFollowCtx(botPos, ownerPos, { blockAt });
            assert.equal(resolveFollowPhase(ctx, ctx.ownerEntity), 'trail');
            await mode.tick(ctx);
            const last = ctx.movement.calls.at(-1);
            assert.equal(last?.type, 'followEntity', `tick at owner z=${ownerPos.z} should followEntity`);
            assert.equal(last?.rejected, false);
        }
    });
});

describe('FollowMode blocked goal refresh', () => {
    it('calls followEntity again when the previous goal was blocked', async () => {
        const ctx = makeFollowCtx(new Vec3(0, 64, 0), new Vec3(12, 64, 0));
        ctx.movement.hasGoal = true;
        ctx.movement.isBlocked = true;

        const mode = new FollowMode();
        await mode.tick(ctx);

        const follow = ctx.movement.calls.find((call) => call.type === 'followEntity');
        assert.ok(follow, 'expected followEntity refresh');
        assert.equal(follow.skipped, false);
    });
});
