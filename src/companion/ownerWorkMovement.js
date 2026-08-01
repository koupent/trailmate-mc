import {
    getDeferringPlayerIds,
    isOwnerWorkDeferring
} from './ownerWorkTracker.js';
import { computeOutOfSightAnchor, isBotInOwnerFov } from './followPosition.js';

const FOLLOW_GOAL_RANGE = 1;
const SAME_FLOOR_DY = 2;
const DEFAULT_FOLLOW_DISTANCE = 3;
const DEFAULT_OWNER_WORK_FOV = 100;

function ownerWorkEnabled(ctx) {
    return ctx?.config?.owner_work?.enabled !== false;
}

function ownerWorkFovDegrees(ctx) {
    return ctx?.config?.owner_work?.fov_degrees ?? DEFAULT_OWNER_WORK_FOV;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} entityId
 */
export function resolvePlayerEntity(ctx, entityId) {
    const bot = ctx.bot;
    if (!bot || bot.entity?.id === entityId) return null;
    for (const name of Object.keys(bot.players || {})) {
        const entity = bot.players[name]?.entity;
        if (entity?.id === entityId) return entity;
    }
    return bot.entities?.[entityId] || null;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function getDeferringPlayerEntities(ctx) {
    return getDeferringPlayerIds(ctx)
        .map((entityId) => resolvePlayerEntity(ctx, entityId))
        .filter(Boolean);
}

/**
 * True when the bot is inside any working player's FOV cone.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function isBotInOwnerWorkFov(ctx) {
    return isBotInAnyPlayerWorkFov(ctx);
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function isBotInAnyPlayerWorkFov(ctx) {
    if (!isOwnerWorkDeferring(ctx)) return false;
    const botPos = ctx?.bot?.entity?.position;
    if (!botPos) return false;
    const fov = ownerWorkFovDegrees(ctx);
    for (const player of getDeferringPlayerEntities(ctx)) {
        if (player?.position && isBotInOwnerFov(player, botPos, fov)) return true;
    }
    return false;
}

/**
 * True when a world position lies inside any working player's FOV cone.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} pos
 */
export function isPositionInOwnerWorkFov(ctx, pos) {
    return isPositionInAnyPlayerWorkFov(ctx, pos);
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} pos
 */
export function isPositionInAnyPlayerWorkFov(ctx, pos) {
    if (!isOwnerWorkDeferring(ctx) || !pos) return false;
    const fov = ownerWorkFovDegrees(ctx);
    for (const player of getDeferringPlayerEntities(ctx)) {
        if (player?.position && isBotInOwnerFov(player, pos, fov)) return true;
    }
    return false;
}

/**
 * True when pathing to `targetPos` during player work would enter a worker's FOV.
 * Items already within pickup magnet range are allowed.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} targetPos
 * @param {{ withinPickupRange?: number }} [opts]
 */
export function wouldEnterOwnerWorkFov(ctx, targetPos, opts = {}) {
    if (!ownerWorkEnabled(ctx) || !isOwnerWorkDeferring(ctx)) return false;
    if (ctx?.deathRecovery?.active || ctx?.graveLoot?.active) return false;
    if (!targetPos) return false;
    if (isBotInAnyPlayerWorkFov(ctx)) return false;

    const fov = ownerWorkFovDegrees(ctx);
    const withinPickupRange = opts.withinPickupRange;
    const botPos = ctx.bot?.entity?.position;

    for (const player of getDeferringPlayerEntities(ctx)) {
        if (!player?.position) continue;
        if (!isBotInOwnerFov(player, targetPos, fov)) continue;
        if (withinPickupRange != null && withinPickupRange > 0 && botPos) {
            if (distanceBetween(botPos, targetPos) <= withinPickupRange) continue;
        }
        return true;
    }
    return false;
}

/** @param {{ x: number, y: number, z: number, distanceTo?: Function }} a @param {{ x: number, y: number, z: number }} b */
function distanceBetween(a, b) {
    if (typeof a.distanceTo === 'function') return a.distanceTo(b);
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** @param {{ x: number, y: number, z: number }} a @param {{ x: number, y: number, z: number }} b */
function horizontalDistanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Pick the working player the bot should retreat from this tick.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
function pickRetreatWorker(ctx) {
    const botPos = ctx?.bot?.entity?.position;
    if (!botPos) return null;
    const fov = ownerWorkFovDegrees(ctx);
    let best = null;
    let bestScore = Infinity;
    for (const player of getDeferringPlayerEntities(ctx)) {
        if (!player?.position) continue;
        const dist = horizontalDistanceBetween(botPos, player.position);
        const inFov = isBotInOwnerFov(player, botPos, fov);
        const score = inFov ? dist : dist + 1000;
        if (score < bestScore) {
            bestScore = score;
            best = player;
        }
    }
    return best;
}

/**
 * Stay out of any nearby working player's view.
 * Returns true when movement was handled for this tick.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function applyOwnerWorkRetreat(ctx) {
    if (!ownerWorkEnabled(ctx) || !isOwnerWorkDeferring(ctx)) return false;

    const worker = pickRetreatWorker(ctx);
    const bot = ctx.bot;
    if (!worker?.position || !bot?.entity) return false;
    if (ctx.movement?.isHeld) return false;

    const followDistance = ctx.config?.follow_distance ?? DEFAULT_FOLLOW_DISTANCE;
    const workerDy = worker.position.y - bot.entity.position.y;
    const inHorizFov = isBotInOwnerFov(worker, bot.entity.position, ownerWorkFovDegrees(ctx));
    const sameFloor = Math.abs(workerDy) < SAME_FLOOR_DY;

    if (!inHorizFov && sameFloor) {
        ctx.movement.stop();
        return true;
    }

    const anchor = computeOutOfSightAnchor(worker, followDistance);
    const distToAnchor = Math.hypot(
        bot.entity.position.x - anchor.x,
        bot.entity.position.z - anchor.z
    );
    if (distToAnchor < FOLLOW_GOAL_RANGE && sameFloor) {
        ctx.movement.stop();
        return true;
    }

    ctx.movement.goToward(anchor, FOLLOW_GOAL_RANGE);
    return true;
}
