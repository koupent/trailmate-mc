/**
 * 本番 Reflexes 向け: 箱庭で検証した純粋ルールへの薄い変換。
 * Mineflayer 固有の移動実行は Reflexes 側に残す。
 */

import {
  selectCommittedFocus,
  type FocusThreat,
  type SelectCommittedFocusResult
} from '../combat/CombatFocus.js';
import {
  decideCombatIntent,
  decideCombatMoveKind,
  type CombatIntent,
  type CombatMoveKind,
  type RangedDodgePhase
} from '../combat/CombatIntent.js';
import {
  classifyEncounterSituation,
  type EncounterSituation
} from '../combat/EncounterSituation.js';
import {
  decideMixedCombatPlan,
  isDangerFanPressure,
  type MixedCombatPlan
} from '../combat/MixedCombatPlan.js';
import { classifyEnemy } from '../combat/CombatProfiles.js';
import type { XZ } from '../combat/threatArc.js';

/** 箱庭と同じ固定。探索対象にしない。 */
export const LIVE_FOCUS_STICKY_MS = 900;
export const LIVE_ARC_NARROW_ENOUGH_SPAN_DEG = 55;
export const LIVE_GUARD_RANGED_THREAT_THRESHOLD = 1;

export type LiveEntityLike = {
  id?: number | null;
  name?: string | null;
  health?: number | null;
  position?: { x: number; z: number } | null;
};

export function entityToFocusThreat(entity: LiveEntityLike): FocusThreat | null {
  if (entity?.id == null || !entity.position) return null;
  return {
    id: Number(entity.id),
    x: entity.position.x,
    z: entity.position.z,
    kind: String(entity.name || 'unknown'),
    hp: Number.isFinite(Number(entity.health)) ? Number(entity.health) : 20
  };
}

export function entitiesToFocusThreats(entities: LiveEntityLike[]): FocusThreat[] {
  const out: FocusThreat[] = [];
  for (const entity of entities) {
    const threat = entityToFocusThreat(entity);
    if (threat) out.push(threat);
  }
  return out;
}

export function pickLiveFocus(opts: {
  bot: XZ;
  candidates: LiveEntityLike[];
  stickyId: number | null | undefined;
  now: number;
  stickyMs?: number;
  hardOverrideId?: number | null;
}): SelectCommittedFocusResult {
  return selectCommittedFocus({
    bot: opts.bot,
    threats: entitiesToFocusThreats(opts.candidates),
    stickyId: opts.stickyId,
    now: opts.now,
    stickyMs: opts.stickyMs ?? LIVE_FOCUS_STICKY_MS,
    hardOverrideId: opts.hardOverrideId ?? null
  });
}

export type LiveCombatActionInput = {
  enemyKinds: Array<{ kind?: string; name?: string; hp?: number }>;
  spanDeg: number | null;
  arcLatched: boolean;
  selectionMoved: boolean;
  rangedExposedCount: number;
  meleeExposedCount: number;
  canStrikeFocus: boolean;
  focusKind: string | null | undefined;
  explosiveImmediateDanger: boolean;
  holdingCover?: boolean;
  hasMeleeBlocker: boolean;
  meleeContactInterrupt: boolean;
  dodgePhase: RangedDodgePhase;
  intent: CombatIntent;
  umbraGoal?: XZ | null;
  skirtGoal?: XZ | null;
  approachGoal?: XZ | null;
};

export type LiveCombatAction = {
  situation: EncounterSituation;
  dangerFanExposed: boolean;
  plan: MixedCombatPlan | null;
  moveKind: CombatMoveKind;
  /** true のとき位置取り（扇狭窄）を実行する */
  doNarrow: boolean;
};

/**
 * 本番の1tick戦闘行動を箱庭と同じ純粋ルールで決める。
 */
export function decideLiveCombatAction(input: LiveCombatActionInput): LiveCombatAction {
  const situation = classifyEncounterSituation(input.enemyKinds);
  const dangerFanExposed = isDangerFanPressure({
    rangedExposedCount: input.rangedExposedCount,
    meleeExposedCount: input.meleeExposedCount
  });
  const focusIsExplosive = classifyEnemy(input.focusKind) === 'explosive';
  const hasRanged = situation.rangedCount > 0
    || classifyEnemy(input.focusKind) === 'ranged';

  const plan = decideMixedCombatPlan({
    situation,
    spanDeg: input.spanDeg,
    arcLatched: input.arcLatched,
    selectionMoved: input.selectionMoved,
    explosiveImmediateDanger: input.explosiveImmediateDanger,
    canStrikeFocus: input.canStrikeFocus,
    focusIsExplosive,
    holdingCover: Boolean(input.holdingCover),
    rangedExposed: input.rangedExposedCount > 0,
    dangerFanExposed,
    hasMeleeBlocker: input.hasMeleeBlocker,
    hasRanged,
    meleeContactInterrupt: input.meleeContactInterrupt,
    dodgePhase: input.dodgePhase,
    umbraGoal: input.umbraGoal ?? null,
    skirtGoal: input.skirtGoal ?? null,
    approachGoal: input.approachGoal ?? null,
    narrowSpanDeg: LIVE_ARC_NARROW_ENOUGH_SPAN_DEG
  });

  const multiThreatReposition = plan
    ? plan.phase === 'narrow'
    : (
      dangerFanExposed
      && input.selectionMoved
      && situation.total >= 2
      && !input.meleeContactInterrupt
      && !input.explosiveImmediateDanger
    );

  let moveKind = decideCombatMoveKind({
    intent: input.intent,
    dodgePhase: input.dodgePhase,
    canMeleeAttack: input.canStrikeFocus,
    multiThreatReposition,
    meleeContactInterrupt: input.meleeContactInterrupt,
    explosiveImmediateDanger: input.explosiveImmediateDanger
  });

  if (plan && plan.phase !== 'narrow') {
    if (
      plan.moveKind === 'attack'
      || plan.moveKind === 'advance'
      || plan.moveKind === 'dodge'
      || plan.moveKind === 'hold'
    ) {
      moveKind = plan.moveKind;
    }
  }

  return {
    situation,
    dangerFanExposed,
    plan,
    moveKind,
    doNarrow: moveKind === 'positioning' || plan?.phase === 'narrow'
  };
}

/** テスト／トレース用の intent ヘルパ */
export function decideLiveCombatIntent(opts: {
  distanceToPrimary: number;
  meleeAttackRange: number;
  rangedThreatCount: number;
  hasShield: boolean;
  explosiveImmediateDanger: boolean;
}): CombatIntent {
  return decideCombatIntent({
    distanceToPrimary: opts.distanceToPrimary,
    meleeAttackRange: opts.meleeAttackRange,
    rangedThreatCount: opts.rangedThreatCount,
    hasShield: opts.hasShield,
    guardRangedThreatThreshold: LIVE_GUARD_RANGED_THREAT_THRESHOLD,
    explosiveImmediateDanger: opts.explosiveImmediateDanger
  });
}
