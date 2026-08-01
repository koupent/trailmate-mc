import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    applyOwnerWorkRetreat,
    isBotInAnyPlayerWorkFov,
    wouldEnterOwnerWorkFov
} from '../src/companion/ownerWorkMovement.js';
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
        const ctx = makeCtx();
        seedPlayerWorkPhase(ctx, 42, OWNER_WORK_PHASES.deferring);
        assert.equal(applyOwnerWorkRetreat(ctx), true);
        assert.ok(ctx.movement.goCalls.length >= 1 || ctx.movement.stopCalls >= 1);
    });
});
