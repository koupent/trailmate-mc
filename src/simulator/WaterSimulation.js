import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';
import physicsLoader from 'prismarine-physics';
import pf from 'mineflayer-pathfinder';
import { CompanionContext } from '../companion/CompanionContext.js';
import { WorldState } from '../companion/WorldState.js';
import { CompanionOrchestrator } from '../companion/stateMachine/CompanionOrchestrator.js';
import { shouldCompanionEat, chooseBestFood, UNSAFE_OR_SPECIAL_FOODS } from '../host/autoEat.js';
import { isPassableLiquid } from '../companion/movement/hazardBlocks.js';
import { EyeContactReaction } from '../companion/eyeContact.js';
import { createMovementPacketLimiter } from '../host/movementPackets.js';
import assert from 'node:assert/strict';

const registry = registryLoader('1.21.6');
const Block = blockLoader(registry);
export const WATER_SCENARIOS = [
    { id: 'shallow-one', name: '1ブロックの浅瀬 → 深場 → 岸', depth: 1 },
    { id: 'shallow-two', name: '2ブロックの浅瀬 → 深場 → 岸', depth: 2 },
    { id: 'deep-dive', name: '深さ30ブロック・移動するオーナー', depth: 30 },
    { id: 'roof-return', name: '水中の天井・離れた空気への帰還', depth: 8 },
    { id: 'low-health', name: '水中で負傷・浮上して食事と回復', depth: 8 },
    { id: 'low-food', name: '水中で空腹・浮上して食事と回復', depth: 8 },
    { id: 'underwater-turns', name: '水中の往復追従・方向転換', depth: 8, behavior: true },
    { id: 'shore-stop', name: 'プレイヤーが岸に上がって停止', depth: 8, behavior: true },
    { id: 'water-idle', name: '追従距離内の水面で浮かんで待機', depth: 8, behavior: true }
];

/** Closed loop: production FSM + pathfinder + prismarine physics at 20 Hz.
 * Server-side air/drowning, hunger and regeneration are clocked independently
 * of the controller. Tests never restore oxygen or teleport the companion.
 */
