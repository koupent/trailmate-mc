import { approachPosition } from './approachPosition.js';
import { scanSurroundings } from '../movement/surroundings.js';
import {
    dropDistanceFrom,
    findNearestDrop,
    scanCompanionAwareness
} from '../../world/companionAwareness.js';
import {
    applyOwnerWorkRetreat,
    getDeferringPlayerEntities,
    isBotInOwnerWorkFov,
    isPositionInOwnerWorkFov,
    wouldEnterOwnerWorkFov
} from '../ownerWorkMovement.js';
import { isOwnerWorkDeferring } from '../ownerWorkTracker.js';
import { hasActiveLootPickupPriority } from '../deathRecovery.js';

const DEFAULT_AWARENESS_RADIUS = 10;
/** Close enough for vanilla item magnet / pickup (horizontal). */
export const DEFAULT_APPROACH_RANGE = 1.0;
const DEFAULT_ARRIVAL_SLACK = 0.25;
/** Items within this distance can be collected without crossing into owner FOV. */
export const PICKUP_MAGNET_RANGE = DEFAULT_APPROACH_RANGE + DEFAULT_ARRIVAL_SLACK;
const DEFAULT_DURATION_MS = 6000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_GRACE_MS = 2500;
/** Pause after arriving so pickup has time to register. */
const PICKUP_SETTLE_MS = 350;
const DEFAULT_OWNER_WORK_LOOT_CLEARANCE = 4;
/** Item Y this far below the bot's feet needs a step-down approach, not magnet pickup. */
const ITEM_BELOW_FEET_DY = 0.4;

/**
 * Walk toward nearby ground item entities so vanilla pickup can collect them.
 *
 * When `untilClear` is true, keep looting while items are visible, then stop after
 * `quietMs` with no items (after an initial `graceMs` spawn window). Always capped by `durationMs`.
 *
 * Pickup stays active during owner work. Movement avoids entering the owner's FOV.
 *
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{
 *   radius?: number,
 *   approachRange?: number,
 *   durationMs?: number,
 *   pollMs?: number,
 *   untilClear?: boolean,
 *   quietMs?: number,
 *   graceMs?: number,
 *   ownerClearance?: number,
 *   around?: { x: number, y: number, z: number },
 *   onItemSeen?: (entity: any) => void,
 *   shouldAbort?: () => boolean,
 *   candidateFilter?: (entity: any) => boolean,
 *   shouldStop?: () => boolean
 * }} [options]
 * @returns {Promise<number>} number of approach attempts
 */
