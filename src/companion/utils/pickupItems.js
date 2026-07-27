import { getNearestGroundItem } from '../../world/entities.js';
import { approachPosition } from './approachPosition.js';

const DEFAULT_LOOT_RADIUS = 5;
const DEFAULT_APPROACH_RANGE = 1.5;
const DEFAULT_DURATION_MS = 6000;
const DEFAULT_POLL_MS = 250;

/**
 * Walk toward nearby ground item entities so vanilla pickup can collect them.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{
 *   radius?: number,
 *   approachRange?: number,
 *   durationMs?: number,
 *   pollMs?: number,
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
    const around = options.around || bot.entity.position;

    let attempts = 0;
    const start = Date.now();
    while (Date.now() - start < durationMs) {
        if (!bot.entity || bot.interrupt_code) break;

        const item = getNearestGroundItem(bot, radius, around);
        if (!item?.position) {
            await sleep(pollMs);
            continue;
        }

        attempts += 1;
        await approachPosition(ctx, item.position, {
            range: approachRange,
            timeoutMs: Math.min(4000, durationMs - (Date.now() - start)),
            pollMs
        });
        await sleep(pollMs);
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
