import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Reflexes } from '../src/reflexes/Reflexes.ts';
import { computeThreatArc } from '../src/combat/threatArc.ts';
import { currentControlOwner } from '../src/companion/ControlPriority.js';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import { DeathReturnInterrupt } from '../src/companion/interrupts/DeathReturnInterrupt.js';
import { OwnGraveInterrupt } from '../src/companion/interrupts/OwnGraveInterrupt.js';
import { NearbyLootInterrupt } from '../src/companion/interrupts/NearbyLootInterrupt.js';
import { AutoEquip } from '../src/companion/utils/AutoEquip.js';
import { shouldTransferNow } from '../src/companion/utils/PeriodicItemTransfer.js';
import {
    beginDeathReturnAfterSpawn,
    captureDeathState,
    createDeathRecoveryState,
    requestRecoveryItemCollection
} from '../src/companion/deathRecovery.js';
import { scanCompanionAwareness } from '../src/world/companionAwareness.js';

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

/**
 * 決定論的な最小3Dワールド。戦術移動、上位所有権、墓復旧、ItemCollectionが
 * 利用するMineflayer境界だけをモデル化する。
 */
class VirtualWorld {
    constructor() {
        this.nextId = 10;
        this.controls = {};
        this.destinations = [];
        this.looks = [];
        this.followCalls = 0;
        this.directAttacks = 0;
        this.pvpStarts = 0;
        this.tossed = 0;
        this.autoAdvanceGoals = false;
        this.grave = null;
        this.equippedArmor = [];
        this.inventorySlots = [];

        const bot = new EventEmitter();
        bot.username = 'TrailMate';
        bot.entity = this.entity('TrailMate', 'player', 0, 64, 0);
        bot.entity.yaw = 0;
        bot.entities = {};
        bot.players = {};
        bot.health = 20;
        bot.game = { dimension: 'minecraft:overworld', gameMode: 'survival' };
        bot.time = { timeOfDay: 1000 };
        bot.interrupt_code = false;
        bot.world = { raycast: () => null };
        bot.blockAt = (position) => this.blockAt(position);
        bot.nearestEntity = (predicate) => Object.values(bot.entities).find(predicate) || null;
        bot.setControlState = (name, value) => { this.controls[name] = value; };
        bot.getControlState = (name) => Boolean(this.controls[name]);
        bot.clearControlStates = () => { this.controls = {}; };
        bot.lookAt = async (position) => { this.looks.push(position.clone?.() || { ...position }); };
        bot.look = async () => {};
        bot.attack = () => { this.directAttacks += 1; };
        bot.activateItem = () => { this.controls.guard = true; };
        bot.deactivateItem = () => { this.controls.guard = false; };
        bot.supportFeature = () => false;
        bot.getEquipmentDestSlot = (slot) => slot === 'off-hand' ? 45 : 0;
        bot.inventory = {
            slots: this.inventorySlots,
            items: () => this.inventorySlots.filter(Boolean)
        };
        bot.equip = async (item, destination) => {
            if (destination === 'hand') bot.heldItem = item;
            if (destination === 'off-hand') this.inventorySlots[45] = item;
        };
        bot.armorManager = {
            equipAll: async () => {
                this.equippedArmor = this.inventorySlots
                    .filter((item) => item && /helmet|chestplate|leggings|boots/.test(item.name));
            }
        };
        bot.tossStack = async (item) => {
            const index = this.inventorySlots.indexOf(item);
            if (index >= 0) this.inventorySlots[index] = null;
            this.tossed += 1;
        };
        bot.dig = async () => this.breakGrave();
        bot.pvp = {
            target: null,
            followRange: 2,
            movements: null,
            attack: async (enemy) => {
                bot.pvp.target = enemy;
                this.pvpStarts += 1;
            },
            stop: async () => { bot.pvp.target = null; },
            forceStop: () => { bot.pvp.target = null; },
            hasShield: () => Boolean(this.inventorySlots[45]?.name === 'shield')
        };
        this.bot = bot;

        const movement = {
            isHeld: false,
            isBlocked: false,
            status: 'idle',
            hasGoal: false,
            tickHoldWatchdog() {},
            stop: () => {
                movement.hasGoal = false;
                this.pendingDestination = null;
            },
            goToward: (position) => {
                const target = new Vec3(position.x, position.y, position.z);
                this.destinations.push(target);
                movement.hasGoal = true;
                this.pendingDestination = target;
                if (this.autoAdvanceGoals) this.moveTo(target);
                return true;
            },
            climbTo: (position) => movement.goToward(position),
            followEntity: (entity) => {
                this.followCalls += 1;
                void bot.lookAt(entity.position);
                return movement.goToward(entity.position);
            },
            setSprintAllowed() {}
        };
        this.movement = movement;

        this.agent = { bot, openChat: async () => {}, language: 'ja' };
        this.reflexes = new Reflexes(bot, REFLEX_CONFIG, 7);
        this.agent.reflexes = this.reflexes;
        this.autoEquip = new AutoEquip(this.agent);
        this.config = {
            follow_distance: 3,
            owner_near_radius: 12,
            reflexes: REFLEX_CONFIG,
            death_return: {
                enabled: true,
                arrive_range: 2,
                timeout_ms: 5000,
                grave_wait_ms: 0
            },
            own_grave: { enabled: true, scan_radius: 10, dig_range: 3.5 },
            nearby_loot: {
                enabled: true,
                radius: 8,
                recovery_radius: 12,
                recovery_capture_ms: 30,
                recovery_deadline_ms: 2000,
                recovery_quiet_ms: 20,
                max_ms: 1200,
                quiet_ms: 0,
                grace_ms: 0,
                owner_clearance: 8,
                give_suppress_ms: 0
            }
        };
        this.ctx = {
            agent: this.agent,
            bot,
            config: this.config,
            movement,
            stuck: { reset() {}, seconds: 0, update() {} },
            worldState: { visiblePlayers: [] },
            ownerName: null,
            deathRecovery: createDeathRecoveryState(),
            graveLoot: { active: false, targetKey: null },
            nearbyLoot: { active: false, suppressUntil: 0 },
            itemTransfer: { active: false },
            holdReflexes: false
        };
        this.ctx.getCompanionAwareness = () => scanCompanionAwareness(
            this.bot,
            this.config.awareness_radius ?? 10,
            this.bot.entity.position
        );
        this.ctx.invalidateCompanionAwareness = () => {};
        Object.defineProperty(this.ctx, 'ownerEntity', {
            get: () => this.ctx.ownerName ? this.bot.players[this.ctx.ownerName]?.entity || null : null
        });
        this.agent.companion = { ctx: this.ctx, autoEquip: this.autoEquip };
        this.deathReturn = new DeathReturnInterrupt();
        this.ownGrave = new OwnGraveInterrupt();
        this.itemCollection = new NearbyLootInterrupt();
    }