export class WaterSimulation {
    constructor(id, options = {}) {
        this.scenario = WATER_SCENARIOS.find(item => item.id === id);
        if (!this.scenario) throw new Error(`Unknown water scenario: ${id}`);
        this.options = options;
        this.tick = 0;
        this.air = 300;
        this.minAir = 300;
        this.drowningDamage = 0;
        this.returnCount = 0;
        this.resumedCount = 0;
        this.maxProgress = 0;
        this.trace = [];
        this.foodItems = [{ name: 'cooked_beef', count: options.noFood ? 0 : 32 }];
        this.exhaustion = 0;
        this.blocks = new Map();
        this.cache = new Map();
        this.buildStage();
        if (options.waterPlants) {
            for (const [key, name] of this.blocks) {
                if (name === 'water') this.blocks.set(key, key.endsWith(',0') ? 'seagrass' : 'kelp_plant');
            }
        }
        this.world = { getBlock: position => this.blockAt(position), raycast: () => null };
        const bot = new EventEmitter();
        Object.assign(bot, {
            username: 'TrailMate', version: '1.21.6', registry,
            health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
            jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
            controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }, entities: {}, players: {}, world: this.world,
            game: { minY: -64, dimension: 'minecraft:overworld', gameMode: 'survival' },
            time: { timeOfDay: 1000 }, inventory: { slots: [], items: () => this.foodItems.filter(item => item.count > 0) },
            entity: {
                id: 1, position: new Vec3(-3.5, 10, 0.5), velocity: new Vec3(0, 0, 0),
                yaw: -Math.PI / 2, pitch: 0, height: 1.8, width: 0.6,
                onGround: true, isInWater: false, effects: {}, attributes: {}
            },
            blockAt: position => this.blockAt(position),
            setControlState(key, value) {
                assert.equal(typeof value, 'boolean');
                if (key === 'jump' && value && !this.controlState[key]) this.jumpQueued = true;
                this.controlState[key] = value;
            },
            getControlState(key) { return Boolean(this.controlState[key]); },
            clearControlStates() { for (const key of Object.keys(this.controlState)) this.setControlState(key, false); },
            async look(yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch; },
            async lookAt(position) {
                const delta = position.minus(this.entity.position.offset(0, 1.62, 0));
                await this.look(Math.atan2(-delta.x, -delta.z), Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
            },
            canDigBlock: () => false, canSeeEntity: () => true,
            supportFeature: name => registry.supportFeature(name),
            waitForTicks: async () => {},
            pvp: { forceStop() {} }
        });
        this.bot = bot;
        if (this.scenario.id === 'deep-dive') bot.entity.position.set(2.5, 6, 0.5);
        if (this.scenario.id === 'roof-return') bot.entity.position.set(10.5, 4, 0.5);
        if (id === 'underwater-turns') bot.entity.position.set(8.5, 7, 0.5);
        if (id === 'shore-stop') bot.entity.position.set(17.5, 8.5, 0.3);
        if (id === 'water-idle') bot.entity.position.set(8.05, 8.7, 0.15);
        if (options.initialBotPosition) bot.entity.position.set(...options.initialBotPosition);
        if (options.initialYaw != null) bot.entity.yaw = options.initialYaw;
        this.physics = physicsLoader.Physics(registry, this.world);
        this.serverPosition = bot.entity.position.clone();
        this.movementPackets = createMovementPacketLimiter((name, data) => {
            if (name !== 'look') this.serverPosition.set(data.x, data.y, data.z);
        }, { now: () => this.tick * 50 });
        bot.physics = this.physics;
        this.owner = { id: 2, name: 'player', username: 'Owner', position: new Vec3(2.5, 10 - this.scenario.depth, 0.5), height: 0.6, yaw: 0 };
        bot.players.Owner = { entity: this.owner };
        bot.entities[2] = this.owner;
        pf.pathfinder(bot);
        const agent = { bot, reflexes: null };
        this.ctx = new CompanionContext(agent, new WorldState(), {
            tick_ms: 250, follow_distance: 3, follow_min_distance: 2,
            scan_radius: 64, fov_degrees: 120, owner_near_radius: 4,
            torch_placing: false, owner_work: { enabled: false },
            nearby_loot: { collector_enabled: false }, crop_replant: { enabled: false }
        });
        this.ctx.ownerName = 'Owner';
        this.ctx.movement.now = () => this.tick * 50;
        this.manager = new CompanionOrchestrator(this.ctx, agent, [], 'follow');
        agent.companion = { manager: this.manager };
        this.ctx.hazardEscape.now = () => this.tick * 50;
        this.eyeContact = new EyeContactReaction({}, { now: () => this.tick * 50, random: () => 0 });
    }

    buildStage() {
        const depth = this.scenario.depth;
        const set = (x, y, z, name) => this.blocks.set(`${x},${y},${z}`, name);
        for (let x = -8; x <= 25; x++) for (let z = -5; z <= 5; z++) {
            // A real one-block bank at entry, then a shallow shelf and a deep pool.
            const floor = x < 0 || x > 21 ? 9 : (x < 7 && depth <= 2 ? 9 - depth : 9 - Math.max(depth, 8));
            set(x, floor, z, 'stone');
            if (x >= 0 && x <= 21) for (let y = floor + 1; y < 10; y++) set(x, y, z, 'water');
            if (this.scenario.id === 'roof-return' && x >= 5 && x <= 17) {
                set(x, 9, z, 'stone');
                set(x, 10, z, 'stone');
            }
        }
    }

