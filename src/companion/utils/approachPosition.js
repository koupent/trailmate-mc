/** Shared helpers to walk toward a fixed world position. */

const DEFAULT_RANGE = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_POLL_MS = 250;

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function horizontalDistance(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Walk toward a fixed position until within range or timeout.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} pos
 * @param {{
 *   range?: number,
 *   pathRange?: number,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   arrivalSlack?: number,
 *   horizontalArrival?: boolean,
 *   abort?: () => boolean
 * }} [options]
 * @returns {Promise<boolean>}
 */
export async function approachPosition(ctx, pos, options = {}) {
    const bot = ctx?.bot;
    if (!bot?.entity || !pos) return false;

    const range = options.range ?? DEFAULT_RANGE;
    const pathRange = options.pathRange ?? range;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const arrivalSlack = options.arrivalSlack ?? 0.5;
    const horizontalArrival = options.horizontalArrival === true;
    const shouldAbort = typeof options.abort === 'function' ? options.abort : null;
    const distanceTo = (from) => (
        horizontalArrival
            ? horizontalDistance(from, pos)
            : from.distanceTo(pos)
    );
    const arrived = () => distanceTo(bot.entity.position) <= range + arrivalSlack;

    if (arrived()) return true;

    ctx.movement?.goToward?.(pos, pathRange);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (shouldAbort?.()) {
            ctx.movement?.stop?.();
            return false;
        }
        if (bot.interrupt_code) {
            ctx.movement?.stop?.();
            return false;
        }
        if (!bot.entity) {
            ctx.movement?.stop?.();
            return false;
        }
        if (arrived()) {
            ctx.movement?.stop?.();
            return true;
        }
        ctx.movement?.goToward?.(pos, pathRange);
        await sleep(pollMs);
    }

    ctx.movement?.stop?.();
    const finalDist = bot.entity ? distanceTo(bot.entity.position) : Infinity;
    return finalDist <= range + Math.max(arrivalSlack, horizontalArrival ? 0.25 : 1);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