    entity(name, type, x, y, z) {
        return {
            id: this.nextId++,
            name,
            username: name,
            type,
            height: 1.8,
            position: new Vec3(x, y, z),
            isValid: true
        };
    }

    setOwner(x, y = 64, z = 0) {
        const owner = this.entity('Owner', 'player', x, y, z);
        owner.yaw = 0;
        this.bot.players.Owner = { entity: owner };
        this.bot.entities[owner.id] = owner;
        this.ctx.ownerName = 'Owner';
        this.ctx.worldState.visiblePlayers = [{ name: 'Owner', entity: owner }];
        return owner;
    }

    addEnemy(name, x, y = 64, z = 0) {
        const enemy = this.entity(name, 'hostile', x, y, z);
        this.bot.entities[enemy.id] = enemy;
        return enemy;
    }

    addInventory(name, count = 1) {
        const slot = this.inventorySlots.findIndex((item) => item == null);
        const index = slot >= 0 ? slot : this.inventorySlots.length;
        const item = {
            slot: index,
            type: 1000 + index,
            name,
            count,
            attackDamage: name.includes('sword') ? 7 : 0
        };
        this.inventorySlots[index] = item;
        return item;
    }

    addGroundItem(name, x, y = 64, z = 0) {
        const item = this.entity('item', 'object', x, y, z);
        item.stackName = name;
        this.bot.entities[item.id] = item;
        return item;
    }

    setGrave(x, y = 64, z = 0) {
        const label = this.entity('text_display', 'object', x, y + 1, z);
        label.username = "TrailMate's Grave";
        this.bot.entities[label.id] = label;
        this.grave = { alive: true, position: new Vec3(x, y, z), labelId: label.id };
    }

