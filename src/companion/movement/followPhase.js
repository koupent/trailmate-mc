import { Vec3 } from 'vec3';
import { computeOutOfSightAnchor } from '../followPosition.js';
import { hasLineOfSight } from '../../world/lineOfSight.js';
import { isCloseablePassage } from './DoorTracker.js';
import {
    DEFAULT_FOLLOW_DISTANCE,
    SAME_FLOOR_DY
} from './followConstants.js';
import { horizontalDistanceBetween } from './followGeometry.js';

/** Walkable width at or below this counts as a narrow corridor. */
export const NARROW_CORRIDOR_WIDTH = 2;

/**
 * Horizontal walkable width perpendicular to the owner→bot axis at the owner.
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} ownerPos
 * @param {{ x: number, y: number, z: number }} botPos
 * @returns {number}
 */
export function measureCorridorWidth(bot, ownerPos, botPos) {
    const dx = botPos.x - ownerPos.x;
    const dz = botPos.z - ownerPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len;
    const feetY = Math.floor(ownerPos.y + 0.001);

    let blocked = 0;
    for (const sign of [-1, 1]) {
        const cx = Math.floor(ownerPos.x + px * sign);
        const cz = Math.floor(ownerPos.z + pz * sign);
        if (isSolidColumn(bot, cx, feetY, cz)) blocked += 1;
    }
    return 3 - blocked;
}

/**
 * True when the bot is behind the owner (outside the forward half-plane).
 * @param {{ position: { x: number, z: number }, yaw?: number }} owner
 * @param {{ x: number, z: number }} botPos
 */
export function isBotBehindOwner(owner, botPos) {
    const yaw = owner.yaw || 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dx = botPos.x - owner.position.x;
    const dz = botPos.z - owner.position.z;
    return fx * dx + fz * dz < -0.05;
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{ x: number, y: number, z: number }} ownerPos
 * @returns {boolean}
 */
export function isPassageSeparating(ctx, botPos, ownerPos) {
    const doors = ctx?.doors;
    if (typeof doors?.findSeparatingPassage === 'function') {
        return doors.findSeparatingPassage(botPos, ownerPos);
    }
    return false;
}

/**
 * @typedef {'near' | 'trail' | 'merge'} FollowPhase
 */

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {import('prismarine-entity').Entity} owner
 * @returns {FollowPhase}
 */
export function resolveFollowPhase(ctx, owner) {
    const bot = ctx.bot;
    const botPos = bot?.entity?.position;
    const ownerPos = owner?.position;
    if (!botPos || !ownerPos) return 'merge';

    const followDistance = ctx.config?.follow_distance ?? DEFAULT_FOLLOW_DISTANCE;
    const horiz = horizontalDistanceBetween(botPos, ownerPos);
    const dy = Math.abs(ownerPos.y - botPos.y);
    const onSameFloor = dy < SAME_FLOOR_DY;
    const hasLos = canSeeOwner(bot, owner);
    const doorSeparated = isPassageSeparating(ctx, botPos, ownerPos);

    if (horiz < followDistance && onSameFloor && hasLos && !doorSeparated) {
        return 'near';
    }

    const width = measureCorridorWidth(bot, ownerPos, botPos);
    if (width <= NARROW_CORRIDOR_WIDTH && isBotBehindOwner(owner, botPos)) {
        return 'trail';
    }

    return 'merge';
}

/**
 * Anchor behind the owner at the configured minimum follow distance.
 * @param {import('prismarine-entity').Entity} owner
 * @param {number} minDistance
 * @returns {{ x: number, y: number, z: number }}
 */
export function computeTrailAnchor(owner, minDistance) {
    return computeOutOfSightAnchor(owner, minDistance);
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-entity').Entity} owner
 */
function canSeeOwner(bot, owner) {
    try {
        return hasLineOfSight(bot, owner);
    } catch {
        return false;
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} x
 * @param {number} feetY
 * @param {number} z
 */
function isSolidColumn(bot, x, feetY, z) {
    const feet = bot.blockAt?.(new Vec3(x, feetY, z));
    const head = bot.blockAt?.(new Vec3(x, feetY + 1, z));
    return isSolidBlock(feet) && isSolidBlock(head);
}

/**
 * @param {{ name?: string, boundingBox?: string, _properties?: { open?: boolean, half?: string } }|null|undefined} block
 */
function isSolidBlock(block) {
    if (!block?.name || block.name === 'air') return false;
    if (isCloseablePassage(block)) {
        return block._properties?.open !== true && block._properties?.half !== 'upper';
    }
    return block.boundingBox === 'block';
}
