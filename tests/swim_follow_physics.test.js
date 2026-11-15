import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';
import physicsLoader from 'prismarine-physics';
import { SwimFollow } from '../src/companion/movement/SwimFollow.js';
import { HazardEscapeController } from '../src/companion/movement/HazardEscape.js';
import { findSurfaceFollowTarget } from '../src/companion/movement/MovementController.js';

it('follows a changing water depth with real physics, then surfaces independently for air', () => {
    const registry = registryLoader('1.21.6');
    const Block = blockLoader(registry);
    const world = {
        getBlock(pos) {
            const name = pos.y < 40 ? 'stone' : pos.y < 70 ? 'water' : 'air';
            const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
            block.position = pos.floored();
            return block;
        }
    };
    const bot = {
        version: '1.21.6', inventory: { slots: [] }, controlState: {},
        jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
        health: 20, food: 20, oxygenLevel: 20,
        entity: {
            position: new Vec3(0.5, 60, 0.5), velocity: new Vec3(0, 0, 0),
            yaw: 0, pitch: 0, height: 1.8, width: 0.6,
            onGround: false, isInWater: true, effects: {}, attributes: {}
        },
        blockAt: pos => world.getBlock(pos),
        setControlState(key, value) { this.controlState[key] = value; }
    };
    const ctx = {
        bot, ownerEntity: { position: new Vec3(0.5, 64, -8) },
        movement: { stop() {} }, config: { follow_distance: 3 }
    };
    const swim = new SwimFollow();
    const physics = physicsLoader.Physics(registry, world);
    function simulate(seconds, decide) {
        for (let tick = 0; tick < seconds * 20; tick++) {
            if (tick % 5 === 0) decide();
            physics.simulatePlayer(new physicsLoader.PlayerState(bot, bot.controlState), world).apply(bot);
        }
    }
    assert.deepEqual(findSurfaceFollowTarget(bot, ctx.ownerEntity.position), ctx.ownerEntity.position);
    simulate(8, () => swim.tick(ctx));
    assert.ok(Math.abs(bot.entity.position.y - 64) < 0.8, `rise: ${bot.entity.position.y}`);
    assert.ok(Math.abs(bot.entity.position.z + 8) < 3.5);
    ctx.ownerEntity.position.y = 57;
    simulate(18, () => swim.tick(ctx));
    assert.ok(Math.abs(bot.entity.position.y - 57) < 0.8, `dive: ${bot.entity.position.y}`);

    const escape = new HazardEscapeController(bot, ctx.movement);
    ctx.hazardEscape = escape;
    bot.oxygenLevel = 5;
    assert.equal(escape.tick(), true);
    swim.release(ctx);
    assert.equal(bot.controlState.jump, true, 'safety keeps its controls on follow exit');
    simulate(12, () => escape.tick());
    assert.ok(bot.entity.position.y >= 69, `surface: ${bot.entity.position.y}`);
    bot.oxygenLevel = 15;
    assert.equal(escape.tick(), false);
});
