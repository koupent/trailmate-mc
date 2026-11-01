/**
 * 死亡地点へ歩き始めたあと、追従モードへ奪われる遷移の再現。
 * 近接した敵の緊急回避で death_return の shouldRun が一度 false になると、
 * 状態機械は death_recovery を抜けて平常（追従）になり、墓への経路が消える。
 */

import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Reflexes } from '../src/reflexes/Reflexes.ts';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';
import { DeathReturnInterrupt } from '../src/companion/interrupts/DeathReturnInterrupt.js';
import { OwnGraveInterrupt } from '../src/companion/interrupts/OwnGraveInterrupt.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { RecoveryInterrupt } from '../src/companion/interrupts/RecoveryInterrupt.js';
import {
    beginDeathReturnAfterSpawn,
    captureDeathState,
    completeDeathRecovery,
    createDeathRecoveryState
} from '../src/companion/deathRecovery.js';

const REFLEX_CONFIG = {
    self_defense: true,
    self_preservation: false,
    torch_placing: false,
    hostile_range: 12,
    combat_lost_grace_ms: 1500,
    retreat_health: 8,
    resume_health: 14,
    retreat_distance: 6,
    combat_learning: {
        enabled: false,
        explore_rate: 0,
        min_trials: 3,
        min_health_to_explore: 12,
        explore_damage_abort: 8,
        state_path: 'data/combat-state.virtual.json'
    }
};

function makeWorld() {
    const bot = new EventEmitter();
    bot.username = 'TrailMate';
    bot.entity = {
        id: 1,
        name: 'TrailMate',
        type: 'player',
        position: new Vec3(30, 64, 0),
        yaw: 0,
        height: 1.8
    };
    bot.entities = {};
    bot.players = {};
    bot.health = 20;
    bot.food = 20;
    bot.oxygenLevel = 20;
    bot.game = { dimension: 'minecraft:overworld', gameMode: 'survival' };
    bot.time = { timeOfDay: 1000 };
    bot.world = { raycast: () => null };
    bot.inventory = { slots: [], items: () => [] };
    bot.heldItem = null;
    bot.blockAt = (pos) => ({
        name: 'air',
        position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
    });
    bot.setControlState = () => {};
    bot.getControlState = () => false;
    bot.clearControlStates = () => {};
    bot.lookAt = async () => {};
    bot.look = async () => {};
    bot.attack = () => {};
    bot.nearestEntity = (predicate) => Object.values(bot.entities).find(predicate) || null;
    bot.pvp = { target: null, stop() {}, forceStop() {}, attack: async () => {} };
    bot.supportFeature = () => false;

    const destinations = [];
    const follows = [];
    const movement = {
        isHeld: false,
        isBlocked: false,
        status: 'idle',
        hasGoal: false,
        tickHoldWatchdog() {},
        stop() {
            this.hasGoal = false;
            destinations.push('stop');
        },
        goToward(position) {
            destinations.push(`go:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`);
            this.hasGoal = true;
            return true;
        },
        followEntity(entity) {
            follows.push(Math.floor(entity.position.x));
            return this.goToward(entity.position);
        },
        setSprintAllowed() {}
    };

    const agent = { bot, openChat: async () => {}, language: 'ja', reflexes: null };
    const reflexes = new Reflexes(bot, REFLEX_CONFIG, 7);
    agent.reflexes = reflexes;

    const ctx = {
        agent,
        bot,
        config: {
            follow_distance: 3,
            follow_min_distance: 2,
            owner_near_radius: 12,
            scan_radius: 48,
            fov_degrees: 120,
            awareness_radius: 12,
            stuck_detect_seconds: 1.5,
            owner_work: { enabled: false },
            reflexes: REFLEX_CONFIG,
            death_return: { enabled: true, arrive_range: 3, timeout_ms: 90000, grave_wait_ms: 2500 },
            own_grave: { enabled: true, scan_radius: 10, interact_range: 3.5 },
            nearby_loot: { enabled: true, radius: 12, recovery_radius: 12 }
        },
        movement,
        stuck: { reset() {}, seconds: 0, update() {} },
        worldState: { visiblePlayers: [], update() {} },
        ownerName: 'Owner',
        deathRecovery: createDeathRecoveryState(),
        graveLoot: { active: false, targetKey: null },
        nearbyLoot: { active: false, suppressUntil: 0 },
        itemTransfer: { active: false },
        holdReflexes: false,
        playerWorkById: new Map(),
        invalidateCompanionAwareness() {},
        getCompanionAwareness() {
            return { displayEntities: [], drops: [], origin: bot.entity.position };
        }
    };
    Object.defineProperty(ctx, 'ownerEntity', {
        get: () => bot.players.Owner?.entity || null
    });

    const owner = {
        id: 2,
        name: 'Owner',
        username: 'Owner',
        type: 'player',
        position: new Vec3(12, 64, 0),
        yaw: 0,
        height: 1.8
    };
    bot.players.Owner = { entity: owner };
    bot.entities[owner.id] = owner;

    const zombie = {
        id: 3,
        name: 'zombie',
        type: 'hostile',
        position: new Vec3(8, 64, 0),
        height: 1.8,
        isValid: true
    };
    bot.entities[zombie.id] = zombie;

    const manager = new CompanionOrchestrator(ctx, agent, [
        new NearbyLootInterrupt(),
        new OwnGraveInterrupt(),
        new DeathReturnInterrupt(),
        new RecoveryInterrupt()
    ], 'follow');
    agent.companion = { manager, ctx };

    return { bot, ctx, manager, movement, destinations, follows, zombie, owner };
}

