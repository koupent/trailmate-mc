import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isInOwnerFov } from '../src/world/fov.js';
import {
    computeOutOfSightAnchor,
    isBotInOwnerFov
} from '../src/companion/followPosition.js';

describe('followPosition', () => {
    it('places the out-of-sight anchor behind the owner (yaw 0 = -Z)', () => {
        const owner = { position: new Vec3(10, 64, 20), yaw: 0 };
        const anchor = computeOutOfSightAnchor(owner, 3);
        assert.ok(Math.abs(anchor.x - 10) < 1e-9);
        assert.equal(anchor.y, 64);
        assert.ok(Math.abs(anchor.z - 23) < 1e-9);
        assert.equal(isInOwnerFov(owner, anchor, 100), false);
    });

    it('anchor stays outside a 100° owner FOV for common yaw values', () => {
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
            const owner = { position: new Vec3(0, 64, 0), yaw };
            const anchor = computeOutOfSightAnchor(owner, 3);
            assert.equal(
                isBotInOwnerFov(owner, anchor, 100),
                false,
                `expected FOV-out for yaw=${yaw}`
            );
        }
    });

    it('detects a point in front of the owner as inside FOV', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const front = new Vec3(0, 64, -3);
        assert.equal(isBotInOwnerFov(owner, front, 100), true);
    });
});
