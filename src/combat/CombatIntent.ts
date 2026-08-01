/** 位置取り移動とは独立して評価する純粋な戦闘意図。 */

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

export const RANGED_DODGE_BURST_MS = 650;
export const RANGED_ADVANCE_COMMIT_MS = 1500;
export const RANGED_ADVANCE_STALL_MS = 750;
export const RANGED_ADVANCE_PROGRESS_MARGIN = 0.2;

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
  const guard = opts.hasShield && (
    opts.explosiveImmediateDanger
    || opts.rangedThreatCount >= Math.max(1, opts.guardRangedThreatThreshold)
  );
  // 近接攻撃が届いたら横回避ループを解除して攻撃を確定する。
  // API上攻撃と防御を両立できない場合は、引き続き防御を優先する。
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
 * 上限付きの遠距離回避。短く横移動した後、明示的な前進・攻撃時間へ移る。
 * 進展があれば停滞ラッチを更新し、新たな被弾、接近停滞、期限到達時だけ
 * 次の横回避バーストを開始する。
 */
export function decideRangedDodgeBurst(opts: {
  now: number;
  underRangedPressure: boolean;
  distanceToPrimary: number;
  meleeAttackRange: number;
  latch: RangedDodgeLatch;
  /** 最後に観測した被弾イベントの時刻。未観測なら 0。 */
  lastDamageAt?: number;
  burstMs?: number;
  advanceMs?: number;
  stallMs?: number;
  progressMargin?: number;
}): RangedDodgeBurstDecision {
  if (!opts.underRangedPressure) {
    return { phase: 'idle', dodge: false, latch: idleRangedDodgeLatch() };
  }
  if (opts.distanceToPrimary <= opts.meleeAttackRange) {
    return { phase: 'attack', dodge: false, latch: idleRangedDodgeLatch() };
  }

  const lastDamageAt = opts.lastDamageAt ?? 0;
  if (opts.now < opts.latch.burstUntil) {
    return {
      phase: 'dodge',
      dodge: true,
      latch: {
        ...opts.latch,
        // 現在のバースト中の被弾は、そのバーストで既に対処中とみなす。
        handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
      }
    };
  }

  const freshDamage = lastDamageAt > opts.latch.handledDamageAt;
  if (!freshDamage && opts.latch.advanceUntil > 0) {
    const progressMargin = opts.progressMargin ?? RANGED_ADVANCE_PROGRESS_MARGIN;
    const progressed = opts.distanceToPrimary
      <= opts.latch.bestDistance - progressMargin;
    const bestDistance = progressed
      ? opts.distanceToPrimary
      : opts.latch.bestDistance;
    const lastProgressAt = progressed
      ? opts.now
      : opts.latch.lastProgressAt;
    const deadlineReached = opts.now >= opts.latch.advanceUntil;
    const stalled = opts.now - lastProgressAt
      >= (opts.stallMs ?? RANGED_ADVANCE_STALL_MS);
    if (!deadlineReached && !stalled) {
      return {
        phase: 'advance',
        dodge: false,
        latch: {
          ...opts.latch,
          bestDistance,
          lastProgressAt
        }
      };
    }
  }

  const burstUntil = opts.now + (opts.burstMs ?? RANGED_DODGE_BURST_MS);
  const advanceUntil = burstUntil + (opts.advanceMs ?? RANGED_ADVANCE_COMMIT_MS);
  return {
    phase: 'dodge',
    dodge: true,
    latch: {
      burstUntil,
      advanceUntil,
      // 横回避では距離が広がることがあるため、進展の基準距離は
      // 回避開始前ではなく、最初の前進tickで確定する。
      bestDistance: Infinity,
      lastProgressAt: burstUntil,
      handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
    }
  };
}
