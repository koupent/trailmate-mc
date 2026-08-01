/**
 * 相棒ループにおける戦闘と割り込みの優先順位。
 *
 * 優先順位（高→低）:
 *   1. 上限付きの緊急生存行動
 *   2. Guard（Reflexes）— 直前の被弾を含む。HP低下だけのRetreatはしない
 *   3. その他の復旧割り込み（死亡地点への帰還、回収）— 非戦闘時のみ
 *   4. Follow / Wait モード
 *
 * 武装して戦闘中のBotから、割り込みが自己防衛を奪ってはならない。
 */

import {
  DEFAULT_PROTECT_RANGES,
  isProtectThreat
} from '../world/threatPolicy.js';

const WEAPON_NAME_RE = /sword|axe|trident|bow|crossbow|mace|spear/;

/**
 * インベントリに使用可能な戦闘武器がない場合に true。
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

/** AutoEquipが使用可能な武器を手に装備できた場合だけ true。 */
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

/**
 * Recovery中でも武装済みなら周囲の脅威に通常戦闘で応答する。
 * 未武装の間は墓ドロップの装備回収を優先する。
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function shouldDeferRecoveryForCombat(ctx) {
  if (!ctx.deathRecovery?.active) return false;
  if (needsGearRecovery(ctx.bot)) return false;
  return shouldDeferToCombat(ctx);
}

/**
 * 通常の地上アイテム回収を中断すべきか。
 * Reflexes 未初期化時でも護衛脅威は hasProtectThreats で検知する。
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function shouldAbortPickupForCombat(ctx) {
  return shouldDeferToCombat(ctx) || hasProtectThreats(ctx);
}
