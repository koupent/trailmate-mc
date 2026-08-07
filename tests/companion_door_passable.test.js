import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    alignPathToDoorGaps,
    computeDoorFreeCenter,
    configureDoorAwareMovements,
    isDoorPassableName,
    markDoorWalkableForPathfinder
} from '../src/companion/blockProtection.js';

describe('isDoorPassableName', () => {
    it('accepts wooden doors and fence gates', () => {
        assert.equal(isDoorPassableName('oak_door'), true);
        assert.equal(isDoorPassableName('spruce_fence_gate'), true);
    });

    it('rejects iron, trapdoors, and unrelated blocks', () => {
        assert.equal(isDoorPassableName('iron_door'), false);
        assert.equal(isDoorPassableName('oak_trapdoor'), false);
        assert.equal(isDoorPassableName('cobblestone'), false);
    });
});

describe('computeDoorFreeCenter / markDoorWalkableForPathfinder', () => {
    it('computes free center away from the open door leaf', () => {
        const free = computeDoorFreeCenter({
            position: { x: 27, y: 65, z: 557 },
            shapes: [[0.8125, 0, 0, 1, 1, 1]]
        });
        assert.ok(free.x < 27.5);
        assert.equal(free.z, 557.5);
    });

    it('reconstructs free center from facing/hinge when shapes are empty', () => {
        const free = computeDoorFreeCenter({
            position: { x: 27, y: 65, z: 557 },
            shapes: [],
            _properties: { open: true, facing: 'south', hinge: 'left' }
        });
        assert.ok(Math.abs(free.x - 27.406) < 0.01);
    });

    it('marks open doors walkable for A* only', () => {
        const block = {
            name: 'oak_door',
            _properties: { open: true, half: 'lower' },
            boundingBox: 'block',
            shapes: [[0.8125, 0, 0, 1, 1, 1]]
        };
        assert.equal(markDoorWalkableForPathfinder(block), true);
        assert.equal(block.safe, true);
        assert.equal(block.physical, false);
        assert.equal(block.boundingBox, 'block');
        assert.deepEqual(block.shapes, [[0.8125, 0, 0, 1, 1, 1]]);
    });
});

describe('alignPathToDoorGaps', () => {
    it('retargets door nodes from cell center to the free gap', () => {
        const bot = {
            blockAt: () => ({
                name: 'oak_door',
                position: { x: 27, y: 65, z: 557 },
                _properties: { open: true, half: 'lower' },
                shapes: [[0.8125, 0, 0, 1, 1, 1]]
            })
        };
        const path = [{ x: 27.5, y: 65, z: 557.5 }];

        assert.equal(alignPathToDoorGaps(bot, path), 1);
        assert.ok(Math.abs(path[0].x - 27.406) < 0.01);
        assert.equal(path[0].z, 557.5);
    });

    it('leaves nodes without an open door untouched', () => {
        const bot = { blockAt: () => ({ name: 'cobblestone' }) };
        const path = [{ x: 10.5, y: 64, z: 10.5 }];

        assert.equal(alignPathToDoorGaps(bot, path), 0);
        assert.equal(path[0].x, 10.5);
    });
});

/**
 * Minimal Movements stub with the members configureDoorAwareMovements patches.
 * @param {object} block block returned by getBlock
 */
function makeMovementsStub(block) {
    return {
        bot: { registry: { blocksArray: [{ name: 'oak_door', id: 100 }] } },
        openable: new Set(),
        canOpenDoors: false,
        getBlock: () => block,
        getMoveDiagonal: (node, dir, neighbors) => neighbors.push('diagonal')
    };
}

describe('configureDoorAwareMovements', () => {
    it('skips diagonal moves around doors so the bot cannot cut the corner', () => {
        const openDoor = {
            name: 'oak_door',
            _properties: { open: true, half: 'lower' },
            boundingBox: 'block',
            shapes: [[0.8125, 0, 0, 1, 1, 1]]
        };
        const doorMovements = configureDoorAwareMovements(makeMovementsStub(openDoor));
        const blocked = [];
        doorMovements.getMoveDiagonal({ x: 0, y: 64, z: 0 }, { x: 1, z: 1 }, blocked);
        assert.deepEqual(blocked, []);

        const plainMovements = configureDoorAwareMovements(makeMovementsStub({ name: 'cobblestone' }));
        const allowed = [];
        plainMovements.getMoveDiagonal({ x: 0, y: 64, z: 0 }, { x: 1, z: 1 }, allowed);
        assert.deepEqual(allowed, ['diagonal']);
    });

    it('marks open doors as safe/non-physical for pathfinding', () => {
        const openDoor = {
            name: 'oak_door',
            _properties: { open: true, half: 'lower' },
            boundingBox: 'block',
            shapes: [[0.8125, 0, 0, 1, 1, 1]],
            safe: false,
            physical: true,
            openable: true
        };
        const movements = makeMovementsStub(openDoor);

        configureDoorAwareMovements(movements);
        assert.equal(movements.canOpenDoors, true);
        assert.equal(movements.openable.has(100), true);

        const result = movements.getBlock({ x: 0, y: 0, z: 0 }, 0, 0, 0);
        assert.equal(result.safe, true);
        assert.equal(result.physical, false);
        assert.equal(result.openable, false);
        // Physics collision must stay on the shared block object.
        assert.equal(result.boundingBox, 'block');
        assert.deepEqual(result.shapes, [[0.8125, 0, 0, 1, 1, 1]]);
    });

    it('preserves explicit no-door mode for closest-reachable fallback paths', () => {
        const movements = makeMovementsStub({ name: 'cobblestone' });
        movements._trailmateDisableDoorOpening = true;

        configureDoorAwareMovements(movements);

        assert.equal(movements.canOpenDoors, false);
    });

    it('marks upper door halves as safe so closed lower doors can be opened', () => {
        const upper = {
            name: 'oak_door',
            _properties: { open: false, half: 'upper' },
            boundingBox: 'block',
            shapes: [[0, 0, 0.8125, 1, 1, 1]],
            safe: false,
            physical: true,
            openable: true
        };
        const movements = makeMovementsStub(upper);

        configureDoorAwareMovements(movements);
        const result = movements.getBlock({ x: 0, y: 0, z: 0 }, 0, 1, 0);
        assert.equal(result.safe, true);
        assert.equal(result.physical, false);
        assert.equal(result.boundingBox, 'block');
    });

    it('leaves closed lower doors physical so canOpenDoors can activate them', () => {
        const closedDoor = {
            name: 'oak_door',
            _properties: { open: false, half: 'lower' },
            boundingBox: 'block',
            safe: false,
            physical: true,
            openable: true
        };
        const movements = makeMovementsStub(closedDoor);

        configureDoorAwareMovements(movements);
        const result = movements.getBlock({ x: 0, y: 0, z: 0 }, 0, 0, 0);
        assert.equal(result.safe, false);
        assert.equal(result.physical, true);
    });
});
