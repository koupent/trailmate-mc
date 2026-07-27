/**
 * Give every inventory / equipment item to a nearby player by tossing.
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
    const name = String(username || '').trim();
    const bot = ctx?.bot;
    if (!name || !bot?.entity) return 'unavailable';

    const player = bot.players?.[name]?.entity;
    if (!player) return 'unavailable';

    const countsBefore = countAllItems(bot);
    if (Object.keys(countsBefore).length === 0) return 'empty';

    try {
        const reached = await approachPlayer(ctx, player);
        if (!reached) return 'unavailable';

        await bot.lookAt(player.position.offset(0, player.height * 0.9, 0));
        await tossAllItems(bot);

        const remaining = countAllItems(bot);
        if (Object.keys(remaining).length === 0) return 'ok';
        // Some items tossed is still a success for the player; leftover means partial fail.
        return Object.keys(countsBefore).some((k) => !remaining[k] || remaining[k] < countsBefore[k])
            ? 'ok'
            : 'failed';
    } catch (err) {
        console.warn('[companion] giveAllItems failed:', err.message || err);
        return 'failed';
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @returns {Record<string, number>}
 */
export function countAllItems(bot) {
    /** @type {Record<string, number>} */
    const inventory = {};
    for (const slot of bot.inventory.slots || []) {
        if (!slot?.name) continue;
        inventory[slot.name] = (inventory[slot.name] || 0) + slot.count;
    }
    return inventory;
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {import('prismarine-entity').Entity} player
 */
async function approachPlayer(ctx, player) {
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
 * Toss every occupied slot, including armor / off-hand / hotbar.
 * Uses tossStack on the concrete item so armor does not need unequip first.
 * @param {import('mineflayer').Bot} bot
 */
async function tossAllItems(bot) {
    const slots = bot.inventory.slots || [];
    // Snapshot occupied slots first; indices change as we toss.
    const stacks = slots.filter((slot) => slot && slot.name).map((slot) => ({
        slot: slot.slot,
        type: slot.type,
        count: slot.count,
        name: slot.name
    }));

    for (const snap of stacks) {
        if (bot.interrupt_code) return;
        const live = resolveLiveStack(bot, snap);
        if (!live) continue;
        await tossOneStack(bot, live);
    }

    // Sweep leftovers from partial updates / races.
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
