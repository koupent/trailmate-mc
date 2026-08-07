import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    attachOwnerWorkTracker,
    getHeldItemName,
    isOwnerWorkDeferring,
    isWorkItemName,
    OWNER_WORK_PHASES,
    seedPlayerWorkPhase,
    tickOwnerWork
} from '../src/companion/ownerWorkTracker.js';

function makePlayer(id, heldItem = null) {
    return {
        id,
        type: 'player',
        position: { x: 0, y: 64, z: 0 },
        yaw: 0,
        heldItem,
        equipment: [heldItem]
    };
}

function setHeldItem(player, item) {
    player.heldItem = item;
    player.equipment[0] = item;
}

function makeCtx(overrides = {}) {
    const owner = makePlayer(7);
    const bot = Object.assign(new EventEmitter(), {
        entity: { id: 1, type: 'player', position: { x: 0, y: 64, z: 3 } },
        entities: { 7: owner },
        players: { Steve: { entity: owner } }
    });
    return {
        ownerEntity: owner,
        bot,
        config: {
            owner_work: {
                enabled: true,
                all_players: true,
                fov_degrees: 100
            }
        },
        playerWorkById: new Map(),
        ...overrides
    };
}

describe('ownerWorkTracker', () => {
    it('classifies weapons and work tools', () => {
        for (const name of [
            'diamond_sword',
            'netherite_axe',
            'iron_pickaxe',
            'stone_shovel',
            'wooden_hoe',
            'bow',
            'crossbow',
            'trident',
            'mace',
            'shears'
        ]) {
            assert.equal(isWorkItemName(name), true, name);
        }
    });

    it('does not classify ordinary held items as work equipment', () => {
        for (const name of ['air', 'bread', 'torch', 'cobblestone', 'shield']) {
            assert.equal(isWorkItemName(name), false, name);
        }
    });

    it('reads held equipment from Mineflayer equipment slot zero', () => {
        assert.equal(getHeldItemName({ equipment: [{ name: 'diamond_pickaxe' }] }), 'diamond_pickaxe');
    });

    it('activates before any swing when the owner is holding a weapon', () => {
        const ctx = makeCtx();
        setHeldItem(ctx.ownerEntity, { name: 'bow' });

        tickOwnerWork(ctx);

        assert.equal(ctx.playerWorkById.has(7), true);
        assert.equal(isOwnerWorkDeferring(ctx), true);
    });

    it('tracks held work equipment from non-owner players by default', () => {
        const ctx = makeCtx();
        const other = makePlayer(42, { name: 'iron_pickaxe' });
        ctx.bot.players.Other = { entity: other };
        ctx.bot.entities[42] = other;

        tickOwnerWork(ctx);

        assert.equal(ctx.playerWorkById.has(42), true);
    });

    it('can retain owner-only behavior when all_players is disabled', () => {
        const ctx = makeCtx({
            config: { owner_work: { enabled: true, all_players: false, fov_degrees: 100 } }
        });
        const other = makePlayer(42, { name: 'iron_pickaxe' });
        ctx.bot.players.Other = { entity: other };

        tickOwnerWork(ctx);

        assert.equal(ctx.playerWorkById.has(42), false);
    });

    it('deactivates immediately after switching away from a work item', () => {
        const ctx = makeCtx();
        setHeldItem(ctx.ownerEntity, { name: 'diamond_sword' });
        tickOwnerWork(ctx);
        assert.equal(isOwnerWorkDeferring(ctx), true);

        setHeldItem(ctx.ownerEntity, { name: 'bread' });
        tickOwnerWork(ctx);

        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('reacts immediately to remote-player equipment events', () => {
        const ctx = makeCtx();
        const other = makePlayer(42, { name: 'crossbow' });
        ctx.bot.players.Other = { entity: other };
        const dispose = attachOwnerWorkTracker(ctx);

        ctx.bot.emit('entityEquip', other);
        assert.equal(ctx.playerWorkById.has(42), true);

        setHeldItem(other, null);
        ctx.bot.emit('entityEquip', other);
        dispose();
        assert.equal(ctx.playerWorkById.has(42), false);
    });

    it('removes equipment state when a player unloads', () => {
        const ctx = makeCtx();
        setHeldItem(ctx.ownerEntity, { name: 'iron_shovel' });
        tickOwnerWork(ctx);
        ctx.bot.players = {};

        tickOwnerWork(ctx);

        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('clears state when owner_work is disabled', () => {
        const ctx = makeCtx();
        setHeldItem(ctx.ownerEntity, { name: 'iron_axe' });
        tickOwnerWork(ctx);
        ctx.config.owner_work.enabled = false;

        tickOwnerWork(ctx);

        assert.equal(isOwnerWorkDeferring(ctx), false);
    });

    it('seedPlayerWorkPhase supports movement and recovery fixtures', () => {
        const ctx = makeCtx();
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.deferring);
        tickOwnerWork(ctx);
        assert.equal(isOwnerWorkDeferring(ctx), true);
        seedPlayerWorkPhase(ctx, 7, OWNER_WORK_PHASES.idle);
        assert.equal(isOwnerWorkDeferring(ctx), false);
    });
});
