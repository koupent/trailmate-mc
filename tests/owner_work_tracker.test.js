import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createOwnerWorkState,
    isOwnerWorkDeferring,
    noteOwnerSwing,
    OWNER_WORK_PHASES,
    tickOwnerWork
} from '../src/companion/ownerWorkTracker.js';

function makeCtx(overrides = {}) {
    return {
        ownerEntity: { id: 7, position: { x: 0, y: 64, z: 0 } },
        config: {
            owner_work: {
                enabled: true,
                fov_degrees: 100,
                swing_idle_ms: 1000,
                post_work_cooldown_ms: 4000
            }
        },
        ownerWork: createOwnerWorkState(),
        ...overrides
    };
}

describe('ownerWorkTracker', () => {
    it('starts idle', () => {
        const ctx = makeCtx();
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.idle);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('enters deferring on owner swing', () => {
        const ctx = makeCtx();
        const t0 = 1_000_000;
        noteOwnerSwing(ctx, t0);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.deferring);
        assert.equal(isOwnerWorkDeferring(ctx), true);
    });

    it('moves to cooldown after swing idle, then back to idle', () => {
        const ctx = makeCtx();
        const t0 = 1_000_000;
        noteOwnerSwing(ctx, t0);
        tickOwnerWork(ctx, t0 + 500);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.deferring);

        tickOwnerWork(ctx, t0 + 1000);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.cooldown);
        assert.equal(isOwnerWorkDeferring(ctx), true);

        tickOwnerWork(ctx, t0 + 1000 + 3999);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.cooldown);

        tickOwnerWork(ctx, t0 + 1000 + 4000);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.idle);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('stays deferring while swings continue', () => {
        const ctx = makeCtx();
        const t0 = 1_000_000;
        noteOwnerSwing(ctx, t0);
        noteOwnerSwing(ctx, t0 + 800);
        tickOwnerWork(ctx, t0 + 1500);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.deferring);
        tickOwnerWork(ctx, t0 + 800 + 1000);
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.cooldown);
    });

    it('does nothing when owner_work is disabled', () => {
        const ctx = makeCtx({
            config: { owner_work: { enabled: false } }
        });
        noteOwnerSwing(ctx, Date.now());
        assert.equal(ctx.ownerWork.phase, OWNER_WORK_PHASES.idle);
    });
});
