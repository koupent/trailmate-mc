import { sleep } from '../movement/climb.js';

export const DEFAULT_OWN_GRAVE_INTERACT_RANGE = 3.5;

/** Wait for the server to register sneak before block interaction. */
const SNEAK_SETTLE_MS = 50;
/** Wait for GravesX claim processing after right-click. */
const CLAIM_SETTLE_MS = 100;

/**
 * @param {{ interact_range?: number, dig_range?: number } | null | undefined} cfg
 * @returns {number}
 */
export function resolveOwnGraveInteractRange(cfg) {
    return cfg?.interact_range ?? cfg?.dig_range ?? DEFAULT_OWN_GRAVE_INTERACT_RANGE;
}

/**
 * Claim a GravesX grave via sneak + right-click on the grave block.
 * Items are expected to go directly into the bot inventory.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('prismarine-block').Block} block
 */
export async function claimGraveBlock(bot, block) {
    const wasSneaking = bot.getControlState('sneak');
    try {
        bot.setControlState('sneak', true);
        await sleep(SNEAK_SETTLE_MS);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await bot.activateBlock(block);
        await sleep(CLAIM_SETTLE_MS);
    } finally {
        bot.setControlState('sneak', wasSneaking);
    }
}
