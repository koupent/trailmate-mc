/** Pure combat intent evaluated independently from positioning movement. */

export type CombatIntentPriority = 'guard' | 'dodge' | 'attack' | 'hold';

export type CombatIntent = {
  /** Keep an attack available when the target is in reach. */
  attack: boolean;
  /** Raise a shield when ranged/explosive pressure makes it safer than attacking. */
  guard: boolean;
  /** Preserve lateral/escape movement under ranged or explosive pressure. */
  dodge: boolean;
  /** Resolves actions that the Mineflayer API cannot execute simultaneously. */
  priority: CombatIntentPriority;
};

export type RangedDodgePhase = 'idle' | 'dodge' | 'advance' | 'attack';

/** Small latch for one dodge -> advance cycle. */
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
  // Once melee is available, committing the hit must break a lateral dodge
  // loop. Guard still wins when the API cannot attack and block together.
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
 * Bounded ranged dodge: move sideways briefly, then explicitly commit to an
 * advance/attack window. Progress refreshes the stall latch; only a new hit,
 * stalled approach, or the hard deadline can begin another lateral burst.
 */
export function decideRangedDodgeBurst(opts: {
  now: number;
  underRangedPressure: boolean;
  distanceToPrimary: number;
  meleeAttackRange: number;
  latch: RangedDodgeLatch;
  /** Timestamp of the latest observed damage event, or 0 when none. */
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
        // A hit during the active burst is already covered by that burst.
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
      // A lateral burst can increase distance. Establish the progress
      // baseline on the first advance tick, not before the dodge starts.
      bestDistance: Infinity,
      lastProgressAt: burstUntil,
      handledDamageAt: Math.max(opts.latch.handledDamageAt, lastDamageAt)
    }
  };
}
