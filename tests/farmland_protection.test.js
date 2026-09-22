import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    applySafeMovementFlags,
    configureFarmlandJumpAvoidance,
    enforceSafeMovements
} from '../src/companion/blockProtection.js';
import { jumpBlockedByFarmland } from '../src/companion/movement/farmland.js';
import { jumpOntoStep } from '../src/companion/movement/climb.js';
import { HazardEscapeController } from '../src/companion/movement/HazardEscape.js';
import { applyCombatStepAssist } from '../src/combat/combatStepAssist.js';
import { Reflexes } from '../src/reflexes/Reflexes.js';

/** Farmland is 15/16 of a block tall, so feet rest below the cell boundary. */
const FARMLAND_SURFACE_Y = 63.9375;

const PASSABLE = new Set(['air', 'water', 'wheat', 'carrots', 'potatoes', 'lava']);

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

function makeControlBot(blocks, position) {
    const controls = new Map();
    return {
        entity: { position, yaw: 0, height: 1.8, onGround: true },
        blockAt: makeWorld(blocks),
        setControlState(name, state) {
            controls.set(name, state);
        },
        getControlState(name) {
            return controls.get(name) ?? false;
        },
        controls
    };
}

/**
 * Run one generated move through the farmland guard.
 * The stub generator emits exactly `destination`, so the returned neighbor
 * count tells whether the guard kept or dropped that candidate.
 *
 * @param {Record<string, string>} blocks
 * @param {string} method pathfinder move generator name
 * @param {{ x: number, y: number, z: number }} node
 * @param {{ x: number, z: number }} dir
 * @param {{ x: number, y: number, z: number }} destination
 * @returns {boolean} true when the move survives the guard
 */
function movePlanned(blocks, method, node, dir, destination) {
    const blockAt = makeWorld(blocks);
    const movements = {
        bot: { blockAt },
        getBlock: (from, dx, dy, dz) => blockAt(
            new Vec3(from.x + dx, from.y + dy, from.z + dz)
        ),
        [method]: (...args) => {
            args[args.length - 1].push(destination);
        }
    };
    configureFarmlandJumpAvoidance(movements);

    const neighbors = [];
    if (method === 'getMoveDown') movements[method](node, neighbors);
    else movements[method](node, dir, neighbors);
    return neighbors.length === 1;
}

const NODE = { x: 0, y: 64, z: 0 };
const EAST = { x: 1, z: 0 };
const NORTH_EAST = { x: 1, z: 1 };

describe('farmland support detection', () => {
    it('reads the support block under feet resting on 15/16-tall farmland', () => {
        const bot = { blockAt: makeWorld({ '0,63,0': 'farmland' }) };
        assert.equal(
            jumpBlockedByFarmland(bot, { x: 0.5, y: FARMLAND_SURFACE_Y, z: 0.5 }, null),
            true
        );
    });

    it('treats a block-aligned landing cell the same way', () => {
        const bot = { blockAt: makeWorld({ '3,63,0': 'farmland' }) };
        assert.equal(
            jumpBlockedByFarmland(bot, null, { x: 3.5, y: 64, z: 0.5 }),
            true
        );
    });

    it('allows a jump when neither end rests on farmland', () => {
        const bot = {
            blockAt: makeWorld({ '0,63,0': 'stone', '3,63,0': 'dirt' })
        };
        assert.equal(
            jumpBlockedByFarmland(
                bot,
                { x: 0.5, y: 64, z: 0.5 },
                { x: 3.5, y: 64, z: 0.5 }
            ),
            false
        );
    });
});

