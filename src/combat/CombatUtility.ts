/**
 * 幾何スコア式と型別の少数重み。
 *
 * score = -wSpan·扇広さ - wShot·射線露出 - wMeleeGap·近接ギャップ
 *         + wFocus·主対象接近 - wEdge·端詰まり
 *
 * CORE: 扇狭窄を最優先するため wSpan は常に正。学習は重みの微調整のみ。
 */

import { computeThreatArc, spanDegrees, type XZ } from './threatArc.js';
import { classifyEnemy } from './CombatProfiles.js';
import {
  classifyEncounterSituation,
  situationMeta,
  type EncounterSituation,
  type SituationId
} from './EncounterSituation.js';

export type UtilityWeightKey =
  | 'wSpan'
  | 'wShot'
  | 'wMeleeGap'
  | 'wFocus'
  | 'wEdge';

export type UtilityWeights = Record<UtilityWeightKey, number>;

export type UtilityTerm = {
  key: UtilityWeightKey;
  label: string;
  /** 正規化特徴量 0〜1 前後 */
  feature: number;
  weight: number;
  /** スコアへの寄与（符号込み） */
  contribution: number;
};

export type UtilityScore = {
  score: number;
  terms: UtilityTerm[];
  spanDeg: number | null;
};

export type CombatPhaseId =
  | 'narrow'
  | 'cover-melee'
  | 'finish-melee'
  | 'kite-ranged'
  | 'evade-creeper'
  | 'strike';

export type CombatPhase = {
  id: CombatPhaseId;
  label: string;
  blurb: string;
};

export const UTILITY_WEIGHT_KEYS: UtilityWeightKey[] = [
  'wSpan',
  'wShot',
  'wMeleeGap',
  'wFocus',
  'wEdge'
];

export const UTILITY_WEIGHT_META: Record<
  UtilityWeightKey,
  { label: string; role: string; sign: '-' | '+' }
> = {
  wSpan: { label: '扇の広さ', role: '狭いほど良い（CORE）', sign: '-' },
  wShot: { label: '射線露出', role: '矢が届きにくいほど良い', sign: '-' },
  wMeleeGap: { label: '近接ギャップ', role: '近接との間合いが遠すぎない', sign: '-' },
  wFocus: { label: '主対象接近', role: '今殴る相手へ寄る', sign: '+' },
  wEdge: { label: '端詰まり', role: 'マップ端へ逃げない', sign: '-' }
};

/** 人間が読める方程式（UI表示用）。 */
export const UTILITY_EQUATION =
  'score = −wSpan·扇広さ − wShot·射線露出 − wMeleeGap·近接ギャップ + wFocus·主対象接近 − wEdge·端詰まり';

export const UTILITY_WEIGHT_BOUNDS: Record<UtilityWeightKey, { min: number; max: number }> = {
  wSpan: { min: 0.4, max: 2.4 },
  wShot: { min: 0.2, max: 2.2 },
  wMeleeGap: { min: 0.1, max: 1.8 },
  wFocus: { min: 0.2, max: 2.0 },
  wEdge: { min: 0.2, max: 1.8 }
};

const DEFAULT_BY_SITUATION: Record<SituationId, UtilityWeights> = {
  single: {
    wSpan: 0.6, wShot: 1.0, wMeleeGap: 0.4, wFocus: 1.4, wEdge: 0.8
  },
  'melee-crowd': {
    wSpan: 1.6, wShot: 0.3, wMeleeGap: 0.8, wFocus: 1.0, wEdge: 0.9
  },
  'ranged-multi': {
    wSpan: 1.5, wShot: 1.6, wMeleeGap: 0.3, wFocus: 1.1, wEdge: 1.1
  },
  'mixed-ranged-melee': {
    wSpan: 1.3, wShot: 1.4, wMeleeGap: 1.2, wFocus: 1.3, wEdge: 1.2
  },
  'explosive-mixed': {
    wSpan: 1.0, wShot: 1.1, wMeleeGap: 0.7, wFocus: 0.9, wEdge: 1.0
  }
};

