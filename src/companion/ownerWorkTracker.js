/**
 * Tracks owner mining / placing swings so Follow can step out of the owner's view.
 *
 * States: idle → deferring (while swinging) → cooldown (post_work_cooldown_ms) → idle
 * Looking around alone never triggers — only entitySwingArm from the locked owner.
 */

export const OWNER_WORK_PHASES = Object.freeze({
    idle: 'idle',
    deferring: 'deferring',
    cooldown: 'cooldown'
});

const DEFAULT_SWING_IDLE_MS = 1000;
const DEFAULT_POST_WORK_COOLDOWN_MS = 4000;

/**
 * @typedef {{ phase: 'idle'|'deferring'|'cooldown', until: number, lastSwingAt: number }} OwnerWorkState
 */

/** @returns {OwnerWorkState} */
export function createOwnerWorkState() {
    return {
        phase: OWNER_WORK_PHASES.idle,
        until: 0,
        lastSwingAt: 0
    };
}

/**
 * Subscribe to owner arm swings. Returns a dispose function.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {() => void}
 */
export function attachOwnerWorkTracker(ctx) {
    const bot = ctx.bot;
    const onSwing = (entity) => {
        if (ctx.config?.owner_work?.enabled === false) return;
        const owner = ctx.ownerEntity;
        if (!owner || !entity) return;
        if (entity.id !== owner.id) return;
        noteOwnerSwing(ctx);
    };
    bot.on('entitySwingArm', onSwing);
    return () => {
        bot.off('entitySwingArm', onSwing);
    };
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} [now]
 */
export function noteOwnerSwing(ctx, now = Date.now()) {
    if (ctx.config?.owner_work?.enabled === false) return;
    const state = ctx.ownerWork || (ctx.ownerWork = createOwnerWorkState());
    state.lastSwingAt = now;
    if (state.phase === OWNER_WORK_PHASES.idle || state.phase === OWNER_WORK_PHASES.cooldown) {
        state.phase = OWNER_WORK_PHASES.deferring;
        state.until = 0;
    }
}

/**
 * Advance deferring → cooldown → idle based on swing idle / cooldown timers.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} [now]
 */
export function tickOwnerWork(ctx, now = Date.now()) {
    const cfg = ctx.config?.owner_work || {};
    const state = ctx.ownerWork || (ctx.ownerWork = createOwnerWorkState());

    if (cfg.enabled === false) {
        state.phase = OWNER_WORK_PHASES.idle;
        state.until = 0;
        return;
    }

    const swingIdleMs = cfg.swing_idle_ms ?? DEFAULT_SWING_IDLE_MS;
    const cooldownMs = cfg.post_work_cooldown_ms ?? DEFAULT_POST_WORK_COOLDOWN_MS;

    if (state.phase === OWNER_WORK_PHASES.deferring) {
        if (state.lastSwingAt > 0 && now - state.lastSwingAt >= swingIdleMs) {
            state.phase = OWNER_WORK_PHASES.cooldown;
            state.until = now + cooldownMs;
        }
        return;
    }

    if (state.phase === OWNER_WORK_PHASES.cooldown) {
        if (now >= state.until) {
            state.phase = OWNER_WORK_PHASES.idle;
            state.until = 0;
        }
    }
}

/**
 * True while Follow should stay out of the owner's FOV and loot should not interrupt.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function isOwnerWorkDeferring(ctx) {
    const phase = ctx?.ownerWork?.phase;
    return phase === OWNER_WORK_PHASES.deferring || phase === OWNER_WORK_PHASES.cooldown;
}
