/** Known 1.21+/Via step-up workaround (mineflayer#3911). Needs OP to apply. */
const TARGET_SCALE = 0.9999999;

/**
 * Ensure minecraft:scale is slightly below 1 so 1-block steps work on Via/1.21+.
 * No public chat spam: only console logs. Re-applies on each spawn when the bot is OP.
 * @param {import('mineflayer').Bot} bot
 */
export async function applyJumpHitboxFix(bot) {
    await sleep(300);

    if (isGoodScale(readScale(bot))) {
        console.log(`[companion] jump hitbox fix already OK (scale=${readScale(bot)})`);
        return true;
    }

    const cmd = `/attribute ${bot.username} minecraft:scale base set ${TARGET_SCALE}`;
    try {
        bot.chat(cmd);
        console.log(`[companion] requested scale fix: ${cmd}`);
    } catch (err) {
        console.warn('[companion] scale command failed:', err.message || err);
    }

    await sleep(700);

    const applied = readScale(bot);
    if (isGoodScale(applied)) {
        console.log(`[companion] jump hitbox fix OK (scale=${applied})`);
        return true;
    }

    console.warn(
        '[companion] scale fix not applied (bot needs OP, or run from console once): '
        + `attribute ${bot.username} minecraft:scale base set ${TARGET_SCALE}`
    );
    return false;
}

export function isGoodScale(value) {
    return typeof value === 'number' && value > 0.9 && value < 1.0;
}

export function readScale(bot) {
    const attrs = bot.entity?.attributes;
    if (!attrs) return null;
    const entry = attrs['minecraft:scale']
        || attrs['minecraft:generic.scale']
        || attrs['generic.scale'];
    if (entry == null) return null;
    if (typeof entry === 'number') return entry;
    if (typeof entry.value === 'number') return entry.value;
    if (typeof entry.base === 'number') return entry.base;
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
