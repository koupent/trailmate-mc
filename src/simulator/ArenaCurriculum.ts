/**
 * 箱庭の次アリーナを、手元の実戦ログから自動で選ぶ。
 * 人手の「遠距離を増やせ」重みは使わず、未試行→苦手（死亡率・敗北・低スコア）を優先する。
 */

import { ARENA_KINDS, createSeededRng, type ArenaKind } from './ArenaGenerator.js';

export type ArenaPerformance = {
  kind: ArenaKind;
  episodes: number;
  wins: number;
  deaths: number;
  avgScore: number;
};

export type CurriculumPick = {
  kind: ArenaKind;
  reason: 'explore' | 'coverage' | 'weakness';
};

/**
 * seed で決定論的に次のアリーナ種類を選ぶ。
 * - 一定割合は均等探索（局所最適に閉じない）
 * - 試行が足りない種類を先に埋める
 * - その後は死亡率・敗北率・低スコアが高い種類を重み付きで選ぶ
 */
export function pickCurriculumArenaKind(opts: {
  seed: number;
  performance: ArenaPerformance[];
  kinds?: readonly ArenaKind[];
  exploreRate?: number;
  minTrials?: number;
}): CurriculumPick {
  const kinds = opts.kinds ?? ARENA_KINDS;
  const rng = createSeededRng((opts.seed >>> 0) ^ 0xA11CE);
  const exploreRate = opts.exploreRate ?? 0.2;
  const minTrials = opts.minTrials ?? 2;
  const byKind = new Map(opts.performance.map((row) => [row.kind, row]));

  if (rng.next() < exploreRate) {
    return { kind: rng.pick(kinds), reason: 'explore' };
  }

  const cold = kinds.filter((kind) => (byKind.get(kind)?.episodes ?? 0) < minTrials);
  if (cold.length > 0) {
    return { kind: rng.pick(cold), reason: 'coverage' };
  }

  const weighted = kinds.map((kind) => {
    const row = byKind.get(kind) || {
      kind,
      episodes: 0,
      wins: 0,
      deaths: 0,
      avgScore: 0
    };
    const episodes = Math.max(1, row.episodes);
    const deathRate = row.deaths / episodes;
    const lossRate = 1 - row.wins / episodes;
    // スコアが低いほど弱点（-40 → 1.0 程度）
    const scoreWeakness = Math.min(1.5, Math.max(0, -row.avgScore / 40));
    // サンプルが少ない弱点も拾う
    const underSample = 1 / Math.sqrt(episodes);
    const weight = 0.12
      + deathRate * 1.4
      + lossRate * 1.1
      + scoreWeakness * 0.9
      + underSample * 0.45;
    return { kind, weight };
  });

  return { kind: weightedPick(rng, weighted), reason: 'weakness' };
}

function weightedPick(
  rng: ReturnType<typeof createSeededRng>,
  items: Array<{ kind: ArenaKind; weight: number }>
): ArenaKind {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (!(total > 0)) return rng.pick(ARENA_KINDS);
  let cursor = rng.next() * total;
  for (const item of items) {
    cursor -= Math.max(0, item.weight);
    if (cursor <= 0) return item.kind;
  }
  return items[items.length - 1].kind;
}