    blockAt(position) {
        if (
            this.grave?.alive
            && Math.floor(position.x) === Math.floor(this.grave.position.x)
            && Math.floor(position.y) === Math.floor(this.grave.position.y)
            && Math.floor(position.z) === Math.floor(this.grave.position.z)
        ) {
            return { name: 'player_head', position: this.grave.position.clone() };
        }
        return { name: 'air', position: new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)) };
    }

    breakGrave() {
        if (!this.grave?.alive) return;
        const pos = this.grave.position;
        this.grave.alive = false;
        delete this.bot.entities[this.grave.labelId];
        this.addGroundItem('iron_sword', pos.x + 2, pos.y, pos.z);
        this.addGroundItem('iron_boots', pos.x - 2, pos.y, pos.z);
    }

    moveTo(position) {
        this.bot.entity.position = new Vec3(position.x, position.y, position.z);
        for (const entity of Object.values(this.bot.entities)) {
            if (entity.name !== 'item') continue;
            if (this.bot.entity.position.distanceTo(entity.position) > 1) continue;
            this.addInventory(entity.stackName || 'unknown_item');
            delete this.bot.entities[entity.id];
        }
    }

    advanceControls(distance = 1) {
        const yaw = this.bot.entity.yaw || 0;
        let dx = 0;
        let dz = 0;
        if (this.controls.forward) { dx -= Math.sin(yaw); dz -= Math.cos(yaw); }
        if (this.controls.back) { dx += Math.sin(yaw); dz += Math.cos(yaw); }
        if (this.controls.right) { dx += Math.cos(yaw); dz -= Math.sin(yaw); }
        if (this.controls.left) { dx -= Math.cos(yaw); dz += Math.sin(yaw); }
        const norm = Math.hypot(dx, dz) || 1;
        this.moveTo(this.bot.entity.position.offset(dx / norm * distance, 0, dz / norm * distance));
    }

    advanceDestination(distance = 0.55) {
        if (!this.pendingDestination) return;
        const delta = this.pendingDestination.minus(this.bot.entity.position);
        const remaining = delta.norm();
        if (remaining <= distance) {
            this.moveTo(this.pendingDestination);
            return;
        }
        this.moveTo(this.bot.entity.position.offset(
            (this.pendingDestination.x - this.bot.entity.position.x) / remaining * distance,
            0,
            (this.pendingDestination.z - this.bot.entity.position.z) / remaining * distance
        ));
    }

    async combatTick() {
        await this.reflexes.tick({
            movementHeld: false,
            isIdleish: true,
            owner: this.ctx.ownerEntity,
            movement: this.movement,
            recovery: this.ctx.deathRecovery
        });
    }

    async companionTick() {
        await this.combatTick();
        if (this.ownGrave.shouldRun(this.ctx)) return this.ownGrave.run(this.ctx);
        if (this.itemCollection.shouldRun(this.ctx)) return this.itemCollection.run(this.ctx);
        if (this.deathReturn.shouldRun(this.ctx)) return this.deathReturn.run(this.ctx);
        return new FollowMode().tick(this.ctx);
    }

    dodgePhase() {
        const latch = this.reflexes.rangedDodgeLatch;
        const now = Date.now();
        if (now < latch.burstUntil) return 'dodge';
        if (now < latch.advanceUntil) return 'advance';
        return 'idle';
    }
}

