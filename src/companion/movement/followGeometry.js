import { DEFAULT_FOLLOW_DISTANCE, SAME_FLOOR_DY } from './followConstants.js';

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
export function horizontalDistanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{ x: number, y: number, z: number }} ownerPos
 * @param {number} [followDistance]
 */
export function isNearOwnerHorizontally(botPos, ownerPos, followDistance = DEFAULT_FOLLOW_DISTANCE) {
    const horiz = horizontalDistanceBetween(botPos, ownerPos);
    const dy = Math.abs(ownerPos.y - botPos.y);
    return horiz < followDistance && dy < SAME_FLOOR_DY;
}
