/**
 * 位置取り移動とは独立して評価する純粋な戦闘意図。
 *
 * CORE: 優先順位・遠距離回避の骨格は CombatCorePrinciples 参照。学習で書き換えない。
 */

import { COMBAT_CORE_PRINCIPLES } from './CombatCorePrinciples.js';

export type CombatIntentPriority = 'guard' | 'dodge' | 'attack' | 'hold';

export type CombatIntent = {
  /** 対象が射程内なら攻撃可能な状態を維持する。 */
  attack: boolean;
  /** 遠距離・爆発圧に対して攻撃より安全なら盾を構える。 */
  guard: boolean;
  /** 遠距離・爆発圧を受けている間は横移動・退避移動を維持する。 */
  dodge: boolean;
  /** Mineflayer APIで同時実行できない行動の優先順位を解決する。 */
  priority: CombatIntentPriority;
};

export type RangedDodgePhase = 'idle' | 'dodge' | 'advance' | 'attack';

/** 1回の回避→前進サイクルを保持する小さなラッチ。 */
export type RangedDodgeLatch = {
  burstUntil: number;
  advanceUntil: number;
  bestDistance: number;
  lastProgressAt: number;
  handledDamageAt: number;
};

export type RangedDodgeBurstDecision = {
  phase: RangedDodgePhase;
  dodge: boolean;
  latch: RangedDodgeLatch;
};

/** 箱庭・Reflexes 共通の移動種別。 */
export type CombatMoveKind =
  | 'attack'
  | 'dodge'
  | 'advance'
  | 'positioning'
  | 'hold';

export const RANGED_DODGE_BURST_MS = 500;
export const RANGED_ADVANCE_COMMIT_MS = 1800;
export const RANGED_ADVANCE_STALL_MS = 750;
export const RANGED_ADVANCE_PROGRESS_MARGIN = 0.2;
/** この倍率以内まで詰めたら横回避せず前進を維持する。 */
export const RANGED_CLOSE_COMMIT_FACTOR = 1.75;
/** これ以下のHPでは遠距離圧時に前進コミットせず回避を繰り返す。 */
export const RANGED_KITE_HP_THRESHOLD = 10;

/** @deprecated 参照用。原則本文は CombatCorePrinciples。 */
export const COMBAT_MOVE_PRIORITY_NOTE = COMBAT_CORE_PRINCIPLES.threatArcNarrowing.summary;

export function idleRangedDodgeLatch(): RangedDodgeLatch {
  return {
    burstUntil: 0,
    advanceUntil: 0,
    bestDistance: Infinity,
    lastProgressAt: 0,
    handledDamageAt: 0
  };
}

export function decideCombatIntent(opts: {
  distanceToPrimary: number;
  meleeAttackRange: number;
  rangedThreatCount: number;
  hasShield: boolean;
  guardRangedThreatThreshold: number;
  explosiveImmediateDanger: boolean;
}): CombatIntent {
  const attack = Number.isFinite(opts.distanceToPrimary)
    && opts.distanceToPrimary <= opts.meleeAttackRange
    && !opts.explosiveImmediateDanger;
  const pressured = opts.rangedThreatCount > 0 || opts.explosiveImmediateDanger;
  // CORE(ranged-with-shield): 遠距離圧+盾 → guard。爆発は盾より退避。
  const guard = opts.hasShield
    && !opts.explosiveImmediateDanger
    && opts.rangedThreatCount >= Math.max(1, opts.guardRangedThreatThreshold);
  // CORE(ranged-without-shield): 盾なし遠距離圧は回避意図を維持（近接到達時は攻撃）。
  const dodge = pressured && !guard && !attack;
  const priority: CombatIntentPriority = guard
    ? 'guard'
    : attack
      ? 'attack'
      : dodge
        ? 'dodge'
        : 'hold';
  return { attack, guard, dodge, priority };
}

/**
 * 移動の優先順位。
 *
 * CORE(threat-arc-narrowing): 複数脅威の扇補正位置取りは、接近・回避より先。
 * 例外は接触近接のみ（meleeContactInterrupt）。
 */
export function decideCombatMoveKind(opts: {
  intent: CombatIntent;
  dodgePhase: RangedDodgePhase;
  canMeleeAttack: boolean;
  multiThreatReposition: boolean;
  /** 接触距離の近接。扇補正より攻撃を優先してよい唯一の例外。 */
  meleeContactInterrupt?: boolean;
  explosiveImmediateDanger?: boolean;
}): CombatMoveKind {
  if (opts.explosiveImmediateDanger && !opts.canMeleeAttack) return 'dodge';
  // CORE: 扇狭窄の位置取り（接触近接以外）
  if (opts.multiThreatReposition && !opts.meleeContactInterrupt) return 'positioning';
  // 近接射程に入ったら盾ガード中でも殴る（ガードは被弾軽減のまま）
  if (opts.canMeleeAttack && opts.intent.attack) return 'attack';
  if (opts.dodgePhase === 'dodge') return 'dodge';
  if (opts.dodgePhase === 'advance' || opts.dodgePhase === 'attack') return 'advance';
  if (opts.intent.priority === 'dodge') return 'dodge';
  if (opts.intent.priority === 'guard') return 'advance';
  if (opts.intent.priority === 'attack' || opts.intent.priority === 'hold') return 'advance';
  return 'hold';
}

/**
 * 上限付きの遠距離回避。
 *
 * CORE(ranged-without-shield): 盾なしは被弾で短い再回避を挟む。
 * CORE(ranged-with-shield): 盾ありは前進コミットを維持しやすい。
 * 近接一歩手前（closeCommit）では前進を優先。
 */
