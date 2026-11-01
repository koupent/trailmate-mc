import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import minecraftData from 'minecraft-data';
import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { MovementController } from '../src/companion/movement/MovementController.js';
import {
    FOLLOW_SPRINT_MARGIN,
    OWNER_SPRINT_SPEED,
    TRAVEL_SPRINT_DISTANCE
} from '../src/companion/movement/sprintPolicy.js';
import { DEFAULT_FOLLOW_DISTANCE } from '../src/companion/movement/followConstants.js';

function makeHarness() {
    let now = 10_000;
    const blocks = new Map();
    const bot = new EventEmitter();
    bot.registry = minecraftData('1.21.4');
    bot.entity = {
        position: new Vec3(0, 64, 0),
        height: 1.8,
        onGround: true
    };
    bot.food = 20;
    bot.game = { minY: -64, dimension: 'overworld' };
    bot.world = { raycast: () => null };
    bot.blockAt = (pos) => blocks.get(
        `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    ) || null;
    let movementSets = 0;
    bot.pathfinder = {
        goal: null,
        movements: null,
        setMovements(movements) {
            movementSets += 1;
            this.movements = movements;
        },
        setGoal(goal) {
            this.goal = goal;
        },
        isMoving() {
            return false;
        }
    };

    const movement = new MovementController(bot, { now: () => now });
    return {
        bot,
        movement,
        movementSets: () => movementSets,
        setNow(value) {
            now = value;
        },
        setColumn(x, groundY, z) {
            for (const [y, name] of [
                [groundY, 'stone'],
                [groundY + 1, 'air'],
                [groundY + 2, 'air']
            ]) {
                blocks.set(`${x},${y},${z}`, {
                    name,
                    position: new Vec3(x, y, z),
                    boundingBox: name === 'air' ? 'empty' : 'block',
                    _properties: {}
                });
            }
        }
    };
}

function ownerAt(x, z = 0) {
    return {
        id: 7,
        position: new Vec3(x, 64, z),
        height: 1.8
    };
}

describe('MovementController のスプリント', () => {
    it('遅れた追従では走り、追いついたら同じ経路のまま歩く', () => {
        const harness = makeHarness();
        const far = DEFAULT_FOLLOW_DISTANCE + FOLLOW_SPRINT_MARGIN + 4;
        harness.setColumn(far, 63, 0);
        harness.setColumn(0, 63, 0);
        const owner = ownerAt(far + 0.5);

        assert.equal(harness.movement.followEntity(owner, 1), true);
        assert.equal(harness.movement.movements.allowSprinting, true);
        const setsAfterGoal = harness.movementSets();

        harness.bot.entity.position = new Vec3(far - 2, 64, 0);
        assert.equal(harness.movement.followEntity(owner, 1), false);
        assert.equal(harness.movement.movements.allowSprinting, false);
        assert.equal(harness.movementSets(), setsAfterGoal);
    });

    it('オーナーが走って離れるときは、短い遅れでも走る', () => {
        const harness = makeHarness();
        harness.setColumn(4, 63, 0);
        harness.setColumn(5, 63, 0);
        harness.setColumn(6, 63, 0);
        const owner = ownerAt(4.5);

        harness.movement.followEntity(owner, 1);
        assert.equal(harness.movement.movements.allowSprinting, false);

        harness.setNow(10_250);
        owner.position = new Vec3(4.5 + OWNER_SPRINT_SPEED * 0.25, 64, 0);
        harness.movement.followEntity(owner, 1, { followDistance: DEFAULT_FOLLOW_DISTANCE });

        assert.equal(harness.movement.movements.allowSprinting, true);
    });

    it('歩きの相手に付く短い追従と、近い目的地と、登りは走らない', () => {
        const harness = makeHarness();
        harness.setColumn(4, 63, 0);
        const owner = ownerAt(4.5);
        harness.setNow(10_000);
        harness.movement.followEntity(owner, 1);
        harness.setNow(10_250);
        owner.position = new Vec3(4.5 + 1, 64, 0);
        harness.setColumn(5, 63, 0);
        harness.movement.followEntity(owner, 1);
        assert.equal(harness.movement.movements.allowSprinting, false);

        assert.equal(
            harness.movement.goToward({ x: TRAVEL_SPRINT_DISTANCE - 1, y: 64, z: 0 }, 1),
            true
        );
        assert.equal(harness.movement.movements.allowSprinting, false);

        assert.equal(
            harness.movement.goToward({ x: TRAVEL_SPRINT_DISTANCE + 4, y: 64, z: 0 }, 1),
            true
        );
        assert.equal(harness.movement.movements.allowSprinting, true);

        assert.equal(harness.movement.climbTo({ x: 30, y: 70, z: 0 }), true);
        assert.equal(harness.movement.movements.allowSprinting, false);
    });

    it('止まると歩きに戻り、戦闘の固定中は停止しても許可を残す', () => {
        const harness = makeHarness();
        harness.setColumn(20, 63, 0);
        harness.movement.followEntity(ownerAt(20.5), 1);
        assert.equal(harness.movement.movements.allowSprinting, true);

        harness.movement.stop();
        assert.equal(harness.movement.movements.allowSprinting, false);

        harness.movement.setSprintAllowed(true);
        harness.movement.goToward({ x: 2, y: 64, z: 0 }, 1);
        assert.equal(harness.movement.movements.allowSprinting, true);
        harness.movement.stop();
        assert.equal(harness.movement.movements.allowSprinting, true);
        harness.movement.setSprintAllowed(false);
        assert.equal(harness.movement.movements.allowSprinting, false);
    });

    it('満腹度が 6 以下では走らず、安全設定の再適用でも戦闘の許可は残る', () => {
        const harness = makeHarness();
        harness.bot.food = 6;
        harness.setColumn(20, 63, 0);
        harness.movement.followEntity(ownerAt(20.5), 1);
        assert.equal(harness.movement.movements.allowSprinting, false);

        harness.bot.food = 20;
        harness.movement.setSprintAllowed(true);
        assert.equal(harness.movement.movements.allowSprinting, true);
        harness.bot.pathfinder.setMovements(harness.movement.movements);
        assert.equal(harness.movement.movements.allowSprinting, true);
        assert.equal(harness.movement.movements._trailmateWalkParkour, true);

        const foreign = new pf.Movements(harness.bot);
        foreign.allowSprinting = true;
        harness.bot.pathfinder.setMovements(foreign);
        assert.equal(foreign.allowSprinting, false);
    });
});
