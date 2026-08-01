import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isOwnerWorkDeferring,
    notePlayerBlockBreakProgress,
    OWNER_WORK_PHASES,
    seedPlayerWorkPhase,
    tickOwnerWork
} from '../src/companion/ownerWorkTracker.js';

function makeCtx(overrides = {}) {
    const owner = { id: 7, type: 'player', position: { x: 0, y: 64, z: 0 } };
    return {
        ownerEntity: owner,
        bot: {
            entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
            players: {
                Steve: { entity: owner }
            }
        },
        config: {
            owner_work: {
                enabled: true,
                all_players: true,
                fov_degrees: 100,
                swing_idle_ms: 1000,
                post_work_cooldown_ms: 4000
            }
        },
        playerWorkById: new Map(),
        ...overrides
    };
}

describe('ownerWorkTracker', () => {
    it('starts idle', () => {
        const ctx = makeCtx();
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('stays idle without block break progress', () => {
        const ctx = makeCtx();
        assert.equal(isOwnerWorkDeferring(ctx), false);
        tickOwnerWork(ctx, 1_000_000);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('enters deferring on block break progress', () => {
        const ctx = makeCtx();
        notePlayerBlockBreakProgress(ctx, ctx.ownerEntity, 1_000_000);
        assert.equal(isOwnerWorkDeferring(ctx), true);
    });

    it('moves to cooldown after break idle, then back to idle', () => {
        const ctx = makeCtx();
        const t0 = 1_000_000;
        notePlayerBlockBreakProgress(ctx, ctx.ownerEntity, t0);
        tickOwnerWork(ctx, t0 + 500);
        assert.equal(isOwnerWorkDeferring(ctx), true);

        tickOwnerWork(ctx, t0 + 1000);
        assert.equal(isOwnerWorkDeferring(ctx), true);

        tickOwnerWork(ctx, t0 + 1000 + 3999);
        assert.equal(isOwnerWorkDeferring(ctx), true);

        tickOwnerWork(ctx, t0 + 1000 + 4000);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('stays deferring while block break progress continues', () => {
        const ctx = makeCtx();
        const t0 = 1_000_000;
        notePlayerBlockBreakProgress(ctx, ctx.ownerEntity, t0);
        notePlayerBlockBreakProgress(ctx, ctx.ownerEntity, t0 + 800);
        tickOwnerWork(ctx, t0 + 1500);
        assert.equal(isOwnerWorkDeferring(ctx), true);
        tickOwnerWork(ctx, t0 + 800 + 1000);
        assert.equal(isOwnerWorkDeferring(ctx), true);
    });

    it('does nothing when owner_work is disabled', () => {
        const ctx = makeCtx({
            config: { owner_work: { enabled: false } }
        });
        notePlayerBlockBreakProgress(ctx, ctx.ownerEntity, Date.now());
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('seedPlayerWorkPhase supports test fixtures', () => {
        const ctx = makeCtx();
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        assert.equal(isOwnerWorkDeferring(ctx), true);
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.idle);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });
});
