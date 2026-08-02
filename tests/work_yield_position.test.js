import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isBotInOwnerFov } from '../src/companion/followPosition.js';
import {
    computeWorkYieldTarget,
    lateralDistanceFromMiningLane
} from '../src/companion/movement/workYieldPosition.js';
import { wouldPathPassNearPlayer } from '../src/companion/movement/playerPathClearance.js';
import { horizontalPointToSegmentDistance } from '../src/companion/movement/followGeometry.js';

describe('workYieldPosition', () => {
    it('picks a lateral yield target when the bot is ahead in a 2-wide corridor', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const botPos = { x: 0, y: 64, z: -2 };
        const { target, hasLateralAlternative } = computeWorkYieldTarget(owner, botPos, {
            distance: 3,
            fovDegrees: 100
        });

        assert.equal(hasLateralAlternative, true);
        assert.equal(isBotInOwnerFov(owner, target, 100), false);
        assert.ok(Math.abs(target.x) >= 2.5, `expected lateral X, got ${target.x}`);
        assert.ok(
            Math.abs(target.z) < 1.5,
            `expected not the behind anchor (z≈3), got z=${target.z}`
        );
        assert.ok(lateralDistanceFromMiningLane(owner, target) >= 0.5);
    });

    it('falls back to the behind anchor when no lateral FOV-out candidate exists', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const botPos = { x: 0, y: 64, z: 2 };
        const { target, hasLateralAlternative } = computeWorkYieldTarget(owner, botPos, {
            distance: 3,
            fovDegrees: 359
        });

        assert.equal(hasLateralAlternative, false);
        assert.ok(Math.abs(target.x) < 1e-9);
        assert.ok(Math.abs(target.z - 3) < 1e-9);
        assert.equal(isBotInOwnerFov(owner, target, 359), false);
    });

    it('prefers an unblocked lateral over a blocked one', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const botPos = { x: 0, y: 64, z: -2 };
        const { target, hasLateralAlternative } = computeWorkYieldTarget(owner, botPos, {
            distance: 3,
            fovDegrees: 100,
            isPathBlocked: (t) => t.x > 0
        });
        assert.equal(hasLateralAlternative, true);
        assert.ok(target.x < 0, `expected negative-X lateral, got ${target.x}`);
    });

    it('falls back to behind when every lateral path is blocked', () => {
        const owner = { position: new Vec3(0, 64, 0), yaw: 0 };
        const botPos = { x: 0, y: 64, z: -2 };
        const { target, hasLateralAlternative } = computeWorkYieldTarget(owner, botPos, {
            distance: 3,
            fovDegrees: 100,
            isPathBlocked: () => true
        });
        assert.equal(hasLateralAlternative, false);
        assert.ok(Math.abs(target.x) < 1e-9);
        assert.ok(Math.abs(target.z - 3) < 1e-9);
    });
});

describe('playerPathClearance', () => {
    it('detects when the straight path to a behind anchor crosses the player', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const ctx = {
            ownerEntity: owner,
            bot: {
                entity: { id: 1, position: { x: 0, y: 64, z: -2 } },
                players: { Steve: { entity: owner } }
            }
        };
        const behind = { x: 0, y: 64, z: 3 };
        assert.equal(wouldPathPassNearPlayer(ctx, behind), true);

        const lateral = { x: 3, y: 64, z: 0 };
        assert.equal(wouldPathPassNearPlayer(ctx, lateral), false);
    });

    it('blocks movement when already next to the player and the target does not clear space', () => {
        const owner = { id: 7, position: { x: 0, y: 64, z: 0 }, yaw: 0 };
        const ctx = {
            ownerEntity: owner,
            bot: {
                entity: { id: 1, position: { x: 0.5, y: 64, z: 0.2 } },
                players: { Steve: { entity: owner } }
            }
        };
        // Nearby lateral that does not increase separation enough
        assert.equal(
            wouldPathPassNearPlayer(ctx, { x: 0.4, y: 64, z: -0.5 }),
            true
        );
        // Clear step away
        assert.equal(
            wouldPathPassNearPlayer(ctx, { x: 3, y: 64, z: 0 }),
            false
        );
    });

    it('computes point-to-segment distance on the horizontal plane', () => {
        const d = horizontalPointToSegmentDistance(
            { x: 0, z: 0 },
            { x: -2, z: -2 },
            { x: 2, z: -2 }
        );
        assert.ok(Math.abs(d - 2) < 1e-9);
    });
});