export function decideRangedDodgeBurst(opts: {
  now: number;
  underRangedPressure: boolean;
  distanceToPrimary: number;
  meleeAttackRange: number;
  latch: RangedDodgeLatch;
  /** 最後に観測した被弾イベントの時刻。未観測なら 0。 */
  lastDamageAt?: number;
  /** 盾装備時は被弾でも再回避しにくい。 */
  hasShield?: boolean;
  /** 低HP時は前進コミットせず回避維持（混成後のスケルトン追撃死対策）。 */
  botHp?: number;
  kiteHpThreshold?: number;
  burstMs?: number;
  advanceMs?: number;
  stallMs?: number;
  progressMargin?: number;
  closeCommitFactor?: number;
}): RangedDodgeBurstDecision {
  if (!opts.underRangedPressure) {
    // 壁端などでLOS/射線がちらつくと、毎回 idle リセット→再回避になり戦闘が始まらない。
    // 圧力が消えたら回避は即やめるが、前進コミット中は接近を継続する。
    if (opts.now < opts.latch.advanceUntil) {
      return {
        phase: 'advance',
        dodge: false,
        latch: {
          ...opts.latch,
          burstUntil: 0,
          bestDistance: Math.min(opts.latch.bestDistance, opts.distanceToPrimary),
          lastProgressAt: opts.now
        }
      };
    }
    return { phase: 'idle', dodge: false, latch: idleRangedDodgeLatch() };
  }
  if (opts.distanceToPrimary <= opts.meleeAttackRange) {
    const lastDamageAt = opts.lastDamageAt ?? 0;
    const advanceMs = opts.advanceMs ?? RANGED_ADVANCE_COMMIT_MS;
    return {
      phase: 'attack',
      dodge: false,
      latch: {
        burstUntil: 0,
        advanceUntil: Math.max(
          opts.latch.advanceUntil,
          opts.now + Math.max(900, advanceMs * 0.65)
        ),
        bestDistance: opts.distanceToPrimary,
        lastProgressAt: opts.now,
        handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
      }
    };
  }

  const lastDamageAt = opts.lastDamageAt ?? 0;
  const freshDamage = lastDamageAt > opts.latch.handledDamageAt;
  const hasShield = Boolean(opts.hasShield);
  const burstMs = opts.burstMs ?? RANGED_DODGE_BURST_MS;
  const advanceMs = opts.advanceMs ?? RANGED_ADVANCE_COMMIT_MS;
  const closeCommitFactor = opts.closeCommitFactor ?? RANGED_CLOSE_COMMIT_FACTOR;
  const closeCommit = opts.distanceToPrimary <= opts.meleeAttackRange * closeCommitFactor;
  const kiteHpThreshold = opts.kiteHpThreshold ?? RANGED_KITE_HP_THRESHOLD;
  // CORE: 近接一歩手前まで詰めたら前進優先。瀕死でも closeCommit 中は回避に戻さない。
  const lowHpKite = opts.botHp != null
    && opts.botHp <= kiteHpThreshold
    && !closeCommit;

  if (opts.now < opts.latch.burstUntil) {
    return {
      phase: 'dodge',
      dodge: true,
      latch: {
        ...opts.latch,
        handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
      }
    };
  }

  // CORE: 盾なし・未近接で新規被弾 → 短い再回避（一直線突撃の抑制）
  if (
    freshDamage
    && !hasShield
    && !closeCommit
    && opts.latch.advanceUntil > 0
  ) {
    const burstUntil = opts.now + Math.min(burstMs, 480);
    return {
      phase: 'dodge',
      dodge: true,
      latch: {
        burstUntil,
        advanceUntil: burstUntil + (lowHpKite
          ? Math.min(700, Math.max(450, advanceMs * 0.35))
          : Math.max(900, advanceMs * 0.7)),
        bestDistance: Infinity,
        lastProgressAt: burstUntil,
        handledDamageAt: lastDamageAt
      }
    };
  }

  // 前進コミット中。低HPは期限切れで次サイクルへ。通常は接近を継続。
  if (opts.latch.advanceUntil > 0) {
    if (!(lowHpKite && opts.now >= opts.latch.advanceUntil)) {
      const progressMargin = opts.progressMargin ?? RANGED_ADVANCE_PROGRESS_MARGIN;
      const progressed = opts.distanceToPrimary
        <= opts.latch.bestDistance - progressMargin;
      const bestDistance = progressed
        ? opts.distanceToPrimary
        : Math.min(opts.latch.bestDistance, opts.distanceToPrimary);
      const lastProgressAt = progressed ? opts.now : opts.latch.lastProgressAt;
      const needsExtend = !lowHpKite
        && (opts.now >= opts.latch.advanceUntil || closeCommit);
      return {
        phase: 'advance',
        dodge: false,
        latch: {
          ...opts.latch,
          advanceUntil: needsExtend
            ? Math.max(opts.latch.advanceUntil, opts.now + Math.max(900, advanceMs * 0.65))
            : opts.latch.advanceUntil,
          bestDistance,
          lastProgressAt,
          handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
        }
      };
    }
  }

  // 新規サイクル開始
  const burstUntil = opts.now + (lowHpKite ? Math.min(burstMs, 420) : burstMs);
  const advanceUntil = burstUntil + (lowHpKite
    ? Math.min(700, Math.max(450, advanceMs * 0.35))
    : advanceMs);
  return {
    phase: 'dodge',
    dodge: true,
    latch: {
      burstUntil,
      advanceUntil,
      bestDistance: Infinity,
      lastProgressAt: burstUntil,
      handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
    }
  };
}
