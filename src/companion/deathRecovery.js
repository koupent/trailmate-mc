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
 *   phase: 'idle' | 'travel' | 'grave' | 'items' | 'equip' | 'done',
 *   arrivedAt: number,
 *   graveBrokenAt: number,
 *   collectionStartedAt: number,
 *   collectionSource: 'grave' | 'death-site' | null,
 *   collectionOrigin: { x: number, y: number, z: number } | null,
 *   ownedItemIds: number[],
 *   preexistingItemIds: number[],
 *   collectionSnapshotInitialized: boolean,
 *   collectionCaptureUntil: number,
 *   collectionDeadlineAt: number,
 *   collectionQuietSince: number,
 *   ownedItemIdsFrozen: boolean,
 *   emergencyUntil: number,
 *   emergencyCooldownUntil: number
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
        phase: 'idle',
        arrivedAt: 0,
        graveBrokenAt: 0,
        collectionStartedAt: 0,
        collectionSource: null,
        collectionOrigin: null,
        ownedItemIds: [],
        preexistingItemIds: [],
        collectionSnapshotInitialized: false,
        collectionCaptureUntil: 0,
        collectionDeadlineAt: 0,
        collectionQuietSince: 0,
        ownedItemIdsFrozen: false,
        emergencyUntil: 0,
        emergencyCooldownUntil: 0
    };
}

/**
 * Release combat hold when no recovery interrupt is still active.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function releaseHoldReflexesIfIdle(ctx) {
    if (!ctx.graveLoot?.active && !ctx.nearbyLoot?.active && !ctx.deathRecovery?.active) {
        ctx.holdReflexes = false;
    }
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
    // Spawn activates Recovery ownership; only bounded emergency survival may interrupt it.
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
    dr.phase = 'travel';
    // Recovery owns the strategic destination until collection and re-equip finish.
    ctx.holdReflexes = true;

    if (ctx.stuck?.reset && ctx.bot?.entity?.position) {
        ctx.stuck.reset(ctx.bot.entity.position);
    }
    return true;
}

/** Retain Recovery ownership after reaching the death site. */
export function markDeathReturnArrived(ctx, now = Date.now()) {
    const dr = ctx.deathRecovery;
    if (!dr?.active) return false;
    dr.phase = 'grave';
    dr.arrivedAt = now;
    dr.collectionOrigin = dr.deathPos ? { ...dr.deathPos } : null;
    ctx.holdReflexes = true;
    return true;
}

/** Configure the shared ItemCollection capability for this recovery mission. */
export function requestRecoveryItemCollection(
    ctx,
    position,
    now = Date.now(),
    source = 'death-site',
    options = {}
) {
    const dr = ctx.deathRecovery;
    if (!dr?.active) return false;
    const cfg = ctx.config?.nearby_loot || {};
    // Even a configured zero keeps one scan opportunity before freezing IDs.
    const captureMs = Math.max(1, cfg.recovery_capture_ms ?? 1000);
    const deadlineMs = Math.max(captureMs, cfg.recovery_deadline_ms ?? 12000);
    dr.phase = 'items';
    // These timestamps belong to the recovery mission. Emergency survival can
    // pause collection, but retries must never extend the absolute deadline.
    if (!dr.collectionStartedAt) dr.collectionStartedAt = now;
    if (!dr.collectionCaptureUntil) dr.collectionCaptureUntil = now + captureMs;
    if (!dr.collectionDeadlineAt) dr.collectionDeadlineAt = now + deadlineMs;
    if (!dr.collectionSnapshotInitialized) {
        dr.preexistingItemIds = uniqueFiniteIds(options.preexistingItemIds || []);
        dr.collectionSnapshotInitialized = true;
    }
    if (!Array.isArray(dr.ownedItemIds)) dr.ownedItemIds = [];
    dr.ownedItemIdsFrozen = false;
    dr.collectionQuietSince = 0;
    dr.collectionSource = source === 'grave' ? 'grave' : 'death-site';
    if (source === 'grave') dr.graveBrokenAt = now;
    dr.collectionOrigin = position
        ? { x: position.x, y: position.y, z: position.z }
        : (dr.collectionOrigin || dr.deathPos);
    ctx.holdReflexes = true;
    return true;
}

/** Track items observed by the common collector around the recovery origin. */
export function trackRecoveryItem(ctx, entity, now = Date.now()) {
    const dr = ctx.deathRecovery;
    const id = Number(entity?.id);
    if (!dr?.active || dr.phase !== 'items' || !Number.isFinite(id)) return false;
    if (dr.ownedItemIdsFrozen || now > (dr.collectionCaptureUntil || 0)) return false;
    if ((dr.preexistingItemIds || []).includes(id)) return false;
    if (!dr.ownedItemIds.includes(id)) dr.ownedItemIds.push(id);
    return true;
}

/**
 * Freeze the grave-drop snapshot and report progress without considering
 * unrelated nearby items. Missing IDs mean either collected or despawned.
 */
export function observeRecoveryItemCollection(ctx, now = Date.now()) {
    const dr = ctx.deathRecovery;
    if (!dr?.active || dr.phase !== 'items') return null;
    if (!dr.ownedItemIdsFrozen && now >= (dr.collectionCaptureUntil || 0)) {
        dr.ownedItemIdsFrozen = true;
    }
    const remainingIds = (dr.ownedItemIds || []).filter((id) => Boolean(ctx.bot?.entities?.[id]));
    if (dr.ownedItemIdsFrozen && remainingIds.length === 0) {
        if (!dr.collectionQuietSince) dr.collectionQuietSince = now;
    } else {
        dr.collectionQuietSince = 0;
    }
    return {
        captureComplete: Boolean(dr.ownedItemIdsFrozen),
        deadlineReached: now >= (dr.collectionDeadlineAt || now),
        remainingIds,
        quietForMs: dr.collectionQuietSince ? Math.max(0, now - dr.collectionQuietSince) : 0
    };
}

function uniqueFiniteIds(ids) {
    return [...new Set(ids.map(Number).filter(Number.isFinite))];
}

export function isRecoveryActive(ctx) {
    return Boolean(ctx.deathRecovery?.active);
}

export function isRecoveryEmergencyActive(ctx, now = Date.now()) {
    return isRecoveryActive(ctx) && now < (ctx.deathRecovery.emergencyUntil || 0);
}

export function completeDeathRecovery(ctx, reason = 'complete') {
    if (ctx.deathRecovery?.active) ctx.deathRecovery.phase = 'done';
    console.log(`[companion] death recovery complete (${reason})`);
    clearDeathReturn(ctx);
}

/**
 * Clear death-return so normal modes resume.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function clearDeathReturn(ctx) {
    ctx.deathRecovery = createDeathRecoveryState();
    releaseHoldReflexesIfIdle(ctx);
}
