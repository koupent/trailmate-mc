import { approachPosition } from './approachPosition.js';
import {
    findNearestDrop,
    scanCompanionAwareness
} from '../../world/companionAwareness.js';
import { isOwnerWorkDeferring } from '../ownerWorkTracker.js';

const DEFAULT_AWARENESS_RADIUS = 10;
/** Close enough for vanilla item magnet / pickup. */
const DEFAULT_APPROACH_RANGE = 0.75;
const DEFAULT_ARRIVAL_SLACK = 0.2;
const DEFAULT_DURATION_MS = 6000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_QUIET_MS = 1500;
const DEFAULT_GRACE_MS = 2500;
/** Pause after arriving so pickup has time to register. */
const PICKUP_SETTLE_MS = 350;
const APPROACH_TIMEOUT_CAP_MS = 4000;

/**
 * Walk toward nearby ground item entities so vanilla pickup can collect them.
 *
 * When `untilClear` is true, keep looting while items are visible, then stop after
 * `quietMs` with no items (after an initial `graceMs` spawn window). Always capped by `durationMs`.
 *
 * No per-item owner exclusion — stay out of the owner's work FOV instead.
 * Aborts mid-loot when the owner starts working (except death/grave recovery).
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
        ?? ctx.config?.awareness_radius
        ?? DEFAULT_AWARENESS_RADIUS;
    const approachRange = options.approachRange ?? DEFAULT_APPROACH_RANGE;
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const untilClear = options.untilClear === true;
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const abortForOwnerWork = () => shouldAbortLootForOwnerWork(ctx);
    const ownerClearance = options.ownerClearance ?? 0;
    const requestedAbort = typeof options.shouldAbort === 'function' ? options.shouldAbort : null;
    const shouldAbort = () => abortForOwnerWork() || requestedAbort?.() === true;
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : null;
    const candidateFilter = typeof options.candidateFilter === 'function'
        ? options.candidateFilter
        : null;
    const ownerExcluded = (entity) => isExcludedNearOwner(ctx, entity.position, ownerClearance);
    const exclude = (entity) => ownerExcluded(entity) || (candidateFilter && !candidateFilter(entity));

    let attempts = 0;
    const start = Date.now();
    let lastSeenAt = start;

    while (Date.now() - start < durationMs) {
        if (!bot.entity || bot.interrupt_code) break;
        if (shouldAbort()) break;

        const origin = options.around || bot.entity.position;
        ctx.invalidateCompanionAwareness?.();
        const snap = typeof ctx.getCompanionAwareness === 'function'
            ? ctx.getCompanionAwareness()
            : scanCompanionAwareness(bot, radius, origin);
        if (typeof options.onItemSeen === 'function') {
            for (const entity of snap.dropItems) {
                if (!ownerExcluded(entity)) options.onItemSeen(entity);
            }
        }
        if (shouldStop?.()) break;
        const candidates = snap.dropItems.filter((entity) => !exclude(entity));
        const item = findNearestDrop(snap, origin, candidates);
        if (!item?.position) {
            if (untilClear) {
                const elapsed = Date.now() - start;
                const quiet = Date.now() - lastSeenAt;
                if (elapsed >= graceMs && quiet >= quietMs) break;
            }
            await sleep(pollMs);
            continue;
        }

        lastSeenAt = Date.now();
        attempts += 1;
        await approachPosition(ctx, item.position, {
            range: approachRange,
            arrivalSlack: DEFAULT_ARRIVAL_SLACK,
            timeoutMs: Math.min(APPROACH_TIMEOUT_CAP_MS, durationMs - (Date.now() - start)),
            pollMs,
            abort: shouldAbort
        });
        if (shouldAbort()) break;
        await sleep(Math.max(pollMs, PICKUP_SETTLE_MS));
    }

    ctx.movement?.stop?.();
    return attempts;
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
    if (clearance <= 0 || !itemPos) return false;
    const owner = ctx?.ownerEntity;
    if (!owner?.position) return false;
    return distanceBetween(owner.position, itemPos) <= clearance;
}

/** @param {{ x: number, y: number, z: number, distanceTo?: Function }} a @param {{ x: number, y: number, z: number }} b */
function distanceBetween(a, b) {
    if (typeof a.distanceTo === 'function') return a.distanceTo(b);
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Owner started mining/placing: yield so Follow can leave their FOV.
 * Death/grave recovery keeps looting.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
function shouldAbortLootForOwnerWork(ctx) {
    if (ctx.deathRecovery?.active || ctx.graveLoot?.active) return false;
    return isOwnerWorkDeferring(ctx);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
