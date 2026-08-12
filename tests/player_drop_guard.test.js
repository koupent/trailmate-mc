import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    PLAYER_DROP_PROTECTION_MS,
    PlayerDropGuard
} from '../src/companion/PlayerDropGuard.js';

function makeFixture() {
    let now = 1000;
    const player = { id: 7, type: 'player' };
    const bot = Object.assign(new EventEmitter(), {
        entity: { id: 1, type: 'player' }
    });
    const guard = new PlayerDropGuard(bot, {
        now: () => now
    });
    guard.attach();
    return {
        bot,
        guard,
        player,
        setNow(value) {
            now = value;
        }
    };
}

function blockAt(x = 2, y = 64, z = 3) {
    return { name: 'stone', position: new Vec3(x, y, z) };
}

function itemAt(id, x = 2.5, y = 64.5, z = 3.5) {
    return { id, name: 'item', position: new Vec3(x, y, z) };
}

describe('PlayerDropGuard', () => {
    it('protects a player-mined drop for exactly two seconds after it spawns', () => {
        const fixture = makeFixture();
        const item = itemAt(20);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, fixture.player);
        fixture.bot.emit('entitySpawn', item);

        assert.equal(fixture.guard.isProtected(item), true);
        fixture.setNow(1000 + PLAYER_DROP_PROTECTION_MS - 1);
        assert.equal(fixture.guard.isProtected(item), true);
        fixture.setNow(1000 + PLAYER_DROP_PROTECTION_MS);
        assert.equal(fixture.guard.isProtected(item), false);
    });

    it('protects every item entity spawned by the same recent player break', () => {
        const fixture = makeFixture();
        const first = itemAt(20);
        const second = itemAt(21, 2.7, 64.3, 3.4);

        fixture.bot.emit('blockBreakProgressEnd', blockAt(), fixture.player);
        fixture.bot.emit('entitySpawn', first);
        fixture.bot.emit('entitySpawn', second);

        assert.equal(fixture.guard.isProtected(first), true);
        assert.equal(fixture.guard.isProtected(second), true);
    });

    it('protects a drop mined by another player', () => {
        const fixture = makeFixture();
        const item = itemAt(20);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, { id: 42, type: 'player' });
        fixture.bot.emit('entitySpawn', item);

        assert.equal(fixture.guard.isProtected(item), true);
    });

    it('does not protect a drop produced by the companion itself', () => {
        const fixture = makeFixture();
        const item = itemAt(20);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, fixture.bot.entity);
        fixture.bot.emit('entitySpawn', item);

        assert.equal(fixture.guard.isProtected(item), false);
    });

    it('does not protect an unrelated drop away from the player-mined block', () => {
        const fixture = makeFixture();
        const unrelated = itemAt(20, 8, 64.5, 8);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, fixture.player);
        fixture.bot.emit('entitySpawn', unrelated);

        assert.equal(fixture.guard.isProtected(unrelated), false);
    });

    it('does not associate drops with stale player mining activity', () => {
        const fixture = makeFixture();
        const item = itemAt(20);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, fixture.player);
        fixture.setNow(2501);
        fixture.bot.emit('entitySpawn', item);

        assert.equal(fixture.guard.isProtected(item), false);
    });

    it('forgets protected entities when they leave the world', () => {
        const fixture = makeFixture();
        const item = itemAt(20);

        fixture.bot.emit('blockBreakProgressObserved', blockAt(), 8, fixture.player);
        fixture.bot.emit('entitySpawn', item);
        fixture.bot.emit('entityGone', item);

        assert.equal(fixture.guard.isProtected(item), false);
    });
});
