/**
 * Tracks player mining so movement stays out of their view.
 *
 * States per player: idle → deferring (while breaking blocks) → cooldown → idle
 *
 * Arm swings alone do NOT count as work — item drops (Q) also emit entitySwingArm.
 * Only blockBreakProgressObserved enters deferring.
 */

export const OWNER_WORK_PHASES = Object.freeze({
    idle: 'idle',
    deferring: 'deferring',
    cooldown: 'cooldown'
});

const DEFAULT_SWING_IDLE_MS = 1000;
const DEFAULT_POST_WORK_COOLDOWN_MS = 4000;

/**
 * @typedef {{
 *   phase: 'idle'|'deferring'|'cooldown',
 *   until: number,
 *   lastBreakProgressAt: number
 * }} OwnerWorkState
 */

/** @returns {OwnerWorkState} */
export function createOwnerWorkState() {
    return {
        phase: OWNER_WORK_PHASES.idle,
        until: 0,
        lastBreakProgressAt: 0
    };
}

/** @param {import('./CompanionContext.js').CompanionContext} ctx */
function getPlayerWorkMap(ctx) {
    if (!ctx.playerWorkById) {
        ctx.playerWorkById = new Map();
    }
    return ctx.playerWorkById;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} entityId
 */
function getOrCreatePlayerWork(ctx, entityId) {
    const map = getPlayerWorkMap(ctx);
    let state = map.get(entityId);
    if (!state) {
        state = createOwnerWorkState();
        map.set(entityId, state);
    }
    return state;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ id?: number, type?: string, name?: string }} entity
 */
function shouldTrackPlayerWork(ctx, entity) {
    if (!entity?.id) return false;
    const bot = ctx.bot;
    if (bot?.entity?.id === entity.id) return false;
    if (ctx.config?.owner_work?.all_players === false) {
        const owner = ctx.ownerEntity;
        return Boolean(owner && entity.id === owner.id);
    }
    return isPlayerEntity(entity, bot);
}

/**
 * @param {{ id?: number, type?: string, name?: string }} entity
 * @param {import('mineflayer').Bot} [bot]
 */
function isPlayerEntity(entity, bot) {
    if (!entity) return false;
    if (entity.type === 'player' || entity.name === 'player') return true;
    if (!bot) return false;
    for (const name of Object.keys(bot.players || {})) {
        if (bot.players[name]?.entity?.id === entity.id) return true;
    }
    return false;
}

/**
 * Subscribe to block-break progress from players. Returns a dispose function.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {() => void}
 */
export function attachOwnerWorkTracker(ctx) {
    const bot = ctx.bot;
    const onBreakProgress = (_block, stage, entity) => {
        if (ctx.config?.owner_work?.enabled === false) return;
        if (!entity || stage < 0) return;
        if (!shouldTrackPlayerWork(ctx, entity)) return;
        notePlayerBlockBreakProgress(ctx, entity);
    };

    bot.on('blockBreakProgressObserved', onBreakProgress);
    return () => {
        bot.off('blockBreakProgressObserved', onBreakProgress);
    };
}

/**
 * Definite mining / digging — enters deferring.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ id: number }} entity
 * @param {number} [now]
 */
export function notePlayerBlockBreakProgress(ctx, entity, now = Date.now()) {
    if (ctx.config?.owner_work?.enabled === false) return;
    if (!shouldTrackPlayerWork(ctx, entity)) return;
    if (!entity?.id) return;
    const state = getOrCreatePlayerWork(ctx, entity.id);
    state.lastBreakProgressAt = now;
    state.phase = OWNER_WORK_PHASES.deferring;
    state.until = 0;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} [now]
 */
export function tickOwnerWork(ctx, now = Date.now()) {
    const cfg = ctx.config?.owner_work || {};
    const map = getPlayerWorkMap(ctx);

    if (cfg.enabled === false) {
        map.clear();
        return;
    }

    const swingIdleMs = cfg.swing_idle_ms ?? DEFAULT_SWING_IDLE_MS;
    const cooldownMs = cfg.post_work_cooldown_ms ?? DEFAULT_POST_WORK_COOLDOWN_MS;

    for (const [entityId, state] of map) {
        if (state.phase === OWNER_WORK_PHASES.deferring) {
            if (state.lastBreakProgressAt > 0 && now - state.lastBreakProgressAt >= swingIdleMs) {
                state.phase = OWNER_WORK_PHASES.cooldown;
                state.until = now + cooldownMs;
            }
            continue;
        }

        if (state.phase === OWNER_WORK_PHASES.cooldown) {
            if (now >= state.until) {
                map.delete(entityId);
            }
            continue;
        }

        map.delete(entityId);
    }
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {number[]}
 */
export function getDeferringPlayerIds(ctx) {
    const map = ctx.playerWorkById;
    if (!map?.size) return [];
    const ids = [];
    for (const [entityId, state] of map) {
        if (state.phase === OWNER_WORK_PHASES.deferring || state.phase === OWNER_WORK_PHASES.cooldown) {
            ids.push(entityId);
        }
    }
    return ids;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function isOwnerWorkDeferring(ctx) {
    return getDeferringPlayerIds(ctx).length > 0;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} entityId
 * @param {'idle'|'deferring'|'cooldown'} phase
 * @param {number} [now]
 */
export function seedPlayerWorkPhase(ctx, entityId, phase, now = Date.now()) {
    if (phase === OWNER_WORK_PHASES.idle) {
        ctx.playerWorkById?.delete(entityId);
        return;
    }
    const state = getOrCreatePlayerWork(ctx, entityId);
    state.phase = phase;
    state.lastBreakProgressAt = phase === OWNER_WORK_PHASES.deferring ? now : 0;
    if (phase === OWNER_WORK_PHASES.cooldown) {
        const cooldownMs = ctx.config?.owner_work?.post_work_cooldown_ms ?? DEFAULT_POST_WORK_COOLDOWN_MS;
        state.until = now + cooldownMs;
    } else {
        state.until = 0;
    }
}
