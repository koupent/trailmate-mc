/**
 * Pure escort threat policy: who the companion should fight to protect the owner.
 * No FOV — nearby-owner and immediate-self threats only.
 */

import {
  IMMEDIATE_THREAT_RANGE,
  isHostile,
  OWNER_PROTECT_RANGE
} from './entities.js';

export type Pos = { x: number; y: number; z: number; distanceTo?: (p: any) => number };

export type ProtectRanges = {
  /** Max distance from bot to chase (hostile_range). */
  botChaseRange: number;
  /** Owner neighborhood that counts as "protect the player". */
  ownerProtectRange: number;
  /** Bot-adjacent self-defense. */
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
 * True when this hostile is a protect-worthy threat (ignores LOS).
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
 * Pick the best protect target among entities the bot can see (LOS supplied by caller).
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

  // Only fall back to nearestEntity when the bot has no entities map at all.
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
