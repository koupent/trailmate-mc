import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    HazardEscapeController,
    findNearestExtinguishingWater,
    isEntityBurning
} from '../src/companion/movement/HazardEscape.js';
import {
    findContactHazards,
    findSafeEscapePosition,
    isDamageBlock,
    isSafeStandPosition
} from '../src/companion/movement/hazardBlocks.js';
import {
    currentControlOwner,
    selectControlOwner
} from '../src/companion/ControlPriority.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';
import { configureDamageBlockAvoidance } from '../src/companion/blockProtection.js';

function makeBlock(name, boundingBox = 'empty', properties = {}) {
    return { name, boundingBox, _properties: properties };
}

function makeWorld({ position = new Vec3(0.5, 64, 0.5), blocks = {} } = {}) {
    const cells = new Map(Object.entries(blocks));
    const controls = new Map();
    const events = [];
    const bot = {
        entity: { position, height: 1.8, yaw: 0 },
        pvp: { forceStop: () => events.push('pvp-stop') },
        setControlState(control, enabled) {
            controls.set(control, enabled);
            events.push(`${control}:${enabled}`);
        },
        blockAt(pos) {
            const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
            if (cells.has(key)) return cells.get(key);
            return pos.y === 63
                ? makeBlock('stone', 'block')
                : makeBlock('air');
        }
    };
    const movement = { stop: () => events.push('movement-stop') };
    return { bot, cells, controls, events, movement };
}

describe('damage block classification and contact', () => {
    it('covers liquid and solid contact hazards but ignores extinguished campfires', () => {
        for (const name of [
            'lava',
            'fire',
            'soul_fire',
            'magma_block',
            'campfire',
            'soul_campfire',
            'cactus',
            'sweet_berry_bush',
            'wither_rose',
            'powder_snow',
            'pointed_dripstone'
        ]) {
            assert.equal(isDamageBlock(makeBlock(name)), true, name);
        }
        assert.equal(isDamageBlock(makeBlock('campfire', 'empty', { lit: false })), false);
        assert.equal(isDamageBlock(makeBlock('stone', 'block')), false);
    });

    it('detects lava at the feet and magma below the bot', () => {
        const lava = makeWorld({ blocks: { '0,64,0': makeBlock('lava') } });
        assert.deepEqual(
            findContactHazards(lava.bot).map((hazard) => hazard.block.name),
            ['lava']
        );

        const magma = makeWorld({ blocks: { '0,63,0': makeBlock('magma_block', 'block') } });
        assert.deepEqual(
            findContactHazards(magma.bot).map((hazard) => hazard.block.name),
            ['magma_block']
        );
    });

    it('detects a cactus only when the bot hitbox reaches the neighbouring cell', () => {
        const world = makeWorld({
            position: new Vec3(0.75, 64, 0.5),
            blocks: { '1,64,0': makeBlock('cactus', 'block') }
        });
        assert.deepEqual(
            findContactHazards(world.bot).map((hazard) => hazard.block.name),
            ['cactus']
        );
    });
});

describe('burning detection and extinguishing water', () => {
    it('reads both Mineflayer fire properties and the shared metadata flag', () => {
        assert.equal(isEntityBurning({ isOnFire: true }), true);
        assert.equal(isEntityBurning({ onFire: true }), true);
        assert.equal(isEntityBurning({ metadata: { 0: 0x01 } }), true);
        assert.equal(isEntityBurning({ metadata: { 0: 0x02 } }), false);
    });

    it('sorts loaded water by distance and skips rejected targets', () => {
        const world = makeWorld({
            blocks: {
                '3,64,0': makeBlock('water'),
                '6,64,0': makeBlock('water')
            }
        });
        world.bot.findBlocks = () => [new Vec3(6, 64, 0), new Vec3(3, 64, 0)];

        assert.deepEqual(
            findNearestExtinguishingWater(world.bot),
            { x: 3.5, y: 64, z: 0.5 }
        );
        assert.deepEqual(
            findNearestExtinguishingWater(
                world.bot,
                world.bot.entity.position,
                12,
                new Set(['3,64,0'])
            ),
            { x: 6.5, y: 64, z: 0.5 }
        );
    });
});

describe('safe hazard escape position', () => {
    it('selects a standable destination with a full-cell gap from lava', () => {
        const world = makeWorld({ blocks: { '0,64,0': makeBlock('lava') } });
        const hazards = findContactHazards(world.bot);
        const target = findSafeEscapePosition(world.bot, world.bot.entity.position, hazards);

        assert.ok(target);
        assert.ok(Math.hypot(target.x - 0.5, target.z - 0.5) >= 2);
        assert.equal(isSafeStandPosition(world.bot, target), true);
    });

    it('rejects a nominally open cell beside a damage block', () => {
        const world = makeWorld({ blocks: { '0,64,0': makeBlock('fire') } });
        assert.equal(
            isSafeStandPosition(world.bot, { x: 1.5, y: 64, z: 0.5 }),
            false
        );
        assert.equal(
            isSafeStandPosition(world.bot, { x: 2.5, y: 64, z: 0.5 }),
            true
        );
    });

    it('recognizes an actual slab surface but does not target empty space above it', () => {
        const slab = makeBlock('stone_slab', 'block');
        slab.shapes = [[0, 0, 0, 1, 0.5, 1]];
        const world = makeWorld({ blocks: { '2,64,0': slab } });

        assert.equal(
            isSafeStandPosition(world.bot, { x: 2.5, y: 64.5, z: 0.5 }),
            true
        );
        assert.equal(
            isSafeStandPosition(world.bot, { x: 2.5, y: 65, z: 0.5 }),
            false
        );
    });
});

