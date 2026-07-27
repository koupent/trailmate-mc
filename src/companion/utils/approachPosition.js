/** Shared helpers to walk toward a fixed world position. */

const DEFAULT_RANGE = 2;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_POLL_MS = 250;

/**
 * Walk toward a fixed position until within range or timeout.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} pos
 * @param {{ range?: number, timeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function approachPosition(ctx, pos, options = {}) {
    const bot = ctx?.bot;
    if (!bot?.entity || !pos) return false;

    const range = options.range ?? DEFAULT_RANGE;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

    const distance = () => bot.entity.position.distanceTo(pos);
    if (distance() <= range + 0.5) return true;

    ctx.movement?.goToward?.(pos, range);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (bot.interrupt_code) {
            ctx.movement?.stop?.();
            return false;
        }
        if (!bot.entity) {
            ctx.movement?.stop?.();
            return false;
        }
        if (distance() <= range + 0.5) {
            ctx.movement?.stop?.();
            return true;
        }
        ctx.movement?.goToward?.(pos, range);
        await sleep(pollMs);
    }

    ctx.movement?.stop?.();
    return distance() <= range + 1.5;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
