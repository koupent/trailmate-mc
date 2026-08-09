/** One passive wait for vanilla pickup before actively moving closer. */
export const PICKUP_SETTLE_MS = 350;

/**
 * @typedef {{
 *   targetKey: number|string|object,
 *   startedAt: number,
 *   settleMs: number
 * }} PickupSettleState
 */

/**
 * @param {{ id?: number }|any} entity
 * @returns {number|string|object|null}
 */
export function pickupTargetKey(entity) {
    return entity?.id ?? entity ?? null;
}

/**
 * Start the single passive-pickup settle window for a target.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ id?: number }} entity
 * @param {number} [now]
 * @param {number} [settleMs]
 * @returns {PickupSettleState|null}
 */
export function beginPickupSettle(ctx, entity, now = Date.now(), settleMs = PICKUP_SETTLE_MS) {
    const targetKey = pickupTargetKey(entity);
    if (!ctx || targetKey == null) return null;

    const current = ctx.nearbyLoot?.pickupSettle;
    if (current?.targetKey === targetKey) return current;

    ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
    const next = { targetKey, startedAt: now, settleMs };
    ctx.nearbyLoot.pickupSettle = next;
    return next;
}

/**
 * A still-visible target is promoted to an active close approach after settling.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ id?: number }} entity
 * @param {number} [now]
 */
export function pickupNeedsCloseApproach(ctx, entity, now = Date.now()) {
    const targetKey = pickupTargetKey(entity);
    const settle = ctx?.nearbyLoot?.pickupSettle;
    return settle?.targetKey === targetKey
        && now - settle.startedAt >= (settle.settleMs ?? PICKUP_SETTLE_MS);
}

/**
 * Clear pickup progress once the observed entity is gone.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {any[]} candidates
 */
export function clearPickupSettleWhenTargetMissing(ctx, candidates) {
    const settle = ctx?.nearbyLoot?.pickupSettle;
    if (!settle) return;
    if (candidates.some((entity) => pickupTargetKey(entity) === settle.targetKey)) return;
    ctx.nearbyLoot.pickupSettle = null;
}