export function defaultUtilityWeights(situationId: SituationId): UtilityWeights {
  return { ...DEFAULT_BY_SITUATION[situationId] };
}

export function clampUtilityWeights(weights: UtilityWeights): UtilityWeights {
  const out = { ...weights };
  for (const key of UTILITY_WEIGHT_KEYS) {
    const { min, max } = UTILITY_WEIGHT_BOUNDS[key];
    out[key] = Math.min(max, Math.max(min, Number(out[key]) || min));
  }
  return out;
}

export function mergeUtilityWeights(
  situationId: SituationId,
  overlay: Partial<UtilityWeights> | null | undefined
): UtilityWeights {
  return clampUtilityWeights({
    ...defaultUtilityWeights(situationId),
    ...(overlay || {})
  });
}

export type WeightMutation = {
  overlay: Partial<UtilityWeights>;
  changedKeys: UtilityWeightKey[];
  changes: Array<{ key: UtilityWeightKey; from: number; to: number }>;
};

/** 型ごとに 1〜2 重みだけ動かす（収束しやすい）。 */
export function mutateUtilityWeights(
  situationId: SituationId,
  current: Partial<UtilityWeights> | null | undefined,
  rng: () => number = Math.random
): WeightMutation {
  const base = mergeUtilityWeights(situationId, current);
  const next: Partial<UtilityWeights> = { ...(current || {}) };
  const changedKeys: UtilityWeightKey[] = [];
  const changes: WeightMutation['changes'] = [];
  const count = rng() < 0.6 ? 1 : 2;
  const keys = [...UTILITY_WEIGHT_KEYS];
  for (let i = 0; i < count; i += 1) {
    const key = keys[Math.floor(rng() * keys.length)];
    const { min, max } = UTILITY_WEIGHT_BOUNDS[key];
    const span = max - min;
    const from = base[key];
    const to = Math.min(max, Math.max(min, from + (rng() * 2 - 1) * span * 0.14));
    next[key] = to;
    if (!changedKeys.includes(key)) {
      changedKeys.push(key);
      changes.push({ key, from, to });
    } else {
      const row = changes.find((item) => item.key === key);
      if (row) row.to = to;
    }
  }
  return { overlay: next, changedKeys, changes };
}

export const PHASE_META: Record<CombatPhaseId, { label: string; blurb: string }> = {
  narrow: { label: '扇寄せ', blurb: '複数脅威の攻撃角度を狭める' },
  'cover-melee': { label: '近接カバー', blurb: '近接の影に入り矢を減らす' },
  'finish-melee': { label: '近接処理', blurb: '近接を先に落として数を減らす' },
  'kite-ranged': { label: '遠距離処理', blurb: '回避と前進で遠距離を詰める' },
  'evade-creeper': { label: 'クリーパー回避', blurb: '爆発間合いを離す／殴って止める' },
  strike: { label: '打撃', blurb: '射程内で殴る' }
};

export function decideCombatPhase(opts: {
  situation: EncounterSituation;
  spanDeg: number | null;
  arcLatched: boolean;
  creeperDist: number;
  creeperSoft: number;
  meleeDist: number;
  rangedDist: number;
  canStrikeFocus: boolean;
  explosiveDanger: boolean;
}): CombatPhase {
  if (opts.explosiveDanger || (
    opts.situation.explosiveCount > 0
    && opts.creeperDist < opts.creeperSoft
    && !opts.canStrikeFocus
  )) {
    return { id: 'evade-creeper', ...PHASE_META['evade-creeper'] };
  }
  if (opts.canStrikeFocus && opts.meleeDist <= 3.5 && opts.situation.meleeCount > 0) {
    if (opts.arcLatched && (opts.spanDeg == null || opts.spanDeg > 50)) {
      return { id: 'narrow', ...PHASE_META.narrow };
    }
    return { id: 'finish-melee', ...PHASE_META['finish-melee'] };
  }
  if (opts.situation.id === 'mixed-ranged-melee' || opts.situation.id === 'explosive-mixed') {
    if (opts.situation.meleeCount > 0 && opts.meleeDist > 3.5) {
      return { id: 'cover-melee', ...PHASE_META['cover-melee'] };
    }
    if (opts.situation.meleeCount > 0) {
      return { id: 'finish-melee', ...PHASE_META['finish-melee'] };
    }
  }
  if (opts.arcLatched || (opts.spanDeg != null && opts.spanDeg > 40 && opts.situation.total >= 2)) {
    return { id: 'narrow', ...PHASE_META.narrow };
  }
  if (opts.situation.rangedCount > 0) {
    return { id: 'kite-ranged', ...PHASE_META['kite-ranged'] };
  }
  if (opts.canStrikeFocus) return { id: 'strike', ...PHASE_META.strike };
  return { id: 'strike', ...PHASE_META.strike };
}

