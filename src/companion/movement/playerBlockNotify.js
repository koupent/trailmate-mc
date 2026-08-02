import { tMovement } from '../../i18n/index.js';

const DEFAULT_COOLDOWN_MS = 5000;

/**
 * Chat once when the companion cannot path past a player without pushing them.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ cooldownMs?: number }} [opts]
 */
export function notifyPathBlocked(ctx, opts = {}) {
    const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const now = Date.now();
    if (!ctx.pathBlockNotify) {
        ctx.pathBlockNotify = { lastAt: 0 };
    }
    if (now - ctx.pathBlockNotify.lastAt < cooldownMs) return false;

    const language = ctx.agent?.language || 'ja';
    const message = tMovement(language, 'path_blocked');
    const bot = ctx.bot;
    if (!bot || typeof bot.chat !== 'function') return false;

    try {
        bot.chat(message);
    } catch {
        return false;
    }
    ctx.pathBlockNotify.lastAt = now;
    return true;
}
