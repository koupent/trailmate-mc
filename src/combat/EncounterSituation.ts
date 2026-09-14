/**
 * 遭遇を少数の「型」に分ける。型ごとに勝ち手順と可調重みが違う。
 */

import { classifyEnemy, type EnemyClass } from './CombatProfiles.js';

export type SituationId =
  | 'single'
  | 'melee-crowd'
  | 'ranged-multi'
  | 'mixed-ranged-melee'
  | 'explosive-mixed';

export type EncounterSituation = {
  id: SituationId;
  label: string;
  /** UI 向け短い説明 */
  blurb: string;
  rangedCount: number;
  meleeCount: number;
  explosiveCount: number;
  total: number;
};

const SITUATION_META: Record<SituationId, { label: string; blurb: string }> = {
  single: {
    label: '単体',
    blurb: '敵1体。型別の扇寄せは不要。'
  },
  'melee-crowd': {
    label: '近接集団',
    blurb: '近接だけ複数。扇を狭めてから殴る。'
  },
  'ranged-multi': {
    label: '遠距離複数',
    blurb: 'スケルトン等が複数。被弾面を減らして1体ずつ。'
  },
  'mixed-ranged-melee': {
    label: '遠距離+近接',
    blurb: '近接の影に入り、近接を先に落としてから遠距離へ。'
  },
  'explosive-mixed': {
    label: '爆発混成',
    blurb: 'クリーパーあり。間合いを保ちつつ他敵を処理。'
  }
};

export function situationMeta(id: SituationId): { label: string; blurb: string } {
  return SITUATION_META[id];
}

export function classifyEncounterSituation(
  enemies: Array<{ kind?: string; name?: string; hp?: number } | null | undefined>
): EncounterSituation {
  let rangedCount = 0;
  let meleeCount = 0;
  let explosiveCount = 0;
  for (const enemy of enemies) {
    if (!enemy) continue;
    if (typeof enemy.hp === 'number' && enemy.hp <= 0) continue;
    const cls: EnemyClass = classifyEnemy(enemy.kind || enemy.name);
    if (cls === 'ranged') rangedCount += 1;
    else if (cls === 'explosive') explosiveCount += 1;
    else meleeCount += 1; // agile も近接寄りとして数える
  }
  const total = rangedCount + meleeCount + explosiveCount;
  let id: SituationId = 'single';
  if (total <= 1) id = 'single';
  else if (explosiveCount > 0) id = 'explosive-mixed';
  else if (rangedCount >= 1 && meleeCount >= 1) id = 'mixed-ranged-melee';
  else if (rangedCount >= 2) id = 'ranged-multi';
  else if (rangedCount === 1 && meleeCount === 0) id = 'single';
  else id = 'melee-crowd';

  const meta = SITUATION_META[id];
  return {
    id,
    label: meta.label,
    blurb: meta.blurb,
    rangedCount,
    meleeCount,
    explosiveCount,
    total
  };
}

export const ALL_SITUATION_IDS: SituationId[] = [
  'single',
  'melee-crowd',
  'ranged-multi',
  'mixed-ranged-melee',
  'explosive-mixed'
];
