import { getNearestGroundItem, isGroundItem } from '../../world/entities.js';
import { approachPosition } from './approachPosition.js';

const DEFAULT_LOOT_RADIUS = 5;
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
 * Count ground-item entities within radius of a point.
 * @param {any} bot
 * @param {number} radius
 * @param {{ x: number, y: number, z: number }} around
 */
export function countGroundItemsNear(bot, radius, around) {
    if (!bot || !around) return 0;
    let count = 0;
    for (const entity of Object.values(bot.entities || {})) {
        if (!isGroundItem(entity) || !entity.position) continue;
        const dx = entity.position.x - around.x;
        const dy = entity.position.y - around.y;
        const dz = entity.position.z - around.z;
        if (Math.hypot(dx, dy, dz) <= radius) count += 1;
    }
    return count;
}

/**
 * Walk toward nearby ground item entities so vanilla pickup can collect them.
 *
 * When `untilClear` is true, keep looting while items are visible, then stop after
 * `quietMs` with no items (after an initial `graceMs` spawn window). Always capped by `durationMs`.
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
 *   around?: { x: number, y: number, z: number }
 * }} [options]
 * @returns {Promise<number>} number of approach attempts
 */
export async function pickupNearbyItems(ctx, options = {}) {
    const bot = ctx?.bot;
    if (!bot?.entity) return 0;

    const radius = options.radius ?? DEFAULT_LOOT_RADIUS;
    const approachRange = options.approachRange ?? DEFAULT_APPROACH_RANGE;
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const untilClear = options.untilClear === true;
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

    let attempts = 0;
    const start = Date.now();
    let lastSeenAt = start;

    while (Date.now() - start < durationMs) {
        if (!bot.entity || bot.interrupt_code) break;

        // Chase relative to bot when no fixed around — keep origin fresh each poll.
        const origin = options.around || bot.entity.position;
        const item = getNearestGroundItem(bot, radius, origin);
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
            pollMs
        });
        await sleep(Math.max(pollMs, PICKUP_SETTLE_MS));
    }

    ctx.movement?.stop?.();
    return attempts;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