export async function pickupNearbyItems(ctx, options = {}) {
    const bot = ctx?.bot;
    if (!bot?.entity) return 0;

    const radius = options.radius
        ?? resolvePickupRadius(ctx);
    const approachRange = options.approachRange ?? DEFAULT_APPROACH_RANGE;
    const magnetRange = approachRange + DEFAULT_ARRIVAL_SLACK;
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const untilClear = options.untilClear === true;
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const ownerClearance = options.ownerClearance ?? 0;
    const requestedAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
    const shouldAbort = () => requestedAbort?.() === true;
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
    const candidateFilter = typeof options.candidateFilter === 'function'
        ? options.candidateFilter
        : null;
    const exclude = buildPickupExclude(ctx, {
        ownerClearance,
        magnetRange,
        candidateFilter
    });
    const ownerExcluded = (entity) => isExcludedNearOwner(ctx, entity.position, ownerClearance);

    let attempts = 0;
    const start = Date.now();
    let lastSeenAt = start;
    /** @type {number|string|null} */
    let lastTargetKey = null;

    while (Date.now() - start < durationMs) {
        if (!bot.entity || bot.interrupt_code) break;
        if (shouldAbort()) break;

        // 固定起点がない場合はBot基準で追跡し、走査ごとに起点を更新する。
        const origin = options.around || bot.entity.position;
        ctx.invalidateCompanionAwareness?.();
        const snap = options.around
            ? scanCompanionAwareness(bot, radius, origin)
            : (typeof ctx.getCompanionAwareness === 'function'
                ? ctx.getCompanionAwareness()
                : scanCompanionAwareness(bot, radius, origin));
        if (typeof options.onItemSeen === 'function') {
            for (const entity of snap.dropItems) {
                if (!ownerExcluded(entity)) options.onItemSeen(entity);
            }
        }
        if (shouldStop?.()) break;

        const candidates = snap.dropItems.filter((entity) => !exclude(entity));

        if (
            candidates.length === 0
            && snap.dropItems.length > 0
            && !ctx.deathRecovery?.active
            && !ctx.graveLoot?.active
        ) {
            break;
        }

        if (isBotInOwnerWorkFov(ctx) && !hasMagnetPickup(candidates, bot.entity.position, magnetRange)) {
            const holdItem = findNearestDrop(snap, bot.entity.position, candidates);
            const itemOutsideWorkFov = holdItem?.position
                && !isPositionInOwnerWorkFov(ctx, holdItem.position);
            if (!itemOutsideWorkFov) {
                applyOwnerWorkRetreat(ctx);
                await sleep(pollMs);
                continue;
            }
        }

        const item = findNearestDrop(snap, bot.entity.position, candidates);
        if (!item?.position) {
            lastTargetKey = null;
            ctx.movement?.stop?.();
            if (
                snap.dropItems.length === 0
                && !ctx.deathRecovery?.active
                && !ctx.graveLoot?.active
            ) {
                break;
            }
            if (untilClear) {
                const elapsed = Date.now() - start;
                const quiet = Date.now() - lastSeenAt;
                if (elapsed >= graceMs && quiet >= quietMs) break;
            }
            await sleep(pollMs);
            continue;
        }

        lastSeenAt = Date.now();
        const itemDist = dropDistanceFrom(bot.entity.position, item.position);
        const verticalGap = item.position.y - bot.entity.position.y;
        const inMagnetRange = isWithinMagnetPickup(bot.entity.position, item.position, magnetRange);
        const targetKey = item.id ?? item;

        const needsStepDown = verticalGap < -ITEM_BELOW_FEET_DY;

        if (inMagnetRange) {
            ctx.movement?.stop?.();
            lastTargetKey = null;
            await sleep(Math.max(pollMs, PICKUP_SETTLE_MS));
            continue;
        }

        if (targetKey !== lastTargetKey) {
            attempts += 1;
            lastTargetKey = targetKey;
        }
        const approachTarget = {
            x: item.position.x,
            y: item.position.y,
            z: item.position.z
        };
        const approachAbort = () => {
            if (shouldAbort()) return true;
            if (!bot.entity) return true;
            if (isWithinMagnetPickup(bot.entity.position, item.position, magnetRange)) {
                return true;
            }
            ctx.invalidateCompanionAwareness?.();
            const freshSnap = typeof ctx.getCompanionAwareness === 'function'
                ? ctx.getCompanionAwareness()
                : scanCompanionAwareness(bot, radius, bot.entity.position);
            const freshCandidates = freshSnap.dropItems.filter((entity) => !exclude(entity));
            if (!freshCandidates.some((entity) => (entity.id ?? entity) === targetKey)) {
                return true;
            }
            const nearer = findNearestDrop(freshSnap, bot.entity.position, freshCandidates);
            if (!nearer?.position || (nearer.id ?? nearer) === targetKey) return false;
            const nearerDist = dropDistanceFrom(bot.entity.position, nearer.position);
            return nearerDist + 1.5 < dropDistanceFrom(bot.entity.position, item.position);
        };
        const approachTimeoutMs = Math.max(
            600,
            Math.min(
                needsStepDown ? 3500 : (itemDist <= 4 ? 2000 : 4000),
                durationMs - (Date.now() - start)
            )
        );
        if (needsStepDown) {
            await approachDropBelowFeet(ctx, approachTarget, {
                magnetRange,
                timeoutMs: approachTimeoutMs,
                pollMs,
                abort: approachAbort
            });
        } else {
            await approachPosition(ctx, approachTarget, {
                range: magnetRange,
                pathRange: magnetRange,
                horizontalArrival: true,
                arrivalSlack: 0,
                timeoutMs: approachTimeoutMs,
                pollMs,
                abort: approachAbort
            });
        }
        if (shouldAbort()) break;
    }

    ctx.movement?.stop?.();
    return attempts;
}

export function hasNearbyDrops(ctx) {
    const bot = ctx?.bot;
    if (!bot?.entity?.position) return false;
    const radius = resolvePickupRadius(ctx);
    return hasNearbyDropsAt(ctx, bot.entity.position, radius);
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} origin
 * @param {number} radius
 */
export function hasNearbyDropsAt(ctx, origin, radius) {
    const bot = ctx?.bot;
    if (!bot?.entity || !origin) return false;
    ctx.invalidateCompanionAwareness?.();
    const snap = scanCompanionAwareness(bot, radius, origin);
    const exclude = buildPickupExclude(ctx, { magnetRange: PICKUP_MAGNET_RANGE });
    return snap.dropItems.some((entity) => !exclude(entity));
}

/**
 * 墓・死亡地点の優先回収対象がまだ地上に残っているか。
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {number} [now]
 */
export function hasPriorityLootNearby(ctx, now = Date.now()) {
    if (!hasActiveLootPickupPriority(ctx, now)) return false;
    const radius = ctx.config?.nearby_loot?.recovery_radius ?? 12;
    return hasNearbyDropsAt(ctx, ctx.nearbyLoot.priorityOrigin, radius);
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{
 *   ownerClearance?: number,
 *   magnetRange?: number,
 *   candidateFilter?: (entity: any) => boolean
 * }} [options]
 */