function dist2(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 候補座標の効用スコア。大きいほど良い。
 */
export function scoreUtilityCandidate(opts: {
  bot: XZ;
  candidate: XZ;
  threats: Array<XZ & { kind?: string }>;
  focus: XZ | null;
  weights: UtilityWeights;
  arenaHalfExtent?: number;
}): UtilityScore {
  const weights = clampUtilityWeights(opts.weights);
  const threats = opts.threats;
  const arc = threats.length >= 2 ? computeThreatArc(opts.candidate, threats) : null;
  const spanDeg = arc ? spanDegrees(arc.spanRad) : null;
  const spanFeature = spanDeg == null ? 0 : Math.min(1, spanDeg / 180);

  const ranged = threats.filter((t) => classifyEnemy(t.kind) === 'ranged');
  let shotFeature = 0;
  if (ranged.length > 0) {
    // 近接を間に挟めているほど射線露出を下げる
    const melee = threats.filter((t) => {
      const cls = classifyEnemy(t.kind);
      return cls !== 'ranged' && cls !== 'explosive';
    });
    let exposure = 0;
    for (const sk of ranged) {
      const d = dist2(opts.candidate, sk);
      let blocked = 0;
      for (const m of melee) {
        const toMelee = dist2(opts.candidate, m);
        const meleeToSk = dist2(m, sk);
        if (toMelee < d && meleeToSk < d && toMelee > 0.8) blocked = 1;
      }
      exposure += (1 - blocked) * Math.min(1, Math.max(0, (12 - d) / 12));
    }
    shotFeature = Math.min(1, exposure / ranged.length);
  }

  const melees = threats.filter((t) => {
    const cls = classifyEnemy(t.kind);
    return cls !== 'ranged' && cls !== 'explosive';
  });
  let meleeGapFeature = 0;
  if (melees.length > 0) {
    const nearest = Math.min(...melees.map((m) => dist2(opts.candidate, m)));
    // 理想は 1.4〜2.2。遠すぎ・近すぎを減点
    const ideal = 1.8;
    meleeGapFeature = Math.min(1, Math.abs(nearest - ideal) / 4);
  }

  let focusFeature = 0;
  if (opts.focus) {
    const d = dist2(opts.candidate, opts.focus);
    focusFeature = Math.max(0, 1 - d / 10);
  }

  const half = opts.arenaHalfExtent ?? 12;
  const edgeDist = Math.min(
    half - Math.abs(opts.candidate.x),
    half - Math.abs(opts.candidate.z)
  );
  const edgeFeature = edgeDist < 2.5 ? Math.min(1, (2.5 - edgeDist) / 2.5) : 0;

  const terms: UtilityTerm[] = [
    {
      key: 'wSpan',
      label: UTILITY_WEIGHT_META.wSpan.label,
      feature: spanFeature,
      weight: weights.wSpan,
      contribution: -weights.wSpan * spanFeature
    },
    {
      key: 'wShot',
      label: UTILITY_WEIGHT_META.wShot.label,
      feature: shotFeature,
      weight: weights.wShot,
      contribution: -weights.wShot * shotFeature
    },
    {
      key: 'wMeleeGap',
      label: UTILITY_WEIGHT_META.wMeleeGap.label,
      feature: meleeGapFeature,
      weight: weights.wMeleeGap,
      contribution: -weights.wMeleeGap * meleeGapFeature
    },
    {
      key: 'wFocus',
      label: UTILITY_WEIGHT_META.wFocus.label,
      feature: focusFeature,
      weight: weights.wFocus,
      contribution: weights.wFocus * focusFeature
    },
    {
      key: 'wEdge',
      label: UTILITY_WEIGHT_META.wEdge.label,
      feature: edgeFeature,
      weight: weights.wEdge,
      contribution: -weights.wEdge * edgeFeature
    }
  ];
  const score = terms.reduce((sum, term) => sum + term.contribution, 0);
  return { score, terms, spanDeg };
}

export function pickBestUtilityCandidate(opts: {
  bot: XZ;
  candidates: XZ[];
  threats: Array<XZ & { kind?: string }>;
  focus: XZ | null;
  weights: UtilityWeights;
  arenaHalfExtent?: number;
  minEnemyDistance?: number;
}): { chosen: XZ; evaluation: UtilityScore } | null {
  if (!opts.candidates.length) return null;
  const minDist = opts.minEnemyDistance ?? 1.55;
  let best: XZ | null = null;
  let bestEval: UtilityScore | null = null;
  for (const candidate of opts.candidates) {
    const nearest = opts.threats.reduce(
      (m, threat) => Math.min(m, dist2(candidate, threat)),
      Infinity
    );
    // 現在地以外で敵に食い込む候補は捨てる（扇寄せテスト・囲まれ死の両方を守る）
    const isStay = dist2(candidate, opts.bot) < 0.05;
    if (!isStay && nearest < minDist) continue;
    const evaluation = scoreUtilityCandidate({
      bot: opts.bot,
      candidate,
      threats: opts.threats,
      focus: opts.focus,
      weights: opts.weights,
      arenaHalfExtent: opts.arenaHalfExtent
    });
    if (!bestEval || evaluation.score > bestEval.score) {
      best = candidate;
      bestEval = evaluation;
    }
  }
  if (!best || !bestEval) return null;
  return { chosen: best, evaluation: bestEval };
}

/** 採用判定用の固定シードバンク（型ごと）。 */
export type SeedBankCase = {
  seed: number;
  kind: 'elevated-ranged' | 'mixed' | 'flat-ranged' | 'pincer' | 'flat-melee';
  situationId: SituationId;
};

export const UTILITY_SEED_BANK: SeedBankCase[] = [
  // mixed-ranged-melee / elevated
  { seed: 653367, kind: 'elevated-ranged', situationId: 'mixed-ranged-melee' },
  { seed: 653403, kind: 'elevated-ranged', situationId: 'mixed-ranged-melee' },
  { seed: 653423, kind: 'elevated-ranged', situationId: 'mixed-ranged-melee' },
  { seed: 653419, kind: 'mixed', situationId: 'mixed-ranged-melee' },
  { seed: 653353, kind: 'mixed', situationId: 'mixed-ranged-melee' },
  // explosive
  { seed: 653442, kind: 'mixed', situationId: 'explosive-mixed' },
  { seed: 653475, kind: 'mixed', situationId: 'explosive-mixed' },
  // ranged-multi / flat
  { seed: 653360, kind: 'flat-ranged', situationId: 'ranged-multi' },
  { seed: 653380, kind: 'flat-ranged', situationId: 'ranged-multi' },
  { seed: 653400, kind: 'flat-ranged', situationId: 'ranged-multi' },
  // melee crowd
  { seed: 653370, kind: 'pincer', situationId: 'melee-crowd' },
  { seed: 653390, kind: 'flat-melee', situationId: 'melee-crowd' }
];

export function seedBankForSituation(situationId: SituationId): SeedBankCase[] {
  const matched = UTILITY_SEED_BANK.filter((item) => item.situationId === situationId);
  const pool = matched.length ? matched : UTILITY_SEED_BANK.slice(0, 4);
  // 学習ループ速度のため型あたり最大2本
  return pool.slice(0, 2);
}

export function describeSituationDashboard(situation: EncounterSituation): string {
  const meta = situationMeta(situation.id);
  return `${meta.label}（遠${situation.rangedCount}/近${situation.meleeCount}/爆${situation.explosiveCount}）`;
}

export { classifyEncounterSituation };
