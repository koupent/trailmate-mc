/**
 * Combat vs interrupt priority for the companion loop.
 *
 * Priority (high → low):
 *   1. Bounded emergency survival
 *   2. Guard (Reflexes) — including "just took damage"; no health-flee Retreat
 *   3. Other recovery interrupts (death-return, loot) — only when not fighting
 *   4. Follow / Wait modes
 *
 * Interrupts must never silence self-defense while the bot is armed and fighting.
 */

import {
  DEFAULT_PROTECT_RANGES,
  isProtectThreat
} from '../world/threatPolicy.js';

const WEAPON_NAME_RE = /sword|axe|trident|bow|crossbow|mace|spear/;

/**
 * True when the bot has no usable combat weapon in inventory.
 * @param {import('mineflayer').Bot | null | undefined} bot
 */
export function needsGearRecovery(bot) {
  try {
    const items = bot?.inventory?.items?.() || [];
    return !items.some((item) => WEAPON_NAME_RE.test(String(item?.name || '')));
  } catch {
    return false;
  }
}

/** True only when AutoEquip has restored a usable weapon to the hand. */
export function hasEssentialWeaponEquipped(bot) {
  return WEAPON_NAME_RE.test(String(bot?.heldItem?.name || ''));
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {boolean}
 */
export function shouldDeferToCombat(ctx) {
  const reflexes = ctx.agent?.reflexes;
  if (!reflexes) return false;
  if (reflexes.isControllingMovement) return true;
  if (typeof reflexes.wantsCombat === 'boolean' && reflexes.wantsCombat) return true;
  return hasProtectThreats(ctx);
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @returns {boolean}
 */
export function hasProtectThreats(ctx) {
  const bot = ctx.bot;
  if (!bot?.entity?.position) return false;
  const ranges = {
    ...DEFAULT_PROTECT_RANGES,
    botChaseRange: ctx.config?.reflexes?.hostile_range ?? DEFAULT_PROTECT_RANGES.botChaseRange
  };
  const ownerPos = ctx.ownerEntity?.position;
  const botPos = bot.entity.position;
  for (const entity of Object.values(bot.entities || {})) {
    if (isProtectThreat(botPos, ownerPos, entity, ranges)) return true;
  }
  return false;
}