describe('死亡地点への移動が追従に奪われない', () => {
    it('途中まで死亡地点へ進んだあと、近接した敵で追従に遷移しない', async () => {
        const world = makeWorld();
        captureDeathState(world.ctx);
        world.bot.entity.position = new Vec3(0, 64, 0);
        assert.equal(beginDeathReturnAfterSpawn(world.ctx), true);
        assert.equal(world.ctx.deathRecovery.deathPos.x, 30);

        await world.manager.tick();
        assert.equal(world.manager.getActiveFsmId(), 'death_recovery');
        assert.ok(
            world.destinations.includes('go:30,64,0'),
            `死亡地点へ進む前に別の目的地へ曲がった: ${world.destinations.join(',')}`
        );
        assert.deepEqual(world.follows, [], '復帰開始のtickで追従してはいけない');

        world.zombie.position = new Vec3(1.5, 64, 0);
        await world.manager.tick();
        await world.manager.tick();

        assert.equal(world.ctx.deathRecovery.active, true);
        assert.equal(world.ctx.deathRecovery.phase, 'travel');
        assert.equal(world.ctx.deathRecovery.deathPos?.x, 30);
        assert.equal(
            world.manager.getActiveFsmId(),
            'death_recovery',
            `追従へ奪われた: ${world.manager.transitionHistory.map((entry) => entry.name).join(' -> ')}`
        );
        assert.deepEqual(world.follows, [], '墓へ着く前にオーナーへ向き直した');
        assert.equal(
            world.manager.transitionHistory.some((entry) => entry.to === 'normal' && entry.from === 'death_recovery'),
            false
        );

        world.zombie.position = new Vec3(40, 64, 0);
        world.ctx.deathRecovery.emergencyUntil = 0;
        await world.manager.tick();
        assert.equal(world.manager.getActiveFsmId(), 'death_recovery');
        assert.equal(world.destinations.at(-1), 'go:30,64,0');
        assert.equal(world.ctx.deathRecovery.deathPos.x, 30);
    });

    it('回収が終わったあとは追従に戻る', async () => {
        const world = makeWorld();
        delete world.bot.entities[world.zombie.id];
        captureDeathState(world.ctx);
        world.bot.entity.position = new Vec3(0, 64, 0);
        beginDeathReturnAfterSpawn(world.ctx);
        await world.manager.tick();
        assert.equal(world.manager.getActiveFsmId(), 'death_recovery');

        completeDeathRecovery(world.ctx, 'test-collected');
        await world.manager.tick();
        assert.equal(world.manager.getActiveFsmId(), 'normal');
        await world.manager.tick();

        assert.equal(world.ctx.deathRecovery.active, false);
        assert.equal(world.ctx.deathRecovery.deathPos, null);
        assert.equal(world.manager.getActiveFsmId(), 'normal');
        assert.ok(world.follows.includes(12), '回収後はオーナーへの追従に戻る');
    });
});
