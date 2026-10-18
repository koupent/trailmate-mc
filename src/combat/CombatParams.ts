/**
 * 戦闘判断の固定値。箱庭（SimulationCore）と本番（Reflexes）が同じ値を読む。
 *
 * 学習・チューニングで動かす値はここではなく CombatProfiles のプリセット
 * （CombatTuneCatalog が許すキーだけ）にある。
 */

/** 近接攻撃が届く水平距離。 */
export const MELEE_RANGE = 3.5;
/** 敵とめり込んでいるとみなす距離。 */
export const ENTITY_OVERLAP_RANGE = 0.55;
/** 近接敵が止まる距離。 */
export const MELEE_STOP_RANGE = 1.25;
/**
 * CORE: 本当の接触近接。
 * MELEE_RANGE(3.5)や旧2.2は広すぎて、扇が100°超のまま攻撃へ切り替わってしまう。
 */
export const MELEE_CONTACT_INTERRUPT_RANGE = MELEE_STOP_RANGE + 0.2;
/** 接近時にこの距離手前で止まる。 */
export const MELEE_HOLD_RANGE = 0.95;
/** 近接が届く高さの差。 */
export const MELEE_HEIGHT_SLACK = 1.5;
/** 遠距離敵がこの距離内で射線が通れば「遠距離圧」。 */
export const RANGED_PRESSURE_RANGE = 12;
/** 扇がこの角度以下なら十分狭い。 */
export const ARC_NARROW_ENOUGH_SPAN_DEG = 55;
/** 主対象を切り替えずに保つ時間。 */
export const FOCUS_STICKY_MS = 900;
/** 盾を構える遠距離脅威数。 */
export const GUARD_RANGED_THREAT_THRESHOLD = 1;
/** 位置取り候補を探す1歩の長さ。 */
export const POSITIONING_STEP = 2.25;
/** 位置取りでオーナーから離れてよい距離。 */
export const POSITIONING_MAX_OWNER_DISTANCE = 8;
/** 本番で近接攻撃を振る最短間隔（剣の攻撃速度 1.6 ≒ 625ms）。 */
export const MELEE_STRIKE_GAP_MS = 625;
/** 復帰中の生存回避で横移動の向きを変える間隔。 */
export const STRAFE_SWITCH_MS = 650;

/**
 * 脅威弧・意図は水平距離。高さ差が大きい近接は距離3Dで少し伸ばす。
 */
export function combatDistance(
  a: { x: number; y?: number; z: number },
  b: { x: number; y?: number; z: number }
): number {
  const horizontal = Math.hypot(a.x - b.x, a.z - b.z);
  const dy = Math.abs((a.y ?? 0) - (b.y ?? 0));
  if (dy <= MELEE_HEIGHT_SLACK) return horizontal;
  return Math.hypot(horizontal, dy);
}
