import { isInOwnerFov } from '../world/fov.js';

/**
 * Point behind the owner (outside their look FOV) at the given follow distance.
 * Mineflayer yaw 0 faces -Z; behind is +sin(yaw) X / +cos(yaw) Z.
 *
 * @param {{ position: { x: number, y: number, z: number }, yaw?: number }} owner
 * @param {number} distance
 * @returns {{ x: number, y: number, z: number }}
 */
export function computeOutOfSightAnchor(owner, distance) {
    const pos = owner.position;
    const yaw = owner.yaw || 0;
    return {
        x: pos.x + Math.sin(yaw) * distance,
        y: pos.y,
        z: pos.z + Math.cos(yaw) * distance
    };
}

/**
 * @param {{ position: { x: number, y: number, z: number }, yaw?: number }|null|undefined} owner
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {number} fovDegrees
 */
export function isBotInOwnerFov(owner, botPos, fovDegrees) {
    return isInOwnerFov(owner, botPos, fovDegrees);
}
