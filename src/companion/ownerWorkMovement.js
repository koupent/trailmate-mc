import {
    getDeferringPlayerIds,
    isOwnerWorkDeferring
} from './ownerWorkTracker.js';
import { isBotInOwnerFov } from './followPosition.js';
import {
    DEFAULT_FOLLOW_DISTANCE,
    FOLLOW_GOAL_RANGE
} from './movement/followConstants.js';
import { horizontalDistanceBetween } from './movement/followGeometry.js';
import {
    PLAYER_PUSH_LANE,
    wouldPathPassNearPlayer
} from './movement/playerPathClearance.js';
import { notifyPathBlocked } from './movement/playerBlockNotify.js';
import { computeWorkYieldTarget } from './movement/workYieldPosition.js';

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
 * Step aside from a working player's mining lane.
 * Yield target prefers a lateral FOV-out spot; if the only path crosses the
 * player and no lateral option exists, chat and stop until the way clears.
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
    const fov = ownerWorkFovDegrees(ctx);
    const inHorizFov = isBotInOwnerFov(worker, bot.entity.position, fov);
    const horiz = horizontalDistanceBetween(bot.entity.position, worker.position);

    const { target } = computeWorkYieldTarget(
        worker,
        bot.entity.position,
        {
            distance: followDistance,
            fovDegrees: fov,
            isPathBlocked: (pos) => wouldPathPassNearPlayer(ctx, pos)
        }
    );

    const directBlocked = wouldPathPassNearPlayer(ctx, target);

    // Already clear of the cone and far enough — hold.
    if (!inHorizFov && horiz >= followDistance) {
        ctx.movement.stop();
        return true;
    }

    const distToTarget = horizontalDistanceBetween(bot.entity.position, target);
    if (!inHorizFov && distToTarget < FOLLOW_GOAL_RANGE) {
        ctx.movement.stop();
        return true;
    }

    // Already scraping the player — any pathfinder step will push them.
    // Wait (and say so) until they create space; do not chase a lateral goal.
    const tooCloseToMove = horiz <= PLAYER_PUSH_LANE;

    // Never path through / scrape a player — stop and ask them to clear the way.
    if (directBlocked || tooCloseToMove) {
        notifyPathBlocked(ctx);
        ctx.movement.stop();
        return true;
    }

    ctx.movement.goToward(target, FOLLOW_GOAL_RANGE, {
        rejectIf: () => wouldPathPassNearPlayer(ctx, target)
    });
    return true;
}
