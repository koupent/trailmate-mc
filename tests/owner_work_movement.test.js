import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    applyOwnerWorkRetreat,
    getDeferringPlayerEntities,
    isBotInAnyPlayerWorkFov,
    wouldEnterOwnerWorkFov
} from '../src/companion/ownerWorkMovement.js';
import { isBotInOwnerFov } from '../src/companion/followPosition.js';
import {
    OWNER_WORK_PHASES,
    seedPlayerWorkPhase
} from '../src/companion/ownerWorkTracker.js';

function makeCtx(overrides = {}) {
    const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
    const other = { id: 42, position: { x: 8, y: 64, z: 0 }, yaw: 0 };
    return {
        ownerEntity: owner,
        config: {
            owner_work: {
                enabled: true,
                all_players: true,
                fov_degrees: 100
            },
            follow_distance: 3
        },
        playerWorkById: new Map(),
        bot: {
            entity: { position: { x: 0, y: 64, z: -4 } },
            players: {
                Steve: { entity: owner },
                Other: { entity: other }
            },
            entities: {
                7: owner,
                42: other
            }
        },
        movement: {
            isHeld: false,
            stopCalls: 0,
            goCalls: [],
            stop() { this.stopCalls += 1; },
            goToward(pos, range) {
                this.goCalls.push({ x: pos.x, y: pos.y, z: pos.z, range });
                return true;
            }
        },
        ...overrides
    };
}