describe('pathfinding away from farmland', () => {
    it('drops step-up jumps that take off from farmland', () => {
        assert.equal(
            movePlanned(
                { '0,63,0': 'farmland', '1,64,0': 'stone' },
                'getMoveJumpUp',
                NODE,
                EAST,
                { x: 1, y: 65, z: 0 }
            ),
            false
        );
    });

    it('drops step-up jumps that land on farmland, planted or not', () => {
        for (const above of ['air', 'wheat']) {
            assert.equal(
                movePlanned(
                    { '0,63,0': 'stone', '1,64,0': 'farmland', '1,65,0': above },
                    'getMoveJumpUp',
                    NODE,
                    EAST,
                    { x: 1, y: 65, z: 0 }
                ),
                false,
                above
            );
        }
    });

    it('keeps the same step-up between ordinary blocks', () => {
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '1,64,0': 'stone' },
                'getMoveJumpUp',
                NODE,
                EAST,
                { x: 1, y: 65, z: 0 }
            ),
            true
        );
    });

    it('drops diagonal rises over farmland but keeps level diagonals on it', () => {
        const field = {
            '0,63,0': 'farmland',
            '1,64,1': 'stone',
            '1,63,1': 'farmland'
        };
        assert.equal(
            movePlanned(field, 'getMoveDiagonal', NODE, NORTH_EAST, { x: 1, y: 65, z: 1 }),
            false
        );
        assert.equal(
            movePlanned(field, 'getMoveDiagonal', NODE, NORTH_EAST, { x: 1, y: 64, z: 1 }),
            true
        );
    });

    it('drops parkour jumps at either end, even across a level gap', () => {
        const destination = { x: 2, y: 64, z: 0 };
        assert.equal(
            movePlanned(
                { '0,63,0': 'farmland', '2,63,0': 'stone' },
                'getMoveParkourForward',
                NODE,
                EAST,
                destination
            ),
            false
        );
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '2,63,0': 'farmland' },
                'getMoveParkourForward',
                NODE,
                EAST,
                destination
            ),
            false
        );
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '2,63,0': 'stone' },
                'getMoveParkourForward',
                NODE,
                EAST,
                destination
            ),
            true
        );
    });

    it('drops step-downs and falls that end on farmland', () => {
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '1,62,0': 'farmland' },
                'getMoveDropDown',
                NODE,
                EAST,
                { x: 1, y: 63, z: 0 }
            ),
            false
        );
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '0,62,0': 'farmland' },
                'getMoveDown',
                NODE,
                EAST,
                { x: 0, y: 63, z: 0 }
            ),
            false
        );
        assert.equal(
            movePlanned(
                { '0,63,0': 'stone', '1,62,0': 'stone' },
                'getMoveDropDown',
                NODE,
                EAST,
                { x: 1, y: 63, z: 0 }
            ),
            true
        );
    });

    it('keeps walking across a flat field so planting still works', () => {
        assert.equal(
            movePlanned(
                { '0,63,0': 'farmland', '1,63,0': 'farmland' },
                'getMoveForward',
                NODE,
                EAST,
                { x: 1, y: 64, z: 0 }
            ),
            true
        );
    });
});

/** Movements shaped like the ones mineflayer-pvp installs over ours. */
function makePluginMovements(blocks) {
    const blockAt = makeWorld(blocks);
    return {
        bot: { blockAt, registry: { blocksArray: [] } },
        canDig: true,
        blocksToAvoid: new Set(),
        exclusionAreasStep: [],
        openable: new Set(),
        scafoldingBlocks: [{ id: 1 }],
        getBlock: (from, dx, dy, dz) => blockAt(
            new Vec3(from.x + dx, from.y + dy, from.z + dz)
        ),
        getMoveJumpUp: (node, dir, neighbors) => {
            neighbors.push({ x: node.x + dir.x, y: node.y + 1, z: node.z + dir.z });
        },
        getMoveDiagonal: (node, dir, neighbors) => {
            neighbors.push({ x: node.x + dir.x, y: node.y, z: node.z + dir.z });
        }
    };
}

describe('plugin-replaced pathfinder settings', () => {
    it('re-applies farmland protection to movements a plugin installs', () => {
        const installed = [];
        const bot = {
            pathfinder: {
                setMovements: (movements) => installed.push(movements)
            }
        };
        enforceSafeMovements(bot);

        const plugin = makePluginMovements({ '0,63,0': 'farmland', '1,64,0': 'stone' });
        bot.pathfinder.setMovements(plugin);

        assert.equal(installed.length, 1);
        assert.equal(plugin.canDig, false);
        const neighbors = [];
        plugin.getMoveJumpUp(NODE, EAST, neighbors);
        assert.deepEqual(neighbors, []);
    });

    it('installs the guard once even when flags are re-applied', () => {
        const movements = makePluginMovements({
            '0,63,0': 'stone',
            '1,64,0': 'stone'
        });
        applySafeMovementFlags(movements);
        applySafeMovementFlags(movements);

        const neighbors = [];
        movements.getMoveJumpUp(NODE, EAST, neighbors);
        assert.deepEqual(neighbors, [{ x: 1, y: 65, z: 0 }]);
    });
});

describe('combat step assist over farmland', () => {
    it('does not jump off farmland toward a step', () => {
        const bot = makeControlBot(
            { '0,63,0': 'farmland', '1,63,0': 'stone' },
            new Vec3(0.5, FARMLAND_SURFACE_Y, 0.5)
        );
        assert.equal(applyCombatStepAssist(bot, Math.PI / 2), false);
        assert.equal(bot.getControlState('jump'), false);
    });

    it('does not jump onto a farmland step', () => {
        const bot = makeControlBot(
            { '0,63,0': 'stone', '1,64,0': 'farmland' },
            new Vec3(0.5, 64, 0.5)
        );
        assert.equal(applyCombatStepAssist(bot, Math.PI / 2), false);
        assert.equal(bot.getControlState('jump'), false);
    });

    it('still climbs the same step built from stone', () => {
        const bot = makeControlBot(
            { '0,63,0': 'stone', '1,64,0': 'stone' },
            new Vec3(0.5, 64, 0.5)
        );
        assert.equal(applyCombatStepAssist(bot, Math.PI / 2), true);
        assert.equal(bot.getControlState('jump'), true);
    });
});