    blockAt(position) {
        const p = position.floored();
        const key = `${p.x},${p.y},${p.z}`;
        if (this.options.unloaded && p.x >= 18) return null;
        if (!this.cache.has(key)) {
            const block = Block.fromStateId(registry.blocksByName[this.blocks.get(key) ?? 'air'].defaultState, 0);
            block.position = p;
            this.cache.set(key, block);
        }
        return this.cache.get(key);
    }

    moveOwner() {
        const seconds = this.tick / 20;
        if (this.scenario.id === 'underwater-turns') {
            this.owner.position.set(seconds < 10 ? 12 + seconds * 0.5 : Math.max(10, 17 - (seconds - 10) * 0.5), 7, 0.5);
            return;
        }
        if (this.scenario.id === 'shore-stop') {
            const x = Math.min(22.2, 20 + seconds * 0.5);
            this.owner.position.set(x, Math.min(10, Math.max(9, x - 12)), 0.3);
            return;
        }
        if (this.scenario.id === 'water-idle') {
            this.owner.position.set(10.3, 8.7, 0.7);
            return;
        }
        if (this.options.ownerMotion) {
            const p = this.options.ownerMotion(seconds);
            this.owner.position.set(p.x, p.y, p.z);
            return;
        }
        const id = this.scenario.id;
        const x = Math.min(19.5, 2.5 + seconds * 0.65);
        const depth = this.scenario.depth <= 2
            ? (x < 7 ? this.scenario.depth : 5)
            : Math.min(this.scenario.depth - 1, 2 + seconds * 0.4);
        this.owner.position.set(x, 10 - depth, 0.5);
        if (seconds > 65 && this.scenario.depth <= 2) this.owner.position.set(25.5, 10, 0.5);
        if (id === 'roof-return') this.owner.position.y = 5;
    }

    async step(count = 5) {
        this.pending = (this.pending ?? Promise.resolve()).then(() => this._step(count));
        return this.pending;
    }

    async _step(count) {
        for (let i = 0; i < count && this.bot.health > 0; i++) {
            this.moveOwner();
            if (this.tick % 5 === 0) {
                await this.manager.tick();
                if (this.options.ownerLooksAtBot) {
                    const delta = this.bot.entity.position.minus(this.owner.position);
                    this.owner.yaw = Math.atan2(-delta.x, -delta.z);
                    this.owner.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
                }
                await this.eyeContact.tick(this.ctx);
                const active = this.ctx.hazardEscape.active;
                if (active && !this.wasReturning) this.returnCount++;
                if (!active && this.wasReturning) this.resumedCount++;
                this.wasReturning = active;
            }
            const before = this.bot.entity.position.clone();
            this.physics.simulatePlayer(new physicsLoader.PlayerState(this.bot, this.bot.controlState), this.world).apply(this.bot);
            // Mineflayer emits physicsTick after the integration, then sends
            // movement packets. Include the production packet coalescer too.
            this.bot.emit('physicsTick');
            this.movementPackets.write('position', { ...this.bot.entity.position, onGround: this.bot.entity.onGround });
            this.movementPackets.write('look', { yaw: this.bot.entity.yaw, pitch: this.bot.entity.pitch, onGround: this.bot.entity.onGround });
            this.movementPackets.flush();
            this.tick++;
            const distance = before.distanceTo(this.bot.entity.position);
            if (this.bot.entity.isInWater) this.exhaustion += distance * 0.01;
            else if (this.bot.controlState.sprint) this.exhaustion += distance * 0.1;
            if (this.exhaustion >= 4) {
                this.exhaustion -= 4;
                if (this.bot.foodSaturation > 0) this.bot.foodSaturation--;
                else this.bot.food = Math.max(0, this.bot.food - 1);
            }
            this.stepVitals();
            this.maxProgress = Math.max(this.maxProgress, this.bot.entity.position.x);
            if (this.tick % 5 === 0) this.trace.push(this.sample());
        }
        return this.snapshot();
    }

