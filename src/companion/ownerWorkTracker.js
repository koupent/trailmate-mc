/**
 * Tracks players who are holding a weapon or work tool. While a player keeps
 * one equipped, follow movement stays outside that player's current view.
 */

export const OWNER_WORK_PHASES = Object.freeze({
    idle: 'idle',
    deferring: 'deferring',
    cooldown: 'cooldown'
});

const EXACT_WORK_ITEMS = new Set([
    'bow',
    'crossbow',
    'trident',
    'mace',
    'spear',
    'shears'
]);

const WORK_ITEM_SUFFIXES = [
    '_sword',
    '_axe',
    '_pickaxe',
    '_shovel',
    '_hoe'
];

/**
 * @typedef {{
 *   phase: 'idle'|'deferring'|'cooldown',
 *   source?: 'equipment'|'fixture'
 * }} OwnerWorkState
 */

/**
 * Weapons plus tools used for mining, digging, harvesting, or shearing.
 * @param {string|null|undefined} itemName
 */
export function isWorkItemName(itemName) {
    const name = String(itemName || '');
    return EXACT_WORK_ITEMS.has(name) || WORK_ITEM_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * @param {{ heldItem?: { name?: string }|null, equipment?: Array<{ name?: string }|null> }} entity
 */
export function getHeldItemName(entity) {
    return entity?.heldItem?.name || entity?.equipment?.[0]?.name || null;
}

/** @param {import('./CompanionContext.js').CompanionContext} ctx */
function getPlayerWorkMap(ctx) {
    if (!ctx.playerWorkById) ctx.playerWorkById = new Map();
    return ctx.playerWorkById;
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ id?: number, type?: string, name?: string }} entity
 */
function shouldTrackPlayerEntity(ctx, entity) {
    if (entity?.id == null || entity.id === ctx.bot?.entity?.id) return false;
    if (ctx.config?.owner_work?.all_players === false) return entity.id === ctx.ownerEntity?.id;
    if (entity.type === 'player' || entity.name === 'player') return true;
    return Object.values(ctx.bot?.players || {}).some((player) => player?.entity?.id === entity.id);
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {Array<{ id: number, heldItem?: { name?: string }|null, equipment?: Array<{ name?: string }|null> }>}
 */
function getTrackedPlayerEntities(ctx) {
    const bot = ctx.bot;
    if (ctx.config?.owner_work?.all_players === false) {
        return ctx.ownerEntity ? [ctx.ownerEntity] : [];
    }

    const players = [];
    const seen = new Set();
    for (const player of Object.values(bot?.players || {})) {
        const entity = player?.entity;
        if (!shouldTrackPlayerEntity(ctx, entity) || seen.has(entity.id)) continue;
        seen.add(entity.id);
        players.push(entity);
    }
    return players;
}

/**
 * Synchronize one player's active state from their main-hand equipment.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {{ id?: number, heldItem?: { name?: string }|null, equipment?: Array<{ name?: string }|null> }} entity
 */
export function syncPlayerWorkEquipment(ctx, entity) {
    if (!shouldTrackPlayerEntity(ctx, entity)) return false;
    const map = getPlayerWorkMap(ctx);
    const active = isWorkItemName(getHeldItemName(entity));

    if (active) {
        const existing = map.get(entity.id);
        if (existing?.source !== 'fixture') {
            map.set(entity.id, {
                phase: OWNER_WORK_PHASES.deferring,
                source: 'equipment'
            });
        }
        return true;
    }

    if (map.get(entity.id)?.source === 'equipment') map.delete(entity.id);
    return false;
}

/**
 * Equipment events make switching immediate; the regular tick remains the
 * source of truth in case a player was already holding a tool when observed.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {() => void}
 */
export function attachOwnerWorkTracker(ctx) {
    const onEquip = (entity) => {
        if (ctx.config?.owner_work?.enabled === false) return;
        syncPlayerWorkEquipment(ctx, entity);
    };

    ctx.bot.on('entityEquip', onEquip);
    return () => ctx.bot.off('entityEquip', onEquip);
}

/**
 * Refresh active players from their currently held equipment.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function tickOwnerWork(ctx) {
    const map = getPlayerWorkMap(ctx);
    if (ctx.config?.owner_work?.enabled === false) {
        map.clear();
        return;
    }

    const observed = new Set();
    for (const entity of getTrackedPlayerEntities(ctx)) {
        observed.add(entity.id);
        syncPlayerWorkEquipment(ctx, entity);
    }

    for (const [entityId, state] of map) {
        if (state.source === 'equipment' && !observed.has(entityId)) map.delete(entityId);
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

/** @param {import('./CompanionContext.js').CompanionContext} ctx */
export function isOwnerWorkDeferring(ctx) {
    return getDeferringPlayerIds(ctx).length > 0;
}

/**
 * Test-fixture helper retained for movement and recovery scenarios.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {number} entityId
 * @param {'idle'|'deferring'|'cooldown'} phase
 */
export function seedPlayerWorkPhase(ctx, entityId, phase) {
    if (phase === OWNER_WORK_PHASES.idle) {
        ctx.playerWorkById?.delete(entityId);
        return;
    }
    getPlayerWorkMap(ctx).set(entityId, { phase, source: 'fixture' });
}
