/**
 * 箱庭／将来の本番で自動チューニングする数値のカタログ。
 *
 * 方針:
 * - **敵クラス固有**（箱庭と本番ワールドで感触が必ずズレるもの）だけ探索する
 * - **敵に紐づかない**ロジック感触（フォーカス粘着・盾閾値・扇閉じ角など）は
 *   固定定数にするか、そもそもパラメータ化しない
 */

import type { CombatPresetParams, EnemyClass } from './CombatProfiles.js';

/**
 * 敵クラス橋渡し用キー。
 * 近接／敏捷は原則駆動のため数値探索なし。
 */
export type SimTuneKey =
  | 'rangedDodgeBurstMs'
  | 'rangedDodgeReassessMs'
  | 'creeperSoftEvadeRange';

export const CLASS_TUNABLE_KEYS: Record<EnemyClass, readonly SimTuneKey[]> = {
  melee: [],
  agile: [],
  ranged: ['rangedDodgeBurstMs', 'rangedDodgeReassessMs'],
  explosive: ['creeperSoftEvadeRange']
};

export const ENEMY_CLASS_LABELS: Record<EnemyClass, string> = {
  melee: '近接',
  agile: '敏捷',
  ranged: '遠距離',
  explosive: '爆発'
};

export const ALL_SIM_TUNABLE_KEYS: readonly SimTuneKey[] = [
  'rangedDodgeBurstMs',
  'rangedDodgeReassessMs',
  'creeperSoftEvadeRange'
];

export function tunableKeysForClass(enemyClass: EnemyClass): readonly SimTuneKey[] {
  return CLASS_TUNABLE_KEYS[enemyClass] || [];
}

export function isSimTuneKey(key: string): key is SimTuneKey {
  return (ALL_SIM_TUNABLE_KEYS as readonly string[]).includes(key);
}

/** 探索対象外のキーを捨てる（古い学習JSONや本番間合いの混入防止）。 */
export function filterSimTuneOverlay(
  overlay: Partial<CombatPresetParams> | null | undefined,
  enemyClass?: EnemyClass
): Partial<CombatPresetParams> | null {
  if (!overlay) return null;
  const allowed = new Set<string>(
    enemyClass ? tunableKeysForClass(enemyClass) : ALL_SIM_TUNABLE_KEYS
  );
  const out: Partial<CombatPresetParams> = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (!allowed.has(key)) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    (out as Record<string, number>)[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

export type SimTuneParams = Pick<CombatPresetParams, SimTuneKey>;
