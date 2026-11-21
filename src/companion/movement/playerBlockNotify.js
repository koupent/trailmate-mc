const PATH_BLOCK_REARM_MS = 5000;

/**
 * Report one observed blockage until the path has stopped being blocked.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function notifyPathBlocked(ctx) {
    const now = Date.now();
    const previous = ctx.lastPathBlockedAt;
    ctx.lastPathBlockedAt = now;
    if (previous != null && now - previous < PATH_BLOCK_REARM_MS) return;
    ctx.worldState?.observe?.({
        id: 'path_blocked',
        priority: 1,
        text: 'I stopped because I could not find a safe way past nearby players without bumping into them.'
    }, now);
}
