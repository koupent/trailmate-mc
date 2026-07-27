/**
 * Shared owner lock helpers for FollowMode and CompanionDialogue.
 */

/**
 * True if the player is in FOV (visiblePlayers) or within owner_near_radius.
 * Used for actions like give-all that should stay near/visible.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {string} username
 */
export function isPlayerEligible(ctx, username) {
    const name = String(username || '').trim();
    if (!name || !ctx?.bot?.entity) return false;

    const visible = ctx.worldState?.visiblePlayers || [];
    if (visible.some((p) => p.name === name)) return true;

    const entity = ctx.bot.players?.[name]?.entity;
    if (!entity) return false;
    const distance = ctx.bot.entity.position.distanceTo(entity.position);
    const near = ctx.config?.owner_near_radius ?? 12;
    return distance <= near;
}

/**
 * Set the follow owner. Returns true when the locked name changed.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {string} username
 */
export function lockOwner(ctx, username) {
    const name = String(username || '').trim();
    if (!name) return false;
    const changed = ctx.ownerName !== name;
    ctx.ownerName = name;
    if (changed) {
        console.log(`[companion] locked owner: ${name}`);
    }
    return changed;
}

/**
 * Fixed-line chat for a new owner lock.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {string} username
 */
export async function notifyOwnerLocked(ctx, username) {
    const name = String(username || '').trim();
    if (!name) return;
    if (ctx.agent?.shut_up) return;
    if (typeof ctx.agent?.openChat !== 'function') return;
    const language = ctx.agent.language || 'ja';
    try {
        const { tCommand } = await import('../i18n/index.js');
        await ctx.agent.openChat(tCommand(language, 'owner_locked', { owner: name }));
    } catch {
        await ctx.agent.openChat(`${name} についていくね`);
    }
}