    stepVitals() {
        const bot = this.bot;
        const eye = bot.entity.position.offset(0, 1.62, 0);
        const eyeBlock = bot.blockAt(eye);
        const underwater = eyeBlock == null || isPassableLiquid(eyeBlock);
        this.air = underwater ? this.air - 1 : Math.min(300, this.air + 4);
        this.minAir = Math.min(this.minAir, this.air);
        if (this.air <= -20) {
            this.air = 0;
            bot.health -= 2;
            this.drowningDamage += 2;
        }
        bot.oxygenLevel = Math.round(this.air / 15);
        if (this.tick === 200 && this.scenario.id === 'low-health') bot.health = 6;
        if (this.tick === 200 && this.scenario.id === 'low-food') bot.food = 5;
        // Inventory contains ordinary food; server consumption takes 32 ticks.
        const food = chooseBestFood(this.foodItems.filter(item => item.count > 0),
            registry.foodsByName, 20 - bot.food, UNSAFE_OR_SPECIAL_FOODS);
        if (food && shouldCompanionEat(bot.food, bot.health)) this.eatingSince ??= this.tick;
        if (this.eatingSince != null && this.tick - this.eatingSince >= 32) {
            const stats = registry.foodsByName[food.name];
            bot.food = Math.min(20, bot.food + stats.foodPoints);
            bot.foodSaturation = Math.min(bot.food, bot.foodSaturation + (stats.saturation ?? 0));
            food.count--;
            this.eatingSince = null;
        }
        if (bot.health < 20 && bot.food > 17 && this.tick % 80 === 0) { bot.health++; this.exhaustion += 6; }
        if (bot.food === 0 && this.tick % 80 === 0 && bot.health > 1) bot.health--;
    }

    sample() {
        const p = this.bot.entity.position;
        return {
            tick: this.tick, x: p.x, y: p.y, z: p.z, hp: this.bot.health,
            oxygen: this.bot.oxygenLevel, food: this.bot.food,
            state: this.manager.getActiveFsmId(), controls: { ...this.bot.controlState },
            target: this.ctx.hazardEscape.target,
            owner: { ...this.owner.position }
        };
    }

    snapshot() {
        return {
            name: this.scenario.id, tick: this.tick, tickMs: 250,
            bot: { ...this.bot.entity.position, yaw: this.bot.entity.yaw, hp: this.bot.health,
                onGround: this.bot.entity.onGround, isInWater: this.bot.entity.isInWater },
            owner: { ...this.owner.position }, enemies: [], drops: [], obstacles: [], inventory: [],
            grave: null, recovery: {}, attacks: 0, shots: 0,
            blocks: [...this.blocks].filter(([, name]) => !['water', 'seagrass', 'kelp_plant'].includes(name)).map(([key]) => {
                const [x, y, z] = key.split(',').map(Number); return { x, y, z };
            }),
            water: [...this.blocks].filter(([, name]) => ['water', 'seagrass', 'kelp_plant'].includes(name)).map(([key]) => {
                const [x, y, z] = key.split(',').map(Number); return { x, y, z };
            }),
            vitals: { oxygen: this.bot.oxygenLevel, airTicks: this.air, food: this.bot.food, minAir: this.minAir, drowningDamage: this.drowningDamage },
            metrics: { returnCount: this.returnCount, resumedCount: this.resumedCount, maxProgress: this.maxProgress,
                horizontalDistance: Math.hypot(this.bot.entity.position.x - this.owner.position.x, this.bot.entity.position.z - this.owner.position.z),
                depthDifference: this.owner.position.y - this.bot.entity.position.y },
            navigation: { state: this.manager.getActiveFsmId(), target: this.ctx.hazardEscape.target,
                ...this.manager.followMode._swim.status,
                ...this.ctx.hazardEscape.airStatus, route: this.ctx.hazardEscape._airPlan?.points ?? [] },
            ended: this.bot.health <= 0
        };
    }
}