describe('決定論的な仮想3D相棒シナリオ', () => {
    it('単体遠距離脅威: 回避→前進→攻撃', async () => {
        const world = new VirtualWorld();
        world.setOwner(0);
        const skeleton = world.addEnemy('skeleton', 6);

        await world.combatTick();
        assert.equal(currentControlOwner(world.ctx), 'combat');
        assert.equal(world.dodgePhase(), 'dodge');
        assert.ok(world.controls.forward || world.controls.back);

        world.reflexes.rangedDodgeLatch.burstUntil = Date.now() - 1;
        world.reflexes.rangedDodgeLatch.advanceUntil = Date.now() + 1500;
        world.reflexes.rangedDodgeLatch.lastProgressAt = Date.now();
        await world.combatTick();
        assert.equal(world.dodgePhase(), 'advance');
        assert.equal(world.controls.right, true);

        world.advanceControls(2.7);
        await world.combatTick();
        assert.ok(world.bot.entity.position.distanceTo(skeleton.position) <= 3.5);
        assert.ok(world.directAttacks >= 1);
        assert.equal(world.reflexes.rangedDodgeLatch.advanceUntil, 0);
    });

    it('複数脅威: 敵列の外側へ移動し35度未満へ収束する', async () => {
        const world = new VirtualWorld();
        const owner = world.setOwner(-5);
        const front = world.addEnemy('zombie', 0, 64, 4);
        const back = world.addEnemy('zombie', 0, 64, -4);
        const before = computeThreatArc(world.bot.entity.position, [front.position, back.position]);
        let reached = false;

        for (let tick = 0; tick < 30; tick += 1) {
            world.reflexes.arcRepositionUntil = 0;
            await world.combatTick();
            assert.equal(currentControlOwner(world.ctx), 'combat');
            assert.ok(world.pendingDestination);
            world.advanceDestination();

            const minEnemyDistance = Math.min(
                world.bot.entity.position.distanceTo(front.position),
                world.bot.entity.position.distanceTo(back.position)
            );
            const ownerDistance = world.bot.entity.position.distanceTo(owner.position);
            const current = computeThreatArc(world.bot.entity.position, [front.position, back.position]);
            assert.ok(minEnemyDistance >= 1.8 - 1e-6);
            assert.ok(ownerDistance <= 8 + 1e-6);
            if (current && current.spanRad <= (35 * Math.PI) / 180
                && Math.abs(world.bot.entity.position.z) > 4) {
                reached = true;
                break;
            }
        }

        const after = computeThreatArc(world.bot.entity.position, [front.position, back.position]);
        assert.ok(before && after && after.spanRad < before.spanRad);
        assert.ok(reached);
    });

    it('戦闘所有権がFollowと受け渡しの移動・視線を抑制する', async () => {
        const world = new VirtualWorld();
        world.setOwner(6);
        world.addEnemy('skeleton', 5);
        world.addInventory('dirt', 64);
        await world.combatTick();
        const lookCount = world.looks.length;
        const destinationCount = world.destinations.length;

        await new FollowMode().tick(world.ctx);
        const canTransfer = shouldTransferNow(world.ctx, {
            now: 1000,
            lastRunAt: 0,
            intervalMs: 1,
            enabled: true
        });
        assert.equal(canTransfer, false);
        assert.equal(world.followCalls, 0);
        assert.equal(world.looks.length, lookCount);
        assert.equal(world.destinations.length, destinationCount);
    });

    it('死亡→墓→共通ItemCollection→装備→戦闘と遷移する', async () => {
        const world = new VirtualWorld();
        world.setOwner(15);
        world.bot.entity.position = new Vec3(15, 64, 0);
        world.setGrave(15);
        const unrelated = world.addGroundItem('dirt', 20, 64, 0);
        captureDeathState(world.ctx);
        world.bot.entity.position = new Vec3(0, 64, 0);
        beginDeathReturnAfterSpawn(world.ctx);
        const enemy = world.addEnemy('zombie', 21);
        world.autoAdvanceGoals = true;

        await world.companionTick();
        assert.equal(world.ctx.deathRecovery.phase, 'travel');
        assert.equal(world.bot.entity.position.x, 15);
        await world.companionTick();
        assert.ok(
            world.ctx.deathRecovery.phase === 'grave' || world.ctx.deathRecovery.phase === 'items',
            `expected grave or items after arrival, got ${world.ctx.deathRecovery.phase}`
        );
        if (world.ctx.deathRecovery.phase === 'grave') {
            await world.companionTick();
        }
        assert.equal(world.grave.alive, false);
        assert.equal(world.ctx.deathRecovery.phase, 'items');
        assert.equal(world.ctx.deathRecovery.collectionSource, 'grave');
        delete world.bot.entities[enemy.id];
        for (let i = 0; i < 30 && world.ctx.deathRecovery.active; i += 1) {
            await world.companionTick();
        }

        assert.equal(world.ctx.deathRecovery.active, false);
        assert.ok(world.inventorySlots.some((item) => item?.name === 'iron_sword'));
        assert.ok(world.inventorySlots.some((item) => item?.name === 'iron_boots'));
        assert.equal(world.bot.heldItem?.name, 'iron_sword');
        assert.ok(world.equippedArmor.some((item) => item.name === 'iron_boots'));
        assert.ok(world.bot.entities[unrelated.id], 'unrelated pre-break drop must not block Recovery');
        enemy.position = world.bot.entity.position.offset(3, 0, 0);
        world.bot.entities[enemy.id] = enemy;
        await world.combatTick();
        assert.equal(world.bot.pvp.target?.id, enemy.id);
        assert.ok(world.directAttacks >= 1, 'Combat must attack on the tick after Recovery completes');
    });

    it('緊急中断を繰り返しても回収の絶対期限を延長しない', async () => {
        const world = new VirtualWorld();
        world.setOwner(0);
        world.addInventory('iron_sword');
        await world.autoEquip.equipBest();
        world.config.nearby_loot.recovery_capture_ms = 30;
        world.config.nearby_loot.recovery_deadline_ms = 950;
        world.config.nearby_loot.recovery_quiet_ms = 10;
        world.ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            active: true,
            startedAt: Date.now(),
            deathPos: { x: 0, y: 64, z: 0 }
        };
        requestRecoveryItemCollection(
            world.ctx,
            world.bot.entity.position,
            Date.now(),
            'grave',
            { preexistingItemIds: [] }
        );
        const deadline = world.ctx.deathRecovery.collectionDeadlineAt;
        const unreachable = world.addGroundItem('iron_boots', 0.1, 64, 0);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const emergency = setTimeout(() => {
                world.ctx.deathRecovery.emergencyUntil = Date.now() + 400;
            }, 20);
            await world.itemCollection.run(world.ctx);
            clearTimeout(emergency);
            assert.equal(world.ctx.deathRecovery.active, true);
            assert.equal(world.ctx.deathRecovery.collectionDeadlineAt, deadline);
            assert.ok(world.ctx.deathRecovery.ownedItemIds.includes(unreachable.id));
            world.ctx.deathRecovery.emergencyUntil = 0;
        }

        await world.itemCollection.run(world.ctx);
        assert.equal(world.ctx.deathRecovery.active, false, 'deadline must finish unreachable recovery');
        assert.ok(Date.now() >= deadline);
        assert.equal(world.bot.heldItem?.name, 'iron_sword');

        const enemy = world.addEnemy('zombie', 3);
        await world.combatTick();
        assert.equal(world.bot.pvp.target?.id, enemy.id);
        assert.ok(world.directAttacks >= 1);
    });

    it('上限付き危険割り込み後にRecovery目的地へ戻る', async () => {
        const world = new VirtualWorld();
        world.setOwner(0);
        world.bot.entity.position = new Vec3(12, 64, 0);
        world.setGrave(12);
        captureDeathState(world.ctx);
        world.bot.entity.position = new Vec3(0, 64, 0);
        beginDeathReturnAfterSpawn(world.ctx);
        const skeleton = world.addEnemy('skeleton', 2);

        await world.companionTick();
        assert.equal(currentControlOwner(world.ctx), 'survival');
        assert.equal(world.destinations.length, 0);
        assert.equal(world.directAttacks, 0);

        world.ctx.deathRecovery.emergencyUntil = Date.now() - 1;
        skeleton.position = new Vec3(6, 64, 0);
        await world.companionTick();
        assert.equal(currentControlOwner(world.ctx), 'recovery');
        assert.equal(world.destinations.at(-1).x, 12);
        assert.equal(world.ctx.deathRecovery.phase, 'travel');
    });

    it('戦闘安定時間後にFollowと受け渡しを安全に再開する', async () => {
        const world = new VirtualWorld();
        world.setOwner(6);
        const zombie = world.addEnemy('zombie', 3);
        world.addInventory('dirt', 64);
        await world.combatTick();
        delete world.bot.entities[zombie.id];
        await world.combatTick();
        await new FollowMode().tick(world.ctx);
        assert.equal(world.followCalls, 0);
        assert.equal(shouldTransferNow(world.ctx, {
            now: 1000, lastRunAt: 0, intervalMs: 1, enabled: true
        }), false);

        world.reflexes.combatControlUntil = Date.now() - 1;
        world.reflexes.lastTargetSeenAt = Date.now() - 5000;
        world.bot.pvp.target = null;
        await world.combatTick();
        await Promise.resolve();
        world.reflexes.combatControlUntil = Date.now() - 1;
        await new FollowMode().tick(world.ctx);
        assert.equal(currentControlOwner(world.ctx), 'follow');
        assert.equal(world.followCalls, 1);
        assert.equal(shouldTransferNow(world.ctx, {
            now: 1000, lastRunAt: 0, intervalMs: 1, enabled: true
        }), true);
    });
});
