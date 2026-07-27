/**
 * Give inventory / equipment items to a nearby player by tossing.
 * Minecraft has no direct inventory transfer; the player must pick up drops.
 * Equipment is tossed from its slot via tossStack (no unequip — empty unequip hangs ~4s/slot).
 */

const APPROACH_RANGE = 3;
const APPROACH_TIMEOUT_MS = 8000;
const APPROACH_POLL_MS = 250;

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {string} username
 * @returns {Promise<'ok'|'empty'|'unavailable'|'failed'>}
 */
export async function giveAllItemsToPlayer(ctx, username) {
    const bot = ctx?.bot;
    if (!bot?.entity) return 'unavailable';

    const countsBefore = countAllItems(bot);
    if (Object.keys(countsBefore).length === 0) return 'empty';

    const stacks = snapshotOccupiedStacks(bot);
    return giveStacksToPlayer(ctx, username, stacks, { countsBefore, sweepAll: true });
}

/**
 * Toss a specific list of stacks to a nearby player.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {string} username
 * @param {Array<{ slot: number, type: number, count: number, name: string }>} stacks
 * @param {{ countsBefore?: Record<string, number>, sweepAll?: boolean }} [opts]
 * @returns {Promise<'ok'|'empty'|'unavailable'|'failed'>}
 */
export async function giveStacksToPlayer(ctx, username, stacks, opts = {}) {
    const name = String(username || '').trim();
    const bot = ctx?.bot;
    if (!name || !bot?.entity) return 'unavailable';

    const player = bot.players?.[name]?.entity;
    if (!player) return 'unavailable';

    const targetStacks = Array.isArray(stacks) ? stacks : [];
    if (targetStacks.length === 0) return 'empty';

    const countsBefore = opts.countsBefore || countStacks(targetStacks);

    try {
        const reached = await approachPlayer(ctx, player);
        if (!reached) return 'unavailable';

        await bot.lookAt(player.position.offset(0, player.height * 0.9, 0));
        await tossStacks(bot, targetStacks);

        if (opts.sweepAll) {
            await sweepAllRemaining(bot);
        }

        const remaining = countAllItems(bot);
        const anyGiven = Object.keys(countsBefore).some(
            (k) => !remaining[k] || remaining[k] < countsBefore[k]
        );
        if (opts.sweepAll && Object.keys(remaining).length === 0) return 'ok';
        return anyGiven ? 'ok' : 'failed';
    } catch (err) {
        console.warn('[companion] giveStacks failed:', err.message || err);
        return 'failed';
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {Array<{ slot: number, type: number, count: number, name: string }>}
 */
function snapshotOccupiedStacks(bot) {
    return (bot.inventory.slots || [])
        .filter((slot) => slot && slot.name)
        .map((slot) => ({
            slot: slot.slot,
            type: slot.type,
            count: slot.count,
            name: slot.name
        }));
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {Record<string, number>}
 */
export function countAllItems(bot) {
    return countStacks(snapshotOccupiedStacks(bot));
}

/**
 * @param {Array<{ name: string, count: number }>} stacks
 * @returns {Record<string, number>}
 */
function countStacks(stacks) {
    /** @type {Record<string, number>} */
    const inventory = {};
    for (const stack of stacks) {
        if (!stack?.name) continue;
        inventory[stack.name] = (inventory[stack.name] || 0) + stack.count;
    }
    return inventory;
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {import('prismarine-entity').Entity} player
 */
export async function approachPlayer(ctx, player) {
    const bot = ctx.bot;
    const distance = () => bot.entity.position.distanceTo(player.position);
    if (distance() <= APPROACH_RANGE + 1) return true;

    if (ctx.movement?.goToward) {
        ctx.movement.goToward(player.position, APPROACH_RANGE);
    }

    const start = Date.now();
    while (Date.now() - start < APPROACH_TIMEOUT_MS) {
        if (bot.interrupt_code) return false;
        if (!player.position) return false;
        if (distance() <= APPROACH_RANGE + 1) {
            ctx.movement?.stop?.();
            return true;
        }
        ctx.movement?.goToward?.(player.position, APPROACH_RANGE);
        await sleep(APPROACH_POLL_MS);
    }

    ctx.movement?.stop?.();
    return distance() <= APPROACH_RANGE + 2;
}

/**
 * Toss the given stack snapshots (slot indices may shift; resolve live items).
 * @param {import('mineflayer').Bot} bot
 * @param {Array<{ slot: number, type: number, count: number, name: string }>} stacks
 */
export async function tossStacks(bot, stacks) {
    for (const snap of stacks) {
        if (bot.interrupt_code) return;
        const live = resolveLiveStack(bot, snap);
        if (!live) continue;
        await tossOneStack(bot, live);
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 */
async function sweepAllRemaining(bot) {
    let guard = 0;
    while (Object.keys(countAllItems(bot)).length > 0 && guard < 64) {
        if (bot.interrupt_code) break;
        const leftover = (bot.inventory.slots || []).find((slot) => slot && slot.name);
        if (!leftover) break;
        const ok = await tossOneStack(bot, leftover);
        if (!ok) break;
        guard += 1;
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ slot: number, type: number, count: number, name: string }} snap
 */
function resolveLiveStack(bot, snap) {
    const slots = bot.inventory.slots || [];
    const byIndex = slots[snap.slot];
    if (byIndex && byIndex.type === snap.type) return byIndex;
    return slots.find((slot) => slot && slot.type === snap.type && slot.count === snap.count) || null;
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-item').Item} item
 * @returns {Promise<boolean>}
 */
async function tossOneStack(bot, item) {
    try {
        if (typeof bot.tossStack === 'function') {
            await bot.tossStack(item);
        } else {
            await bot.toss(item.type, null, item.count);
        }
        return true;
    } catch (err) {
        console.warn('[companion] tossStack failed:', item.name, err.message || err);
        return false;
    }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
