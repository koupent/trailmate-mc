/**
 * Death / respawn recovery state shared via CompanionContext.
 */

/**
 * @typedef {{
 *   pending: boolean,
 *   active: boolean,
 *   deathPos: { x: number, y: number, z: number } | null,
 *   deathDim: string | null,
 *   startedAt: number,
 *   arrivedAt: number,
 *   phase: 'idle' | 'travel' | 'loot' | 'done'
 * }} DeathRecoveryState
 */

/** @returns {DeathRecoveryState} */
export function createDeathRecoveryState() {
    return {
        pending: false,
        active: false,
        deathPos: null,
        deathDim: null,
        startedAt: 0,
        arrivedAt: 0,
        phase: 'idle'
    };
}

/**
 * Snapshot death position and clear stale movement / combat.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function captureDeathState(ctx) {
    const bot = ctx.bot;
    const pos = bot?.entity?.position;
    if (pos) {
        ctx.deathRecovery = {
            ...createDeathRecoveryState(),
            pending: true,
            deathPos: { x: pos.x, y: pos.y, z: pos.z },
            deathDim: bot.game?.dimension ?? null
        };
    } else if (ctx.deathRecovery) {
        ctx.deathRecovery.pending = true;
        ctx.deathRecovery.active = false;
        ctx.deathRecovery.phase = 'idle';
    }

    try {
        ctx.movement?.stop?.();
    } catch {
        /* ignore */
    }
    try {
        bot?.pvp?.stop?.();
    } catch {
        /* ignore */
    }
    if (pos && ctx.stuck?.reset) {
        ctx.stuck.reset(pos);
    }
    ctx.holdReflexes = true;
}

/**
 * Activate death-return after respawn when config allows it.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {object} [config]
 */
export function beginDeathReturnAfterSpawn(ctx, config = ctx.config) {
    const enabled = config?.death_return?.enabled !== false;
    const dr = ctx.deathRecovery;
    if (!enabled || !dr?.pending || !dr.deathPos) {
        ctx.holdReflexes = false;
        return false;
    }

    dr.pending = false;
    dr.active = true;
    dr.startedAt = Date.now();
    dr.arrivedAt = 0;
    dr.phase = 'travel';
    ctx.holdReflexes = true;

    if (ctx.stuck?.reset && ctx.bot?.entity?.position) {
        ctx.stuck.reset(ctx.bot.entity.position);
    }
    return true;
}

/**
 * Clear death-return so normal modes resume.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function clearDeathReturn(ctx) {
    ctx.deathRecovery = createDeathRecoveryState();
    if (!ctx.graveLoot?.active) {
        ctx.holdReflexes = false;
    }
}
