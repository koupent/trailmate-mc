/**
 * 戦闘プラン（原則駆動・短い優先順）。
 *
 * 原則:
 * 1. 近い危険から片付ける
 * 2. 行動は危険扇の分布で決める（種別の特別分岐を増やさない）
 * 3. 安全点 = 単一ゴール
 * 4. CORE: 危険扇に晒されている間だけ扇狭窄。着火中のみ強制退避
 *
 * 優先順:
 * 着火退避 → 危険扇露出中の扇狭窄 → 届くなら打撃 → 影 → 主対象へ接近
 *
 * 重要:
 * 「届かない」だけでは狭窄しない（ノックバック後のヒット&アウェイ防止）。
 * 狭窄条件は種別ではなく攻撃扇への露出。遠距離1体でも／近接が2体以上寄ってきても同じ。
 * 主対象の sticky / 切替は CombatFocus.selectCommittedFocus の責務。
 */

import type { CombatMoveKind, RangedDodgePhase } from './CombatIntent.js';
import type { CombatPhaseId } from './CombatUtility.js';
import type { EncounterSituation } from './EncounterSituation.js';
import type { XZ } from './threatArc.js';

export type MixedPlanPhase =
  | 'evade-creeper'
  | 'narrow'
  | 'seek-cover'
  | 'finish-cover'
  | 'skirt-ranged'
  | 'strike';

export type MixedCombatPlan = {
  phase: MixedPlanPhase;
  uiPhaseId: CombatPhaseId;
  moveKind: CombatMoveKind;
  goal: XZ | null;
  strikeWhileMoving: boolean;
  releaseArcLatch: boolean;
};

const PHASE_TO_UI: Record<MixedPlanPhase, CombatPhaseId> = {
  'evade-creeper': 'evade-creeper',
  narrow: 'narrow',
  'seek-cover': 'cover-melee',
  'finish-cover': 'finish-melee',
  'skirt-ranged': 'kite-ranged',
  strike: 'strike'
};

export type DecideMixedCombatPlanInput = {
  situation: EncounterSituation;
  spanDeg: number | null;
  arcLatched: boolean;
  selectionMoved: boolean;
  /** 着火中かつ殴れないときだけ true */
  explosiveImmediateDanger: boolean;
  /** 主対象を殴れる */
  canStrikeFocus: boolean;
  /** 主対象が爆発クラスで、未着火〜処理可能 */
  focusIsExplosive: boolean;
  holdingCover: boolean;
  /** 遠距離攻撃扇に晒されている（影探し用） */
  rangedExposed: boolean;
  /**
   * 危険扇圧: 遠距離1+ または 近接扇に2体以上晒されている。
   * 種別ifではなく扇露出の幾何。他敵が遠い（扇外）なら false になり一本集中できる。
   */
  dangerFanExposed: boolean;
  hasMeleeBlocker: boolean;
  hasRanged: boolean;
  meleeContactInterrupt: boolean;
  dodgePhase: RangedDodgePhase;
  umbraGoal: XZ | null;
  skirtGoal: XZ | null;
  approachGoal: XZ | null;
  narrowSpanDeg?: number;
};

/**
 * 狭窄に使う露出フラグ。遠距離は1体でも圧、近接は複数が扇内のときだけ。
 */
export function isDangerFanPressure(opts: {
  rangedExposedCount: number;
  meleeExposedCount: number;
}): boolean {
  return opts.rangedExposedCount > 0 || opts.meleeExposedCount >= 2;
}

function plan(
  phase: MixedPlanPhase,
  partial: Omit<MixedCombatPlan, 'phase' | 'uiPhaseId'>
): MixedCombatPlan {
  return {
    phase,
    uiPhaseId: PHASE_TO_UI[phase],
    ...partial
  };
}

export function decideMixedCombatPlan(
  input: DecideMixedCombatPlanInput
): MixedCombatPlan | null {
  const crowd = input.situation.total >= 2
    || input.situation.id === 'mixed-ranged-melee'
    || input.situation.id === 'explosive-mixed'
    || input.situation.id === 'melee-crowd'
    || input.situation.id === 'ranged-multi';
  if (!crowd && !input.focusIsExplosive) return null;

  // 1) 着火して殴れない → だけ退避
  if (input.explosiveImmediateDanger) {
    return plan('evade-creeper', {
      moveKind: 'dodge',
      goal: null,
      strikeWhileMoving: false,
      releaseArcLatch: true
    });
  }

  const narrowSpanDeg = input.narrowSpanDeg ?? 55;
  const spanWide = input.spanDeg != null && input.spanDeg > narrowSpanDeg;
  const canImproveFan = input.arcLatched || input.selectionMoved;
  // 扇狭窄 = 危険扇への対処（遠近の種別ではなく露出）。届かないだけでは狭窄しない。
  const needsNarrow = crowd
    && !input.focusIsExplosive
    && input.dangerFanExposed
    && canImproveFan
    && !(input.holdingCover && !spanWide);

  // 2) 危険扇露出中だけ扇狭窄（届いていても攻撃へ落とさない／歩き殴り）
  if (needsNarrow) {
    return plan('narrow', {
      moveKind: 'positioning',
      goal: null,
      strikeWhileMoving: input.canStrikeFocus,
      releaseArcLatch: false
    });
  }

  // 3) 主対象に届く → 殴る
  if (input.canStrikeFocus) {
    return plan('strike', {
      moveKind: 'attack',
      goal: null,
      strikeWhileMoving: false,
      releaseArcLatch: true
    });
  }

  // 4) 既に影 → 影を保って近い遮蔽役を処理
  if (input.holdingCover && input.hasMeleeBlocker) {
    return plan('finish-cover', {
      moveKind: 'advance',
      goal: input.umbraGoal,
      strikeWhileMoving: true,
      releaseArcLatch: true
    });
  }

  // 5) 遠距離露出＋肉壁あり → 影へ
  if (input.hasRanged && input.rangedExposed && input.hasMeleeBlocker && input.umbraGoal
    && !input.focusIsExplosive) {
    return plan('seek-cover', {
      moveKind: 'advance',
      goal: input.umbraGoal,
      strikeWhileMoving: true,
      releaseArcLatch: true
    });
  }

  // 6) 接近（遠距離扇なら斜め、純近接は主対象へ直線的に）
  if (input.hasRanged && input.skirtGoal && !input.focusIsExplosive) {
    const dodge = input.dodgePhase === 'dodge';
    return plan('skirt-ranged', {
      moveKind: dodge ? 'dodge' : 'advance',
      goal: input.skirtGoal,
      strikeWhileMoving: false,
      releaseArcLatch: true
    });
  }

  return plan('strike', {
    moveKind: 'advance',
    goal: input.approachGoal || input.umbraGoal,
    strikeWhileMoving: false,
    releaseArcLatch: Boolean(input.focusIsExplosive)
  });
}

export function isCoverPhase(phase: MixedPlanPhase): boolean {
  return phase === 'seek-cover' || phase === 'finish-cover';
}
