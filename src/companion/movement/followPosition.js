/** Horizontal speed below this uses yaw instead of velocity. */
const VELOCITY_YAW_FALLBACK = 0.08;
/** Dot-product threshold for treating the bot as ahead of the owner. */
const FRONT_DOT_THRESHOLD = 0.25;
/** Smallest GoalNear arrive radius (blocks). */
const MIN_ARRIVE_RANGE = 0.5;

/**
 * Mineflayer forward vector on XZ: x = -sin(yaw), z = -cos(yaw).
 * Prefers horizontal velocity when the owner is moving; otherwise uses yaw.
 *
 * @param {{ yaw?: number, velocity?: { x?: number, z?: number } }} owner
 * @returns {{ x: number, z: number }}
 */
export function getOwnerForwardXZ(owner) {
    const vx = owner?.velocity?.x ?? 0;
    const vz = owner?.velocity?.z ?? 0;
    const speed = Math.hypot(vx, vz);
    if (speed > VELOCITY_YAW_FALLBACK) {
        return { x: vx / speed, z: vz / speed };
    }
    const yaw = owner?.yaw ?? 0;
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * World position behind the owner by `distance` blocks on XZ.
 *
 * @param {{ position: { x: number, y: number, z: number }, yaw?: number, velocity?: { x?: number, z?: number } }} owner
 * @param {number} distance
 * @returns {{ x: number, y: number, z: number }}
 */
export function computeFollowAnchor(owner, distance) {
    const forward = getOwnerForwardXZ(owner);
    const pos = owner.position;
    return {
        x: pos.x - forward.x * distance,
        y: pos.y,
        z: pos.z - forward.z * distance
    };
}

/**
 * True when bot is in the owner's forward half-plane (dot with forward > threshold).
 *
 * @param {{ x: number, z: number }} botPos
 * @param {{ x: number, z: number }} ownerPos
 * @param {{ x: number, z: number }} forward
 * @param {number} [threshold=FRONT_DOT_THRESHOLD]
 * @returns {boolean}
 */
export function isBotInFront(botPos, ownerPos, forward, threshold = FRONT_DOT_THRESHOLD) {
    const dx = botPos.x - ownerPos.x;
    const dz = botPos.z - ownerPos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return false;
    return (dx / len) * forward.x + (dz / len) * forward.z > threshold;
}

/**
 * GoalNear arrival radius that keeps the bot outside minDistance of the owner
 * when the anchor is `followDistance` behind the owner.
 *
 * @param {number} followDistance
 * @param {number} minDistance
 * @returns {number}
 */
export function computeArriveRange(followDistance, minDistance) {
    const safeMin = Math.max(0, minDistance);
    const safeFollow = Math.max(safeMin, followDistance);
    return Math.max(MIN_ARRIVE_RANGE, safeFollow - safeMin);
}
