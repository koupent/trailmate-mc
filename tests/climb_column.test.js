import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    ColumnClimber,
    findClimbPushDirection,
    findStandingClimbColumn,
    isClimbableColumnBlock,
    yawTowardDirection
} from '../src/companion/movement/climbColumn.js';

const PASSABLE = new Set([
    'air',
    'vine',
    'cave_vines',
    'twisting_vines',
    'weeping_vines',
    'water'
]);

function makeBlock(name) {
    return { name, boundingBox: PASSABLE.has(name) ? 'empty' : 'block' };
}

/**
 * Block lookup over an explicit "x,y,z" -> block-name map; everything else is air.
 * @param {Record<string, string>} blocks
 */
function makeWorld(blocks) {
    const cells = new Map(
        Object.entries(blocks).map(([key, name]) => [key, makeBlock(name)])
    );
    return (pos) => {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        return cells.get(key) ?? makeBlock('air');
    };
}

function makeBot(blocks) {
    return { blockAt: makeWorld(blocks) };
}

/** Mineflayer's forward vector for a yaw, so direction asserts read as compass. */
function forwardVector(yaw) {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

function assertFacing(yaw, expected, message) {
    const forward = forwardVector(yaw);
    assert.ok(Math.abs(forward.x - expected.x) < 1e-6, message);
    assert.ok(Math.abs(forward.z - expected.z) < 1e-6, message);
}

describe('isClimbableColumnBlock', () => {
    it('accepts the blocks physics climbs by pressing into the wall', () => {
        assert.equal(isClimbableColumnBlock({ name: 'vine' }), true);
        assert.equal(isClimbableColumnBlock({ name: 'ladder' }), true);
    });

    it('rejects look-alikes, scaffolding, air and solid blocks', () => {
        assert.equal(isClimbableColumnBlock({ name: 'cave_vines' }), false);
        assert.equal(isClimbableColumnBlock({ name: 'twisting_vines' }), false);
        assert.equal(isClimbableColumnBlock({ name: 'weeping_vines' }), false);
        assert.equal(isClimbableColumnBlock({ name: 'scaffolding' }), false);
        assert.equal(isClimbableColumnBlock({ name: 'air' }), false);
        assert.equal(isClimbableColumnBlock({ name: 'stone' }), false);
        assert.equal(isClimbableColumnBlock(null), false);
    });
});

describe('findClimbPushDirection', () => {
    it('points at the solid neighbour holding the column', () => {
        const north = findClimbPushDirection(
            makeBot({ '0,64,0': 'vine', '0,64,-1': 'stone' }),
            new Vec3(0, 64, 0)
        );
        assert.deepEqual(north, { x: 0, z: -1 });

        const east = findClimbPushDirection(
            makeBot({ '0,64,0': 'vine', '1,64,0': 'stone' }),
            new Vec3(0, 64, 0)
        );
        assert.deepEqual(east, { x: 1, z: 0 });
    });

    it('refuses a column with nothing to press against', () => {
        const hanging = findClimbPushDirection(
            makeBot({ '0,64,0': 'vine' }),
            new Vec3(0, 64, 0)
        );
        assert.equal(hanging, null);
    });
});

describe('findStandingClimbColumn', () => {
    it('reports the column the feet are inside', () => {
        const bot = makeBot({ '0,64,0': 'vine', '1,64,0': 'stone' });
        const column = findStandingClimbColumn(bot, new Vec3(0.5, 64, 0.5));

        assert.ok(column, 'expected the vine column under the feet');
        assert.deepEqual(
            { x: column.cell.x, y: column.cell.y, z: column.cell.z },
            { x: 0, y: 64, z: 0 }
        );
        assert.deepEqual(column.push, { x: 1, z: 0 });
    });

    it('reports nothing in mid-air or standing on the ground', () => {
        const bot = makeBot({ '0,63,0': 'stone', '0,64,0': 'vine', '1,64,0': 'stone' });
        assert.equal(findStandingClimbColumn(bot, new Vec3(0.5, 70, 0.5)), null);
        assert.equal(findStandingClimbColumn(bot, new Vec3(3.5, 64, 3.5)), null);
    });
});

describe('yawTowardDirection', () => {
    it('yields the yaw whose forward vector is the push direction', () => {
        assertFacing(yawTowardDirection({ x: 0, z: -1 }), { x: 0, z: -1 }, 'north');
        assertFacing(yawTowardDirection({ x: 0, z: 1 }), { x: 0, z: 1 }, 'south');
        assertFacing(yawTowardDirection({ x: 1, z: 0 }), { x: 1, z: 0 }, 'east');
        assertFacing(yawTowardDirection({ x: -1, z: 0 }), { x: -1, z: 0 }, 'west');
    });
});

/** Vines on the west face of a wall; the wall top is walkable at y=67. */
const VINE_WALL = {
    '0,63,0': 'stone',
    '0,64,0': 'vine',
    '0,65,0': 'vine',
    '0,66,0': 'vine',
    '1,64,0': 'stone',
    '1,65,0': 'stone',
    '1,66,0': 'stone'
};

/**
 * Bot stub recording control states and look targets, plus the movement calls
 * the climb is allowed to make.
 *
 * @param {Record<string, string>} blocks
 * @param {Vec3} position
 * @param {Vec3} ownerPosition
 */
function makeClimbCtx(blocks, position, ownerPosition) {
    const controls = new Map();
    const looks = [];
    const bot = {
        entity: { position, yaw: 0, height: 1.8, onGround: false },
        blockAt: makeWorld(blocks),
        async look(yaw, pitch, force) {
            looks.push({ yaw, pitch, force });
        },
        setControlState(name, state) {
            controls.set(name, state);
        },
        getControlState(name) {
            return controls.get(name) ?? false;
        }
    };
    return {
        bot,
        controls,
        looks,
        movement: {
            stops: 0,
            stop() {
                this.stops += 1;
            }
        },
        ownerEntity: { id: 7, position: ownerPosition },
        deathRecovery: { active: false },
        agent: { reflexes: null }
    };
}

function makeClock(start = 1000) {
    const clock = { now: start };
    return { clock, read: () => clock.now };
}

describe('ColumnClimber start conditions', () => {
    it('stays out of the way while the owner is on the same level', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(0.5, 64, 2.5));
        const climber = new ColumnClimber();

        assert.equal(climber.tick(ctx), false);
        assert.equal(climber.active, false);
        assert.equal(ctx.movement.stops, 0);
        assert.equal(ctx.controls.size, 0);
    });

    it('does not climb a vine with nothing behind it', () => {
        const ctx = makeClimbCtx(
            { '0,64,0': 'vine', '0,65,0': 'vine' },
            new Vec3(0.5, 64, 0.5),
            new Vec3(0.5, 68, 0.5)
        );
        const climber = new ColumnClimber();

        assert.equal(climber.tick(ctx), false);
        assert.equal(ctx.movement.stops, 0);
        assert.equal(ctx.controls.size, 0);
    });

    it('drops the follow goal once, then faces the wall and pushes forward', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read });

        assert.equal(climber.tick(ctx), true);
        assert.equal(ctx.movement.stops, 1, 'pathfinder must lose the path before the push');
        assert.equal(ctx.bot.getControlState('forward'), true);
        assert.equal(ctx.bot.getControlState('sprint'), false);
        assertFacing(ctx.looks.at(-1).yaw, { x: 1, z: 0 }, 'must face the supporting wall');

        clock.now += 250;
        ctx.bot.entity.position = new Vec3(0.5, 65, 0.5);
        assert.equal(climber.tick(ctx), true);
        assert.equal(ctx.movement.stops, 1, 'the goal is dropped only on the first tick');
        assert.equal(ctx.bot.getControlState('forward'), true);
    });
});

