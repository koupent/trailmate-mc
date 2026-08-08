import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { suppressUnsafeFollowPath } from '../src/companion/movement/MovementController.js';

function makeBot(position, blocked, block = null) {
    return {
        entity: { position, height: 1.8 },
        world: { raycast: () => (blocked ? { name: 'wall' } : null) },
        blockAt: () => block
    };
}

function makeTarget(position) {
    return { position, height: 1.8 };
}

describe('suppressUnsafeFollowPath', () => {
    it('holds a nearby partial path instead of walking toward its arbitrary frontier', () => {
        const result = {
            status: 'partial',
            path: [{ x: 4, y: 64, z: 2 }]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(0, 64, 0), false),
            result,
            makeTarget(new Vec3(20, 64, 0))
        );

        assert.equal(reason, 'partial-follow-route');
        assert.deepEqual(result.path, []);
    });

    it('holds a far partial path while the complete route search continues', () => {
        const result = {
            status: 'partial',
            path: [{ x: 4, y: 64, z: 2 }]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(0, 64, 0), false),
            result,
            makeTarget(new Vec3(40, 64, 0))
        );

        assert.equal(reason, 'partial-follow-route');
        assert.deepEqual(result.path, []);
    });

    it('rejects a completed route whose endpoint is outside the owner enclosure', () => {
        const result = {
            status: 'success',
            path: [
                { x: -329.5, y: 75, z: 226.5 },
                { x: -347, y: 75, z: 226 }
            ]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(-320.5, 75, 226.5), true),
            result,
            makeTarget(new Vec3(-348.69, 75, 225.21))
        );

        assert.equal(reason, 'obstructed-target-endpoint');
        assert.deepEqual(result.path, []);
    });

    it('keeps a completed route when its endpoint can see the owner', () => {
        const result = {
            status: 'success',
            path: [{ x: 9.5, y: 64, z: 0.5 }]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(0, 64, 0), false),
            result,
            makeTarget(new Vec3(10, 64, 0))
        );

        assert.equal(reason, null);
        assert.equal(result.path.length, 1);
    });

    it('keeps a successful detour through a gate outside the direct owner line', () => {
        const gate = {
            name: 'pale_oak_fence_gate',
            position: new Vec3(5, 64, 5),
            _properties: { open: false, facing: 'west' }
        };
        const result = {
            status: 'success',
            path: [{
                x: 9.5,
                y: 64,
                z: 0.5,
                toPlace: [{ x: 5, y: 64, z: 5, useOne: true }]
            }]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(0, 64, 0), false, gate),
            result,
            makeTarget(new Vec3(10, 64, 0))
        );

        assert.equal(reason, null);
        assert.equal(result.path.length, 1);
    });

    it('keeps a successful route through a gate that separates bot and owner', () => {
        const gate = {
            name: 'pale_oak_fence_gate',
            position: new Vec3(5, 64, 0),
            _properties: { open: false, facing: 'west' }
        };
        const result = {
            status: 'success',
            path: [{
                x: 9.5,
                y: 64,
                z: 0.5,
                toPlace: [{ x: 5, y: 64, z: 0, useOne: true }]
            }]
        };

        const reason = suppressUnsafeFollowPath(
            makeBot(new Vec3(0, 64, 0), false, gate),
            result,
            makeTarget(new Vec3(10, 64, 0))
        );

        assert.equal(reason, null);
        assert.equal(result.path.length, 1);
    });
});