export function buildPickupExclude(ctx, options = {}) {
    const ownerClearance = options.ownerClearance ?? 0;
    const magnetRange = options.magnetRange ?? PICKUP_MAGNET_RANGE;
    const candidateFilter = options.candidateFilter ?? null;
    return (entity) => {
        if (!entity?.position) return true;
        if (isExcludedNearOwner(ctx, entity.position, ownerClearance)) return true;
        if (candidateFilter && !candidateFilter(entity)) return true;
        if (shouldExcludePickupDuringOwnerWork(ctx, entity.position, magnetRange)) return true;
        return wouldEnterOwnerWorkFov(ctx, entity.position, { withinPickupRange: magnetRange });
    };
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function resolveOwnerWorkLootClearance(ctx) {
    const explicit = ctx?.config?.nearby_loot?.owner_clearance;
    if (typeof explicit === 'number' && explicit > 0) return explicit;
    const work = ctx?.config?.owner_work?.loot_clearance;
    if (typeof work === 'number' && work > 0) return work;
    const follow = ctx?.config?.follow_distance;
    if (typeof follow === 'number' && follow > 0) return follow + 1;
    return DEFAULT_OWNER_WORK_LOOT_CLEARANCE;
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} itemPos
 * @param {number} magnetRange
 */
function shouldExcludePickupDuringOwnerWork(ctx, itemPos, _magnetRange) {
    if (!isOwnerWorkDeferring(ctx)) return false;
    if (ctx?.deathRecovery?.active || ctx?.graveLoot?.active) return false;
    return isPositionInOwnerWorkFov(ctx, itemPos);
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function resolvePickupRadius(ctx) {
    const awareness = ctx?.config?.awareness_radius ?? DEFAULT_AWARENESS_RADIUS;
    const loot = ctx?.config?.nearby_loot?.radius;
    if (typeof loot === 'number' && loot > 0) {
        return Math.max(awareness, loot);
    }
    return awareness;
}

/**
 * @param {any[]} candidates
 * @param {{ x: number, y: number, z: number, distanceTo?: Function }} botPos
 * @param {number} magnetRange
 */
function hasMagnetPickup(candidates, botPos, magnetRange) {
    return candidates.some((entity) =>
        entity?.position
        && isWithinMagnetPickup(botPos, entity.position, magnetRange)
    );
}

/**
 * Walk toward a drop that sits below the bot's feet (ledge pickup).
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} itemPos
 * @param {{ magnetRange: number, timeoutMs: number, pollMs: number, abort: () => boolean }} options
 */
async function approachDropBelowFeet(ctx, itemPos, options) {
    const bot = ctx?.bot;
    if (!bot?.entity) return false;

    const { magnetRange, timeoutMs, pollMs, abort } = options;
    const scan = scanSurroundings(bot, itemPos);
    const stepDown = scan.stepDowns?.[0];
    if (stepDown?.center) {
        await approachPosition(ctx, stepDown.center, {
            range: 0.6,
            pathRange: 1,
            horizontalArrival: false,
            arrivalSlack: 0.2,
            timeoutMs: Math.min(timeoutMs, 2000),
            pollMs,
            abort
        });
        if (abort()) return false;
    }

    return approachPosition(ctx, itemPos, {
        range: magnetRange * 0.5,
        pathRange: Math.max(magnetRange, 1.5),
        horizontalArrival: false,
        arrivalSlack: 0.15,
        timeoutMs,
        pollMs,
        abort
    });
}

/**
 * Horizontal closeness alone is not enough when the item sits below the bot's feet.
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{ x: number, y: number, z: number }} itemPos
 * @param {number} magnetRange
 */
export function isWithinMagnetPickup(botPos, itemPos, magnetRange) {
    const horizontal = dropDistanceFrom(botPos, itemPos);
    if (horizontal > magnetRange) return false;
    const verticalGap = itemPos.y - botPos.y;
    if (verticalGap < -ITEM_BELOW_FEET_DY) return false;
    return true;
}

/**
 * Skip drops near the owner only when a caller explicitly requests clearance.
 * Recovery and grave collection always keep full access to their targets.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} itemPos
 * @param {number} clearance
 */
export function isExcludedNearOwner(ctx, itemPos, clearance) {
    if (ctx?.deathRecovery?.active || ctx?.graveLoot?.active) return false;
    if (!itemPos) return false;

    let effectiveClearance = clearance;
    if (effectiveClearance <= 0 && isOwnerWorkDeferring(ctx)) {
        effectiveClearance = resolveOwnerWorkLootClearance(ctx);
    }
    if (effectiveClearance > 0) {
        for (const player of getDeferringPlayerEntities(ctx)) {
            if (player?.position && horizontalDistanceBetween(player.position, itemPos) <= effectiveClearance) {
                return true;
            }
        }
    }
    if (clearance > 0) {
        const owner = ctx?.ownerEntity;
        if (owner?.position && horizontalDistanceBetween(owner.position, itemPos) <= clearance) {
            return true;
        }
    }
    return false;
}

/** @param {{ x: number, y: number, z: number, distanceTo?: Function }} a @param {{ x: number, y: number, z: number }} b */
function horizontalDistanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