describe('ownerWorkMovement', () => {
    it('detects when the bot is inside a working player FOV', () => {
        const ctx = makeCtx();
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(isBotInAnyPlayerWorkFov(ctx), true);
        ctx.bot.entity.position = { x: 0, y: 64, z: 6 };
        assert.equal(isBotInAnyPlayerWorkFov(ctx), false);
    });

    it('detects when the bot is inside another working player FOV', () => {
        const ctx = makeCtx({
            bot: {
                entity: { position: { x: 8, y: 64, z: -4 } },
                players: {
                    Steve: { entity: { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 } },
                    Other: { entity: { id: 42, position: { x: 8, y: 64, z: 0 }, yaw: 0 } }
                },
                entities: {
                    42: { id: 42, position: { x: 8, y: 64, z: 0 }, yaw: 0 }
                }
            }
        });
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);
        assert.equal(isBotInAnyPlayerWorkFov(ctx), true);
    });

    it('blocks pathing from outside the FOV into the FOV during player work', () => {
        const ctx = makeCtx({
            bot: { entity: { position: { x: 0, y: 64, z: 6 } }, players: makeCtx().bot.players, entities: makeCtx().bot.entities }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: -3 }), true);
        assert.equal(wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: 8 }), false);
    });

    it('allows magnet-range pickup beside player FOV without entering it', () => {
        const ctx = makeCtx({
            bot: { entity: { position: { x: 0, y: 64, z: 6 } }, players: makeCtx().bot.players, entities: makeCtx().bot.entities }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(
            wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: 6.5 }, { withinPickupRange: 1 }),
            false
        );
    });

    it('does not block movement when no player is working', () => {
        const ctx = makeCtx({
            bot: { entity: { position: { x: 0, y: 64, z: 6 } }, players: makeCtx().bot.players, entities: makeCtx().bot.entities }
        });
        assert.equal(wouldEnterOwnerWorkFov(ctx, { x: 0, y: 64, z: 2 }), false);
    });

    it('retreats from a non-owner working player', () => {
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 8, y: 64, z: -4 } },
                players: makeCtx().bot.players,
                entities: makeCtx().bot.entities
            }
        });
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.ok(ctx.movement.goCalls.length >= 1 || ctx.movement.stopCalls >= 1);
    });

    it('does not approach an unrelated equipped player when already clear of their view', () => {
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: 6 } },
                players: makeCtx().bot.players,
                entities: makeCtx().bot.entities
            }
        });
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);

        assert.equal(applyOwnerWorkRetreat(ctx), false);
        assert.equal(ctx.movement.goCalls.length, 0);
        assert.equal(ctx.movement.stopCalls, 0);
    });

    it('keeps a nearby out-of-view anchor while equipment remains held', () => {
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: 8 } },
                players: makeCtx().bot.players,
                entities: makeCtx().bot.entities
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);

        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 1);
        assert.equal(isBotInOwnerFov(ctx.ownerEntity, ctx.movement.goCalls[0], 100), false);
    });

    it('repositions when a turn brings the bot into the equipped player view', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const ctx = makeCtx({
            ownerEntity: owner,
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: 3 } },
                players: { Steve: { entity: owner } },
                entities: { 7: owner }
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(isBotInOwnerFov(owner, ctx.bot.entity.position, 100), false);

        owner.yaw = Math.PI;
        assert.equal(isBotInOwnerFov(owner, ctx.bot.entity.position, 100), true);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 1);
        assert.equal(isBotInOwnerFov(owner, ctx.movement.goCalls[0], 100), false);
    });

    it('chooses a retreat target outside every working player FOV', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const other = { id: 42, position: { x: 3, y: 64, z: 3 }, yaw: 0 };
        const ctx = makeCtx({
            ownerEntity: owner,
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: -2 } },
                players: {
                    Steve: { entity: owner },
                    Other: { entity: other }
                },
                entities: { 7: owner, 42: other }
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);

        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 1);
        const target = ctx.movement.goCalls[0];
        for (const worker of getDeferringPlayerEntities(ctx)) {
            assert.equal(isBotInOwnerFov(worker, target, 100), false);
            assert.ok(
                Math.hypot(target.x - worker.position.x, target.z - worker.position.z) >= 3,
                'target must clear the worker proximity radius'
            );
        }
    });

    it('retreats laterally when the bot is ahead in the mining lane', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const chats = [];
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: -2 } },
                players: { Steve: { entity: owner } },
                entities: { 7: owner },
                chat: (msg) => { chats.push(msg); }
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 1);
        assert.equal(ctx.movement.stopCalls, 0);
        const dest = ctx.movement.goCalls[0];
        assert.ok(Math.abs(dest.x) >= 2.5, `expected lateral retreat, got x=${dest.x}`);
        assert.equal(chats.length, 0);
    });

    it('stops and notifies when the only path crosses the player', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const chats = [];
        // Wide FOV so lateral candidates are inside the cone; only behind remains.
        const ctx = makeCtx({
            config: {
                owner_work: {
                    enabled: true,
                    all_players: true,
                    fov_degrees: 359
                },
                follow_distance: 3
            },
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: -2 } },
                players: { Steve: { entity: owner } },
                entities: { 7: owner },
                chat: (msg) => { chats.push(msg); }
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.stopCalls, 1);
        assert.equal(ctx.movement.goCalls.length, 0);
        assert.ok(chats.length >= 1);
        assert.match(chats[0], /通れない/);
    });

    it('stops when already within push range even if a lateral target exists', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const chats = [];
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 0.4, y: 64, z: 0.3 } },
                players: { Steve: { entity: owner } },
                entities: { 7: owner },
                chat: (msg) => { chats.push(msg); },
                blockAt: () => ({ name: 'air', boundingBox: 'empty' })
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 0);
        assert.equal(ctx.movement.stopCalls, 1);
        assert.ok(chats.length >= 1);
        assert.match(chats[0], /通れない/);
    });

    it('does not goToward when the yield target would push through the player', () => {
        // Bot ahead of miner; laterals exist but are treated as blocked by placing
        // a second body on each side so the only fallback (behind) crosses the owner.
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const leftGuard = { id: 8, position: { x: 1.5, y: 64, z: -1 }, yaw: 0 };
        const rightGuard = { id: 9, position: { x: -1.5, y: 64, z: -1 }, yaw: 0 };
        const chats = [];
        const ctx = makeCtx({
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: -2 } },
                players: {
                    Steve: { entity: owner },
                    Left: { entity: leftGuard },
                    Right: { entity: rightGuard }
                },
                entities: { 7: owner, 8: leftGuard, 9: rightGuard },
                chat: (msg) => { chats.push(msg); }
            }
        });
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.equal(ctx.movement.goCalls.length, 0, 'must not path through players');
        assert.equal(ctx.movement.stopCalls, 1);
        assert.ok(chats.length >= 1);
        assert.match(chats[0], /通れない/);
    });
});
