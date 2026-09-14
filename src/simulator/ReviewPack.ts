import type { EpisodeResult, TraceSample } from './GymRunner.js';
import type { TuningStatus } from '../combat/ParamTuner.js';

export type FailureCluster = {
  kind: string;
  label: string;
  count: number;
  seeds: number[];
  samples: Array<{
    seed: number;
    arenaKind: string;
    score: number;
    damageTaken: number;
    trace: TraceSample[];
  }>;
};

export type ReviewSummary = {
  generatedAt: string;
  episodes: number;
  winRate: number;
  deathRate: number;
  avgDamage: number;
  avgScore: number;
  clusters: FailureCluster[];
  byArena: Record<string, { episodes: number; wins: number; deaths: number; avgScore?: number }>;
  byPreset: Record<string, { episodes: number; avgScore: number; wins: number }>;
  tuning: TuningStatus;
};

export function buildReviewMarkdown(summary: ReviewSummary, worst: EpisodeResult[]): string {
  const lines: string[] = [];
  const plateau = summary.tuning.mode === 'plateau-logic-bottleneck';

  lines.push('# TrailMate 戦闘箱庭 分析パック（Cursor用）');
  lines.push('');
  lines.push('## 責務分離（必読）');
  lines.push('- **箱庭で探索する数値**（敵クラス固有のみ: 遠距離 `rangedDodgeBurstMs` / `rangedDodgeReassessMs`、爆発 `creeperSoftEvadeRange`）');
  lines.push('- **敵非固有**（フォーカス・盾閾値・扇閉じ角など）は固定定数。本番間合いは Reflexes 用');
  lines.push('  → 箱庭の**自動チューニング**が担当。Cursorは値をいじらない。');
  lines.push('- **ロジック**（移動優先順位・分岐・ノックバック／着火など）');
  lines.push('  → 自動チューニングが**頭打ち（plateau）**のときだけ修正する。');
  lines.push('- 学習ストアは `data/sim-combat-state.json`。本番 `data/combat-state.json` は黙って上書きしない。');
  lines.push('- 禁止: ニューラルネット追加');
  lines.push('');
  lines.push('## 自動チューニング状態');
  lines.push(`- mode: \`${summary.tuning.mode}\``);
  lines.push(`- 要約: ${summary.tuning.summary}`);
  lines.push(`- 数値探索回数: ${summary.tuning.paramExploreCount}`);
  lines.push(`- 数値採用回数: ${summary.tuning.paramAdoptCount}`);
  lines.push(`- 改善なし連続: ${summary.tuning.noImproveStreak}`);
  lines.push(
    `- ベストスコア: ${
      summary.tuning.bestScore == null ? '—' : summary.tuning.bestScore.toFixed(2)
    }`
  );
  lines.push('');

  if (!plateau) {
    lines.push('## 依頼（現時点）');
    lines.push('- **ロジック変更は原則不要。** 箱庭学習を続けて数値探索を進めてください。');
    lines.push('- 触ってよいのはバグ修正（壁LOS・虚空・めり込み等）とテスト追加のみ。');
    lines.push('- `CombatProfiles` の数値微調整や優先順位入れ替えはしない。');
    lines.push('');
  } else {
    lines.push('## 依頼（数値頭打ち → ロジック修正）');
    lines.push('以下の失敗クラスタとトレースを読み、**ルールベース**の戦闘ロジックを改善してください。');
    lines.push('');
    lines.push('- 触ってよい範囲: `src/combat/` と `tests/simulator*.ts` / `src/simulator/` の回帰');
    lines.push('- 原則触らない: `src/reflexes/Reflexes.ts` の Mineflayer 固有（pathfinder / PVP）');
    lines.push('- 数値の勘チューニングはしない（自動チューニングに任せる）');
    lines.push('- 受け入れ: 下記シードで死亡・大被弾が減ること、`npm test` の simulator 系が落ちないこと');
    lines.push('');
  }

  lines.push('## 集計');
  lines.push(`- 生成時刻: ${summary.generatedAt}`);
  lines.push(`- エピソード数: ${summary.episodes}`);
  lines.push(`- 勝率: ${(summary.winRate * 100).toFixed(1)}%`);
  lines.push(`- 死亡率: ${(summary.deathRate * 100).toFixed(1)}%`);
  lines.push(`- 平均被弾: ${summary.avgDamage.toFixed(2)}`);
  lines.push(`- 平均スコア: ${summary.avgScore.toFixed(2)}`);
  lines.push('');
  lines.push('## 失敗クラスタ');
  if (summary.clusters.length === 0) {
    lines.push('- （失敗クラスタなし）');
  } else {
    for (const cluster of summary.clusters) {
      lines.push(`### ${cluster.label}（${cluster.kind}）× ${cluster.count}`);
      lines.push(`- 代表シード: ${cluster.seeds.join(', ') || '—'}`);
      for (const sample of cluster.samples) {
        lines.push(`- サンプル seed=${sample.seed} arena=${sample.arenaKind} score=${sample.score.toFixed(2)} damage=${sample.damageTaken}`);
        lines.push('```');
        lines.push(formatTrace(sample.trace));
        lines.push('```');
      }
      lines.push('');
    }
  }

  lines.push('## ワースト結果');
  for (const item of worst) {
    lines.push(
      `- seed=${item.seed} arena=${item.arenaKind} score=${item.score.toFixed(2)} `
      + `hp=${item.botHp} dmg=${item.damageTaken} fail=${item.failureKind || '—'} preset=${item.presetId}`
    );
  }
  lines.push('');
  lines.push('## 再現コマンド');
  const seeds = [...new Set(summary.clusters.flatMap((cluster) => cluster.seeds))].slice(0, 8);
  if (seeds.length === 0 && worst[0]) seeds.push(worst[0].seed);
  lines.push('```bash');
  lines.push('# 箱庭サーバ起動後:');
  for (const seed of seeds) {
    lines.push(`curl -s -X POST http://127.0.0.1:4173/api/gym/replay -H "content-type: application/json" -d "{\\"seed\\":${seed}}"`);
  }
  lines.push('npm test -- tests/simulator.test.ts');
  lines.push('```');
  lines.push('');
  lines.push('## アリーナ別');
  for (const [name, row] of Object.entries(summary.byArena)) {
    const winRate = row.episodes ? ((row.wins / row.episodes) * 100).toFixed(0) : '0';
    lines.push(`- ${name}: n=${row.episodes} win=${winRate}% death=${row.deaths}`);
  }
  lines.push('');
  lines.push('## プリセット別');
  for (const [name, row] of Object.entries(summary.byPreset)) {
    lines.push(`- ${name}: n=${row.episodes} avgScore=${row.avgScore.toFixed(2)} wins=${row.wins}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatTrace(trace: TraceSample[]): string {
  if (!trace.length) return '(trace empty)';
  return trace.map((sample) => (
    `t=${sample.tick} move=${sample.movement} intent=${sample.intent || '-'} hp=${sample.botHp} `
    + `bot=(${fmt(sample.bot.x)},${fmt(sample.bot.y)},${fmt(sample.bot.z)}) `
    + `enemies=[${sample.enemies.map((enemy) => `${enemy.kind}@(${fmt(enemy.x)},${fmt(enemy.y)},${fmt(enemy.z)})hp${enemy.hp}`).join('; ')}]`
  )).join('\n');
}

function fmt(value: number): string {
  return value.toFixed(1);
}