describe('pathfinder hazard avoidance', () => {
    it('adds every damage block and rejects a step supported by magma', () => {
        const world = makeWorld({ blocks: { '0,63,0': makeBlock('magma_block', 'block') } });
        world.bot.registry = {
            blocksArray: [
                { id: 1, name: 'stone' },
                { id: 2, name: 'magma_block' },
                { id: 3, name: 'sweet_berry_bush' }
            ]
        };
        const movements = {
            bot: world.bot,
            blocksToAvoid: new Set(),
            exclusionAreasStep: []
        };

        configureDamageBlockAvoidance(movements);

        assert.deepEqual([...movements.blocksToAvoid], [2, 3]);
        assert.equal(movements.exclusionAreasStep.length, 1);
        assert.equal(movements.exclusionAreasStep[0]({
            position: new Vec3(0, 64, 0)
        }), 100);
        assert.equal(movements.exclusionAreasStep[0]({
            position: new Vec3(2, 64, 0)
        }), 0);
    });
});

describe('HazardEscapeController', () => {
    it('preempts movement immediately, swims out of lava, then releases controls', () => {
        const world = makeWorld({ blocks: { '0,64,0': makeBlock('lava') } });
        const escape = new HazardEscapeController(world.bot, world.movement);

        assert.equal(escape.tick(), true);
        assert.equal(escape.active, true);
        assert.ok(escape.target);
        assert.ok(world.events.includes('movement-stop'));
        assert.ok(world.events.includes('pvp-stop'));
        assert.equal(world.controls.get('jump'), true);
        assert.equal(world.controls.get('sprint'), true);
        assert.ok(['forward', 'back', 'left', 'right']
            .some((control) => world.controls.get(control) === true));

        world.bot.entity.position = new Vec3(
            escape.target.x,
            escape.target.y,
            escape.target.z
        );
        assert.equal(escape.tick(), true, 'first safe tick confirms clearance');
        assert.equal(escape.tick(), false, 'second safe tick releases control');
        assert.equal(escape.active, false);
        for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
            assert.equal(world.controls.get(control), false, control);
        }
    });

    it('uses pathfinder for distant water and waits submerged until fire clears', () => {
        const world = makeWorld({ blocks: { '5,64,0': makeBlock('water') } });
        world.bot.entity.metadata = { 0: 0x01 };
        world.bot.findBlocks = () => [new Vec3(5, 64, 0)];
        world.movement.isBlocked = false;
        world.movement.isUnreachable = false;
        world.movement.goToward = (target, range) => {
            world.events.push(`water:${target.x},${target.y},${target.z}:${range}`);
        };
        world.movement.setSprintAllowed = (allowed) => {
            world.events.push(`sprint-allowed:${allowed}`);
        };
        const escape = new HazardEscapeController(world.bot, world.movement);

        assert.equal(escape.tick(), true);
        assert.equal(escape.active, true);
        assert.ok(world.events.includes('water:5.5,64,0.5:0'));

        world.bot.entity.position = new Vec3(5.5, 64, 0.5);
        assert.equal(escape.tick(), true, 'stay submerged while still burning');
        assert.equal(world.controls.get('sprint'), false);

        world.bot.entity.metadata[0] = 0;
        assert.equal(escape.tick(), false);
        assert.equal(escape.active, false);
    });

    it('does not freeze ordinary behavior when no extinguishing water is loaded', () => {
        const world = makeWorld();
        world.bot.entity.metadata = { 0: 0x01 };
        world.bot.findBlocks = () => [];
        const escape = new HazardEscapeController(world.bot, world.movement);

        assert.equal(escape.tick(), false);
        assert.equal(escape.active, false);
    });
});

describe('hazard movement ownership', () => {
    it('outranks recovery, combat, transfer and upper modes', () => {
        assert.equal(selectControlOwner({
            hazardActive: true,
            recoveryActive: true,
            recoveryEmergency: true,
            combatActive: true,
            transferActive: true,
            upperMode: 'wait'
        }), 'hazard');
        assert.equal(currentControlOwner({
            hazardEscape: { active: true },
            agent: { companion: { manager: { getActiveFsmId: () => 'combat' } } }
        }), 'hazard');
    });

    it('runs even while the orchestrator is paused and skips ordinary behavior', async () => {
        const calls = [];
        const ctx = {
            hazardEscape: { tick: () => { calls.push('hazard'); return true; } }
        };
        const agent = {};
        const manager = new CompanionOrchestrator(ctx, agent, [], 'follow');
        manager.targets.paused = true;
        manager.root.activeState.runTick = async () => calls.push('behavior');

        await manager.tick();

        assert.deepEqual(calls, ['hazard']);
        assert.equal(manager._busy, false);
    });
});
