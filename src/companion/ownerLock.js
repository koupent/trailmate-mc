/**
 * Shared owner lock helpers for FollowMode and CompanionDialogue.
 */

import { tCommand } from '../i18n/index.js';
import { deriveFollowPhase, deriveOwnerLockedKey } from './dialogueParse.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import { currentControlOwner } from './ControlPriority.js';

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
 * Owner spatial facts shared by dialogue snapshots and lock announcements.
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {string} [mode]
 */
export function buildOwnerFollowFacts(ctx, mode = 'follow') {
    const bot = ctx.bot;
    const ownerEntity = ctx.ownerEntity;
    const ownerDistance = ownerEntity
        ? Number(bot.entity.position.distanceTo(ownerEntity.position).toFixed(1))
        : null;

    return {
        mode,
        controlOwner: currentControlOwner(ctx, mode),
        owner: ctx.ownerName,
        ownerVisible: !!ctx.worldState?.ownerVisible,
        ownerDistance,
        ownerEntityMissing: Boolean(ctx.ownerName && !ownerEntity),
        ownerHasLos: ownerEntity ? hasLineOfSight(bot, ownerEntity) : false,
        botPos: bot?.entity?.position
            ? {
                x: bot.entity.position.x,
                y: bot.entity.position.y,
                z: bot.entity.position.z
            }
            : null,
        ownerPos: ownerEntity
            ? {
                x: ownerEntity.position.x,
                y: ownerEntity.position.y,
                z: ownerEntity.position.z
            }
            : null
    };
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
    const snap = buildOwnerFollowFacts(ctx, 'follow');
    const phase = deriveFollowPhase(snap, ctx.config || {});
    const key = deriveOwnerLockedKey(phase);
    await ctx.agent.openChat(tCommand(language, key, { owner: name }));
}
