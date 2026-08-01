/**
 * ownerを守るために誰と戦うかを決める純粋な護衛脅威方針。
 * 視野角は使わず、owner近傍とBot直近の脅威だけを扱う。
 */

import {
  IMMEDIATE_THREAT_RANGE,
  isHostile,
  OWNER_PROTECT_RANGE
} from './entities.js';

export type Pos = { x: number; y: number; z: number; distanceTo?: (p: any) => number };

export type ProtectRanges = {
  /** Botが追跡する最大距離（hostile_range）。 */
  botChaseRange: number;
  /** 「プレイヤーを守る」対象とみなすowner周辺範囲。 */
  ownerProtectRange: number;
  /** Bot直近の自己防衛範囲。 */
  selfImmediateRange: number;
};

export const DEFAULT_PROTECT_RANGES: ProtectRanges = {
  botChaseRange: 12,
  ownerProtectRange: OWNER_PROTECT_RANGE,
  selfImmediateRange: IMMEDIATE_THREAT_RANGE
};

export type ProtectReason = 'owner-near' | 'self-immediate' | null;

function distanceBetween(a: Pos, b: Pos): number {
  if (typeof a.distanceTo === 'function') return a.distanceTo(b);
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * この敵が護衛対象となる脅威なら true（視線判定は行わない）。
 */
export function isProtectThreat(
  botPos: Pos,
  ownerPos: Pos | null | undefined,
  enemy: { position?: Pos; type?: string; name?: string; isValid?: boolean } | null | undefined,
  ranges: ProtectRanges = DEFAULT_PROTECT_RANGES
): ProtectReason {
  if (!enemy?.position || !isHostile(enemy) || enemy.isValid === false) return null;
  const botDist = distanceBetween(botPos, enemy.position);
  if (botDist > ranges.botChaseRange) return null;
  if (botDist <= ranges.selfImmediateRange) return 'self-immediate';
  if (ownerPos && distanceBetween(ownerPos, enemy.position) <= ranges.ownerProtectRange) {
    return 'owner-near';
  }
  return null;
}

function protectRank(
  botPos: Pos,
  ownerPos: Pos | null | undefined,
  enemyPos: Pos,
  ranges: ProtectRanges
): number {
  const botDist = distanceBetween(botPos, enemyPos);
  if (botDist <= ranges.selfImmediateRange) return botDist;
  const ownerDist = ownerPos ? distanceBetween(ownerPos, enemyPos) : Infinity;
  if (ownerDist <= ranges.ownerProtectRange) return 100 + ownerDist;
  return 200 + botDist;
}

/**
 * Botから見えるエンティティの中から最適な護衛対象を選ぶ（視線判定は呼び出し側が渡す）。
 */
export function pickProtectTarget(
  bot: {
    entities?: Record<string | number, any>;
    entity: { position: Pos };
    nearestEntity?: (pred: (e: any) => boolean) => any;
  },
  ownerPos: Pos | null | undefined,
  ranges: ProtectRanges,
  hasLineOfSight: (entity: any) => boolean
): any | null {
  const botPos = bot.entity.position;
  const entityMap = bot.entities;
  const hasEntityMap = entityMap != null && typeof entityMap === 'object';
  const candidates = hasEntityMap
    ? Object.values(entityMap).filter((entity) => {
      if (!isProtectThreat(botPos, ownerPos, entity, ranges)) return false;
      return hasLineOfSight(entity);
    })
    : [];

  // Botがentitiesマップを持たない場合だけ nearestEntity へフォールバックする。
  if (!hasEntityMap && typeof bot.nearestEntity === 'function') {
    return bot.nearestEntity(
      (entity) =>
        !!isProtectThreat(botPos, ownerPos, entity, ranges) && hasLineOfSight(entity)
    );
  }

  candidates.sort((a, b) => {
    const aRank = protectRank(botPos, ownerPos, a.position, ranges);
    const bRank = protectRank(botPos, ownerPos, b.position, ranges);
    return aRank - bRank;
  });
  return candidates[0] || null;
}
