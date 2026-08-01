/** 相棒の上位モードと戦闘の間を調停する純粋な所有権・ラッチ方針。 */

export const COMBAT_RELEASE_STABLE_MS = 1500;

export function refreshCombatControlUntil(opts: {
  now: number;
  previousUntil: number;
  activeThreat: boolean;
  freshDamage?: boolean;
  stableMs?: number;
}): number {
  if (!opts.activeThreat && !opts.freshDamage) return opts.previousUntil;
  return Math.max(
    opts.previousUntil,
    opts.now + (opts.stableMs ?? COMBAT_RELEASE_STABLE_MS)
  );
}

export function combatOwnsControl(now: number, controlUntil: number): boolean {
  return now < controlUntil;
}