describe('ColumnClimber completion', () => {
    it('releases forward once the owner height is reached inside the column', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(0.5, 66, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read });

        assert.equal(climber.tick(ctx), true);

        clock.now += 250;
        ctx.bot.entity.position = new Vec3(0.5, 66, 0.5);
        assert.equal(climber.tick(ctx), false);
        assert.equal(climber.active, false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('keeps pushing past the last vine, then finishes on the wall top', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read });

        assert.equal(climber.tick(ctx), true);

        // Above the last vine the feet cell is air, but letting go here would
        // simply drop the bot back down the wall.
        clock.now += 250;
        ctx.bot.entity.position = new Vec3(0.5, 67, 0.5);
        assert.equal(climber.tick(ctx), true);
        assert.equal(climber.phase, 'topping');
        assert.equal(ctx.bot.getControlState('forward'), true);

        clock.now += 250;
        ctx.bot.entity.position = new Vec3(1.5, 67, 0.5);
        ctx.bot.entity.onGround = true;
        assert.equal(climber.tick(ctx), false);
        assert.equal(climber.active, false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('restarts a bounded number of times after sliding back down', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read, maxTopOutRetries: 1 });

        climber.tick(ctx);
        clock.now += 250;
        ctx.bot.entity.position = new Vec3(0.5, 67, 0.5);
        climber.tick(ctx);
        assert.equal(climber.phase, 'topping');

        // The push was not enough: the bot fell back into the column.
        clock.now += 1000;
        ctx.bot.entity.position = new Vec3(0.5, 64, 0.5);
        assert.equal(climber.tick(ctx), true);
        assert.equal(climber.phase, 'climbing', 'one more attempt is allowed');
        assert.equal(ctx.bot.getControlState('forward'), true);

        clock.now += 250;
        ctx.bot.entity.position = new Vec3(0.5, 67, 0.5);
        climber.tick(ctx);
        clock.now += 1000;
        ctx.bot.entity.position = new Vec3(0.5, 64, 0.5);
        assert.equal(climber.tick(ctx), false, 'the retry budget is spent');
        assert.equal(ctx.bot.getControlState('forward'), false);
    });
});

