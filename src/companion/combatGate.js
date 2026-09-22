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
import {
  classifyOptionsFromBot,
  isCombatWeaponName
} from './utils/itemClassify.js';

/**
 * 近接・遠隔の武器を「武装済み」と数える。弓とクロスボウを含めるのは
 * 装備回収の判定に効くため。以前の正規表現は `axe` が `pickaxe` にも当たり、
 * ツルハシを武器として数えていた。分類器はこれを道具として扱う。
 * @param {import('mineflayer').Bot | null | undefined} bot
 * @param {{ name?: string }|null|undefined} item
 */
function isWeaponItem(bot, item) {
  return isCombatWeaponName(item?.name, classifyOptionsFromBot(bot));
}

/**
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
function resolveProtectRanges(ctx) {
  return {
    ...DEFAULT_PROTECT_RANGES,
    botChaseRange: ctx.config?.reflexes?.hostile_range ?? DEFAULT_PROTECT_RANGES.botChaseRange
  };
}

/**
 * インベントリに使用可能な戦闘武器がない場合に true。
 * @param {import('mineflayer').Bot | null | undefined} bot
 */
export function needsGearRecovery(bot) {
  try {
    const items = bot?.inventory?.items?.() || [];
    return !items.some((item) => isWeaponItem(bot, item));
  } catch {
    return false;
  }
}

/** AutoEquipが使用可能な武器を手に装備できた場合だけ true。 */
export function hasEssentialWeaponEquipped(bot) {
  return isWeaponItem(bot, bot?.heldItem);
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
  const ranges = resolveProtectRanges(ctx);
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

/**
 * 戦闘中でもマグネット範囲内のドロップ回収を許可する。
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 */
export function canOpportunisticCollect(ctx) {
  const bot = ctx?.bot;
  if (!bot?.entity?.position) return true;
  if (!shouldDeferToCombat(ctx) && !hasProtectThreats(ctx)) return true;

  const ranges = resolveProtectRanges(ctx);
  const botPos = bot.entity.position;
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity?.position) continue;
    if (!isProtectThreat(botPos, ctx.ownerEntity?.position, entity, ranges)) continue;
    const dist = Math.hypot(
      entity.position.x - botPos.x,
      entity.position.y - botPos.y,
      entity.position.z - botPos.z
    );
    if (dist <= DEFAULT_PROTECT_RANGES.selfImmediateRange) {
      return false;
    }
  }
  return true;
}
