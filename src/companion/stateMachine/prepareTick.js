/**
 * Shared pre-tick work previously done at the start of ModeManager.tick.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
import { tickOwnerWork } from '../ownerWorkTracker.js';

export async function prepareCompanionWorldTick(ctx) {
    ctx.invalidateCompanionAwareness?.();
    tickOwnerWork(ctx);
    ctx.worldState.update(ctx);
    ctx.stuck.update(ctx.bot, ctx.movement.isTryingToMove ?? ctx.movement.hasGoal);
    const detectSec = ctx.config?.stuck_detect_seconds ?? 1.5;
    if (ctx.stuck.seconds >= detectSec) {
        ctx.stuckChat = {
            seconds: Number(ctx.stuck.seconds.toFixed(1)),
            at: Date.now()
        };
    }
    // Normal states only observe/open passages. Confirmed closing belongs to
    // the explicit passage_cleanup FSM state.
    await ctx.doors?.tick({ allowClose: false });
}