describe('ColumnClimber abort conditions', () => {
    it('gives up and releases forward when the height stops growing', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read, stallMs: 1500 });

        assert.equal(climber.tick(ctx), true);

        clock.now += 1000;
        assert.equal(climber.tick(ctx), true, 'still inside the stall window');

        clock.now += 600;
        assert.equal(climber.tick(ctx), false);
        assert.equal(climber.active, false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('gives up once the overall time limit is spent', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 90, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read, timeoutMs: 1000, stallMs: 10_000 });

        assert.equal(climber.tick(ctx), true);

        clock.now += 500;
        ctx.bot.entity.position = new Vec3(0.5, 65, 0.5);
        assert.equal(climber.tick(ctx), true);

        clock.now += 600;
        ctx.bot.entity.position = new Vec3(0.5, 66, 0.5);
        assert.equal(climber.tick(ctx), false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('hands movement back the moment combat takes ownership', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read });

        assert.equal(climber.tick(ctx), true);
        assert.equal(ctx.bot.getControlState('forward'), true);

        clock.now += 250;
        ctx.agent.reflexes = { wantsCombat: true };
        assert.equal(climber.tick(ctx), false);
        assert.equal(climber.active, false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('releases forward when the owner is gone', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const climber = new ColumnClimber();

        assert.equal(climber.tick(ctx), true);

        ctx.ownerEntity = null;
        assert.equal(climber.tick(ctx), false);
        assert.equal(ctx.bot.getControlState('forward'), false);
    });

    it('hands the wall back to ordinary follow for a while after a failure', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({
            now: read,
            stallMs: 1500,
            retryCooldownMs: 3000
        });

        climber.tick(ctx);
        clock.now += 1600;
        assert.equal(climber.tick(ctx), false, 'the stall must end the attempt');

        clock.now += 250;
        assert.equal(climber.tick(ctx), false, 'no doomed retry on the very next tick');
        assert.equal(ctx.movement.stops, 1);

        clock.now += 3000;
        assert.equal(climber.tick(ctx), true, 'the wall is tried again after the cooldown');
        assert.equal(ctx.movement.stops, 2);
    });

    it('resumes right away after an interruption, with no cooldown', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const { clock, read } = makeClock();
        const climber = new ColumnClimber({ now: read });

        climber.tick(ctx);
        ctx.agent.reflexes = { wantsCombat: true };
        assert.equal(climber.tick(ctx), false);

        clock.now += 250;
        ctx.agent.reflexes = null;
        assert.equal(climber.tick(ctx), true);
        assert.equal(ctx.bot.getControlState('forward'), true);
    });

    it('release() is a no-op while idle and never touches the controls', () => {
        const ctx = makeClimbCtx(VINE_WALL, new Vec3(0.5, 64, 0.5), new Vec3(1.5, 67, 0.5));
        const climber = new ColumnClimber();

        climber.release(ctx);
        assert.equal(ctx.controls.size, 0);
    });
});