/** Bot stub for HazardEscapeController: lava at the feet, ground below. */
function makeHazardBot(blocks, position) {
    const bot = makeControlBot(blocks, position);
    bot.pvp = { forceStop: () => {} };
    return bot;
}

describe('hazard escape over farmland', () => {
    it('escapes lava without jumping while standing on farmland', () => {
        const bot = makeHazardBot(
            { '0,63,0': 'farmland', '0,64,0': 'lava', '4,63,0': 'stone' },
            new Vec3(0.5, FARMLAND_SURFACE_Y, 0.5)
        );
        const controller = new HazardEscapeController(bot, { stop: () => {} });

        assert.equal(controller.tick(), true);
        assert.equal(bot.getControlState('jump'), false);
        assert.equal(bot.getControlState('forward') || bot.getControlState('back'), true);
    });

    it('does not jump toward an escape target supported by farmland', () => {
        const bot = makeHazardBot(
            { '0,63,0': 'stone', '0,64,0': 'lava', '3,63,0': 'farmland' },
            new Vec3(0.5, 64, 0.5)
        );
        const controller = new HazardEscapeController(bot, { stop: () => {} });
        controller.target = { x: 3.5, y: 64, z: 0.5 };

        assert.equal(controller.tick(), true);
        assert.equal(controller.target.x, 3.5, 'farmland target stays selected');
        assert.equal(bot.getControlState('jump'), false);
    });

    it('still jumps out of lava over ordinary ground', () => {
        const bot = makeHazardBot(
            { '0,63,0': 'stone', '0,64,0': 'lava', '3,63,0': 'stone' },
            new Vec3(0.5, 64, 0.5)
        );
        const controller = new HazardEscapeController(bot, { stop: () => {} });
        controller.target = { x: 3.5, y: 64, z: 0.5 };

        assert.equal(controller.tick(), true);
        assert.equal(bot.getControlState('jump'), true);
    });
});

/** Bot stub for climb.jumpOntoStep, which drives controls and velocity itself. */
function makeClimbBot(blocks, position) {
    const bot = makeControlBot(blocks, position);
    bot.entity.velocity = new Vec3(0, 0, 0);
    bot.cleared = 0;
    bot.clearControlStates = () => {
        bot.cleared += 1;
    };
    bot.pathfinder = { setGoal: () => {} };
    bot.lookAt = async () => {};
    return bot;
}

describe('manual step jump for grave and stuck recovery', () => {
    it('refuses the jump and leaves controls and velocity untouched on farmland', async () => {
        const bot = makeClimbBot(
            { '0,63,0': 'farmland', '1,64,0': 'stone' },
            new Vec3(0.5, FARMLAND_SURFACE_Y, 0.5)
        );

        assert.equal(await jumpOntoStep(bot, new Vec3(1.5, 65, 0.5)), false);
        assert.equal(bot.getControlState('jump'), false);
        assert.equal(bot.cleared, 0);
        assert.deepEqual(
            { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z },
            { x: 0, y: 0, z: 0 }
        );
    });

    it('refuses a jump that would land on farmland', async () => {
        const bot = makeClimbBot(
            { '0,63,0': 'stone', '1,64,0': 'farmland' },
            new Vec3(0.5, 64, 0.5)
        );

        assert.equal(await jumpOntoStep(bot, new Vec3(1.5, 65, 0.5)), false);
        assert.equal(bot.cleared, 0);
    });

    it('still performs the jump over ordinary blocks', async () => {
        const bot = makeClimbBot(
            { '0,63,0': 'stone', '1,64,0': 'stone' },
            new Vec3(0.5, 64, 0.5)
        );

        await jumpOntoStep(bot, new Vec3(1.5, 65, 0.5));
        assert.ok(bot.cleared > 0);
        assert.ok(bot.entity.velocity.y > 0);
    });
});

const AFLOAT_CONFIG = {
    self_defense: false,
    self_preservation: true,
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
        state_path: 'data/combat-state.test.json'
    }
};

function makeAfloatBot(supportBlock) {
    const bot = makeControlBot(
        { '0,63,0': supportBlock, '0,64,0': 'water' },
        new Vec3(0.5, FARMLAND_SURFACE_Y, 0.5)
    );
    bot.health = 20;
    bot.entities = {};
    bot.inventory = { items: () => [], slots: [] };
    bot.pvp = { forceStop: () => {} };
    bot.on = () => {};
    return bot;
}

describe('surfacing in water above farmland', () => {
    it('does not jump to surface while standing on farmland', async () => {
        const bot = makeAfloatBot('farmland');
        const reflexes = new Reflexes(bot, AFLOAT_CONFIG, 7);

        await reflexes.tick({ movementHeld: false, isIdleish: true });
        assert.equal(bot.getControlState('jump'), false);
    });

    it('still surfaces over ordinary ground', async () => {
        const bot = makeAfloatBot('stone');
        const reflexes = new Reflexes(bot, AFLOAT_CONFIG, 7);

        await reflexes.tick({ movementHeld: false, isIdleish: true });
        assert.equal(bot.getControlState('jump'), true);
    });
});
