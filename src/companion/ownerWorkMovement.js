import {
    getDeferringPlayerIds,
    isOwnerWorkDeferring
} from './ownerWorkTracker.js';
import { isBotInOwnerFov } from './followPosition.js';
import {
    DEFAULT_FOLLOW_DISTANCE
} from './movement/followConstants.js';
import { horizontalDistanceBetween } from './movement/followGeometry.js';
import {
    PLAYER_PUSH_LANE,
    wouldPathPassNearPlayer
} from './movement/playerPathClearance.js';
import { notifyPathBlocked } from './movement/playerBlockNotify.js';
import {
    computeSharedWorkYieldTarget,
    isClearOfAllWorkers
} from './movement/workYieldPosition.js';

const DEFAULT_OWNER_WORK_FOV = 100;
const WORK_POSITION_GOAL_RANGE = 0.5;

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

/** @param {import('./CompanionContext.js').CompanionContext} ctx */
export function getDeferringPlayerEntities(ctx) {
    return getDeferringPlayerIds(ctx)
        .map((entityId) => resolvePlayerEntity(ctx, entityId))
        .filter(Boolean);
}

/** Backward-compatible owner-named alias. */
export function isBotInOwnerWorkFov(ctx) {
    return isBotInAnyPlayerWorkFov(ctx);
}

/** @param {import('./CompanionContext.js').CompanionContext} ctx */
export function isBotInAnyPlayerWorkFov(ctx) {
    if (!isOwnerWorkDeferring(ctx)) return false;
    const botPos = ctx?.bot?.entity?.position;
    if (!botPos) return false;
    const fov = ownerWorkFovDegrees(ctx);
    return getDeferringPlayerEntities(ctx).some((player) => (
        player?.position && isBotInOwnerFov(player, botPos, fov)
    ));
}

/** Backward-compatible owner-named alias. */
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
    return getDeferringPlayerEntities(ctx).some((player) => (
        player?.position && isBotInOwnerFov(player, pos, fov)
    ));
}

/**
 * True when pathing to `targetPos` would enter any active worker's FOV.
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
    const botPos = ctx.bot?.entity?.position;
    for (const player of getDeferringPlayerEntities(ctx)) {
        if (!player?.position || !isBotInOwnerFov(player, targetPos, fov)) continue;
        if (opts.withinPickupRange > 0 && botPos) {
            if (distanceBetween(botPos, targetPos) <= opts.withinPickupRange) continue;
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
 * Maintain a nearby position outside every equipped player's current view.
 * The target is refreshed while equipment remains held so the companion keeps
 * following instead of stopping at the first safe point.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function applyOwnerWorkRetreat(ctx) {
    if (!ownerWorkEnabled(ctx) || !isOwnerWorkDeferring(ctx)) return false;

    const bot = ctx.bot;
    const workers = getDeferringPlayerEntities(ctx);
    if (!bot?.entity || workers.length === 0) return false;
    if (ctx.movement?.isHeld) return false;

    const followDistance = ctx.config?.follow_distance ?? DEFAULT_FOLLOW_DISTANCE;
    const clearance = {
        distance: followDistance,
        fovDegrees: ownerWorkFovDegrees(ctx)
    };
    const isCurrentlyClear = isClearOfAllWorkers(workers, bot.entity.position, clearance);
    const equippedOwnerId = ctx.ownerEntity?.id;
    const ownerNeedsSafeFollow = equippedOwnerId != null
        && workers.some((worker) => worker.id === equippedOwnerId);

    // Other equipped players are avoidance constraints, not follow targets.
    // If the bot is already clear of them, normal owner-follow movement may
    // continue until one of their current view cones actually becomes relevant.
    if (isCurrentlyClear && !ownerNeedsSafeFollow) return false;

    const target = computeSharedWorkYieldTarget(workers, bot.entity.position, {
        ...clearance,
        isPathBlocked: (pos) => wouldPathPassNearPlayer(ctx, pos)
    });
    if (!target) {
        notifyPathBlocked(ctx);
        ctx.movement.stop();
        return true;
    }

    if (
        isCurrentlyClear
        && horizontalDistanceBetween(bot.entity.position, target) <= WORK_POSITION_GOAL_RANGE
    ) {
        ctx.movement.stop();
        return true;
    }

    const directBlocked = wouldPathPassNearPlayer(ctx, target);
    const tooCloseToMove = workers.some((worker) => (
        horizontalDistanceBetween(bot.entity.position, worker.position) <= PLAYER_PUSH_LANE
    ));
    if (directBlocked || tooCloseToMove) {
        notifyPathBlocked(ctx);
        ctx.movement.stop();
        return true;
    }

    ctx.movement.goToward(target, WORK_POSITION_GOAL_RANGE, {
        rejectIf: () => (
            wouldPathPassNearPlayer(ctx, target)
            || !isClearOfAllWorkers(getDeferringPlayerEntities(ctx), target, clearance)
        )
    });
    return true;
}
