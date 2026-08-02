import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    computeTrailAnchor,
    isBotBehindOwner,
    measureCorridorWidth,
    resolveFollowPhase
} from '../src/companion/movement/followPhase.js';

function solidBlock() {
    return { name: 'stone', boundingBox: 'block' };
}

function airBlock() {
    return { name: 'air', boundingBox: 'empty' };
}

function makeBot(blockAt) {
    return {
        blockAt,
        entity: { position: { x: 0, y: 64, z: 0 }, height: 1.8 },
        world: { raycast: () => null }
    };
}

function makeCtx(bot, owner, overrides = {}) {
    return {
        bot,
        ownerEntity: owner,
        config: {
            follow_distance: 3,
            follow_min_distance: 2
        },
        doors: {
            findSeparatingPassage: () => false,
            ...overrides.doors
        },
        ...overrides
    };
}

describe('followPhase', () => {
    it('returns trail in a 2-wide corridor when the bot is behind the owner', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const bot = makeBot(({ x }) => {
            if (x === -1 || x === 1) return solidBlock();
            return airBlock();
        });
        bot.entity.position = { x: 0, y: 64, z: 3 };

        assert.equal(measureCorridorWidth(bot, owner.position, bot.entity.position), 1);
        assert.equal(isBotBehindOwner(owner, bot.entity.position), true);
        assert.equal(resolveFollowPhase(makeCtx(bot, owner), owner), 'trail');
    });

    it('returns merge in a wide corridor', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const bot = makeBot(() => airBlock());
        bot.entity.position = { x: 0, y: 64, z: -6 };

        assert.equal(measureCorridorWidth(bot, owner.position, bot.entity.position), 3);
        assert.equal(resolveFollowPhase(makeCtx(bot, owner), owner), 'merge');
    });

    it('returns near when close with line of sight and no separating door', () => {
        const owner = {
            id: 7,
            position: new Vec3(0, 64, 0),
            yaw: 0,
            height: 1.8
        };
        const bot = makeBot(() => airBlock());
        bot.entity.position = new Vec3(0, 64, -1.5);
        bot.players = { Steve: { entity: owner } };

        assert.equal(resolveFollowPhase(makeCtx(bot, owner), owner), 'near');
    });

    it('continues following when a door separates bot and owner', () => {
        const owner = {
            id: 7,
            position: new Vec3(0, 64, 0),
            yaw: 0,
            height: 1.8
        };
        const bot = makeBot(() => airBlock());
        bot.entity.position = new Vec3(0, 64, -1.5);
        bot.players = { Steve: { entity: owner } };

        const ctx = makeCtx(bot, owner, {
            doors: { findSeparatingPassage: () => true }
        });
        assert.notEqual(resolveFollowPhase(ctx, owner), 'near');
    });

    it('measureCorridorWidth works with mineflayer-style blockAt that requires Vec3', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const bot = makeBot(({ x }) => {
            if (x === -1 || x === 1) return solidBlock();
            return airBlock();
        });
        bot.entity.position = { x: 0, y: 64, z: 3 };
        bot.blockAt = (pos) => {
            assert.ok(typeof pos.floored === 'function', 'blockAt must receive Vec3');
            return bot.blockAtImpl?.(pos) ?? airBlock();
        };
        bot.blockAtImpl = ({ x }) => {
            if (x === -1 || x === 1) return solidBlock();
            return airBlock();
        };

        assert.equal(measureCorridorWidth(bot, owner.position, bot.entity.position), 1);
    });

    it('computes a trail anchor behind the owner', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const anchor = computeTrailAnchor(owner, 2);
        assert.ok(anchor.z > owner.position.z);
    });
});
