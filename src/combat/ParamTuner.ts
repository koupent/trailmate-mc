/**
 * 箱庭向けの連続パラメータ探索。
 * 優先順位や分岐ロジックは触らず、PRESET_BOUNDS 内の厳選数値だけを動かす。
 *
 * 探索キーは CombatTuneCatalog（敵クラス別）。本番間合いは LIVE_TUNABLE に分離。
 */

import {
  ALL_SIM_TUNABLE_KEYS,
  CLASS_TUNABLE_KEYS,
  ENEMY_CLASS_LABELS,
  filterSimTuneOverlay,
  tunableKeysForClass,
  type SimTuneKey
} from './CombatTuneCatalog.js';
import {
  clampPreset,
  getPresetParams,
  PRESET_BOUNDS,
  type CombatPresetId,
  type CombatPresetParams,
  type EnemyClass
} from './CombatProfiles.js';

/** @deprecated 互換エイリアス。実体は ALL_SIM_TUNABLE_KEYS */
export const TUNABLE_PARAM_KEYS = ALL_SIM_TUNABLE_KEYS;

/**
 * 本番 bot（Reflexes / PVP 間合い）向け。箱庭ジムでは探索しない。
 */
export const LIVE_TUNABLE_PARAM_KEYS = [
  'followRange',
  'kiteFollowRange',
  'backstepRange',
  'strafeRange',
  'creeperFollowRange',
  'positioningImprovementMarginDeg',
  'arcNarrowEnterSpanDeg',
  'arcNarrowExitSpanDeg',
  'crowdAvoidBias'
] as const satisfies ReadonlyArray<keyof CombatPresetParams>;

export type TunableParamKey = SimTuneKey;
export type LiveTunableParamKey = (typeof LIVE_TUNABLE_PARAM_KEYS)[number];

export type ParamOverlay = Partial<CombatPresetParams>;

export type TuningStatusMode =
  | 'exploring'
  | 'converging'
  | 'plateau-logic-bottleneck';

export type TuningStatus = {
  mode: TuningStatusMode;
  paramExploreCount: number;
  paramAdoptCount: number;
  noImproveStreak: number;
  bestScore: number | null;
  summary: string;
};

const STEP_RATIO = 0.12;

export function applyParamOverlay(
  presetId: CombatPresetId,
  overlay: ParamOverlay | null | undefined
): CombatPresetParams {
  const base = getPresetParams(presetId);
  if (!overlay) return base;
  return clampPreset({ ...base, ...overlay });
}

export function mutateParamOverlay(
  base: CombatPresetParams,
  overlay: ParamOverlay | null | undefined,
  rng: () => number = Math.random,
  enemyClass?: EnemyClass
): ParamOverlay {
  return mutateParamOverlayDetailed(base, overlay, rng, enemyClass).overlay;
}

export type ParamMutation = {
  overlay: ParamOverlay;
  changedKeys: TunableParamKey[];
  changes: Array<{ key: TunableParamKey; from: number; to: number }>;
};

/** 変更したキーも返す。enemyClass 指定時はそのクラスのキーだけを微調整。 */
export function mutateParamOverlayDetailed(
  base: CombatPresetParams,
  overlay: ParamOverlay | null | undefined,
  rng: () => number = Math.random,
  enemyClass?: EnemyClass
): ParamMutation {
  const merged = clampPreset({ ...base, ...(overlay || {}) });
  const keys = [...(enemyClass ? tunableKeysForClass(enemyClass) : ALL_SIM_TUNABLE_KEYS)];
  if (keys.length === 0) {
    return { overlay: { ...(overlay || {}) }, changedKeys: [], changes: [] };
  }
  const count = Math.min(keys.length, rng() < 0.55 ? 1 : 2);
  const next: ParamOverlay = { ...(overlay || {}) };
  const changedKeys: TunableParamKey[] = [];
  const changes: ParamMutation['changes'] = [];
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor(rng() * keys.length);
    const key = keys[index];
    const { min, max } = PRESET_BOUNDS[key];
    const span = max - min;
    const delta = (rng() * 2 - 1) * span * STEP_RATIO;
    const from = Number(merged[key]);
    const value = Math.min(max, Math.max(min, from + delta));
    next[key] = value;
    if (!changedKeys.includes(key)) {
      changedKeys.push(key);
      changes.push({ key, from, to: value });
    } else {
      const row = changes.find((item) => item.key === key);
      if (row) row.to = value;
    }
  }
  return { overlay: next, changedKeys, changes };
}

export function describeTuningStatus(opts: {
  paramExploreCount: number;
  paramAdoptCount: number;
  noImproveStreak: number;
  bestScore: number | null;
  minExploresForPlateau?: number;
  plateauStreak?: number;
}): TuningStatus {
  const minExplores = opts.minExploresForPlateau ?? 10;
  const plateauNeed = opts.plateauStreak ?? 6;
  const best = opts.bestScore;
  if (
    opts.paramExploreCount >= minExplores
    && opts.noImproveStreak >= plateauNeed
  ) {
    return {
      mode: 'plateau-logic-bottleneck',
      paramExploreCount: opts.paramExploreCount,
      paramAdoptCount: opts.paramAdoptCount,
      noImproveStreak: opts.noImproveStreak,
      bestScore: best,
      summary: '数値探索は頭打ち。失敗クラスタはロジック修正候補。'
    };
  }
  if (opts.paramAdoptCount > 0 && opts.noImproveStreak < 3) {
    return {
      mode: 'converging',
      paramExploreCount: opts.paramExploreCount,
      paramAdoptCount: opts.paramAdoptCount,
      noImproveStreak: opts.noImproveStreak,
      bestScore: best,
      summary: '自動チューニングが改善を取り込んでいる。数値は触らない。'
    };
  }
  return {
    mode: 'exploring',
    paramExploreCount: opts.paramExploreCount,
    paramAdoptCount: opts.paramAdoptCount,
    noImproveStreak: opts.noImproveStreak,
    bestScore: best,
    summary: '敵クラス別の厳選パラメータを箱庭が探索中。ロジック変更は原則不要。'
  };
}

export const TUNABLE_PARAM_META: Record<
  TunableParamKey,
  { label: string; unit: string; blurb: string }
> = {
  rangedDodgeBurstMs: {
    label: '回避バースト',
    unit: 'ms',
    blurb: '遠距離圧の横回避を続ける時間（箱庭↔本番の感触差を吸収）'
  },
  rangedDodgeReassessMs: {
    label: '前進コミット',
    unit: 'ms',
    blurb: '回避後に詰めに入る時間（矢速・距離感の差を吸収）'
  },
  creeperSoftEvadeRange: {
    label: 'クリーパー警戒',
    unit: 'm',
    blurb: '着火退避・危険帯の目安距離（箱庭↔本番の差を吸収）'
  }
};

export const LIVE_TUNABLE_PARAM_META: Record<
  LiveTunableParamKey,
  { label: string; unit: string; blurb: string }
> = {
  followRange: { label: '接近間合い', unit: 'm', blurb: '本番PVPの基本寄り距離' },
  kiteFollowRange: { label: 'カイト間合い', unit: 'm', blurb: '本番の遠距離・低HP間合い' },
  backstepRange: { label: '後退距離', unit: 'm', blurb: '本番で近すぎたときの一歩後退' },
  strafeRange: { label: '横移動幅', unit: 'm', blurb: '本番の織り歩き幅' },
  creeperFollowRange: { label: 'クリーパー追従', unit: 'm', blurb: '本番クリーパー戦の経路間合い' },
  positioningImprovementMarginDeg: {
    label: '扇改善閾値',
    unit: '°',
    blurb: '本番位置取りを動かす最小改善'
  },
  arcNarrowEnterSpanDeg: {
    label: '扇ラッチ開始',
    unit: '°',
    blurb: '本番の扇ラッチ開始角（箱庭は決定論のため探索外）'
  },
  arcNarrowExitSpanDeg: {
    label: '扇閉じ目安',
    unit: '°',
    blurb: '本番ヒステリシス用（箱庭は定数化のため探索外）'
  },
  crowdAvoidBias: { label: '集団回避バイアス', unit: '', blurb: '本番の複数敵からの逃げ混み' }
};

export type TuningParamRow = {
  key: TunableParamKey;
  label: string;
  unit: string;
  blurb: string;
  min: number;
  max: number;
  base: number;
  current: number;
  tuned: boolean;
  delta: number;
};

export type TuningContextRow = {
  key: string;
  label: string;
  enemyClass: EnemyClass;
  presetId: string;
  status: TuningStatus;
  paramExploreCount: number;
  paramAdoptCount: number;
  noImproveStreak: number;
  bestScore: number | null;
  tunedKeys: SimTuneKey[];
  params: TuningParamRow[];
};

export type TuningClassCatalog = {
  enemyClass: EnemyClass;
  label: string;
  keys: Array<{
    key: TunableParamKey;
    label: string;
    unit: string;
    blurb: string;
    min: number;
    max: number;
  }>;
};

export type TuningDashboard = {
  aggregate: TuningStatus;
  method: {
    tunableCount: number;
    mutateKeysPerTrial: string;
    stepRatio: number;
    note: string;
  };
  /** 全クラス和集合（フラット） */
  catalog: Array<{
    key: TunableParamKey;
    label: string;
    unit: string;
    blurb: string;
    min: number;
    max: number;
  }>;
  /** クラス別の厳選キー（UI主表示） */
  byClass: TuningClassCatalog[];
  contexts: TuningContextRow[];
  recentTrials?: ParamTrialView[];
  lastEpisode?: LastEpisodeView | null;
};

export type ParamTrialView = {
  seed: number;
  arenaKind: string;
  contextLabel: string;
  enemyClass: string;
  hasShield: boolean;
  enemyKinds: string[];
  presetId: string;
  changedKeys: string[];
  changes: Array<{ key: string; label: string; from: number; to: number; unit: string }>;
  score: number;
  win: boolean;
  died: boolean;
  outcome: 'adopted' | 'rejected';
};

export type LastEpisodeView = {
  seed: number;
  arenaKind: string;
  contextLabel: string;
  enemyKinds: string[];
  presetId: string;
  exploringParams: boolean;
  exploringPreset: boolean;
  changedKeys: string[];
  score: number;
  win: boolean;
  died: boolean;
  paramsAdopted: boolean;
  intentLabel: string;
};

function parseContextKey(key: string): { enemyClass: EnemyClass; label: string } {
  const [enemyClassRaw, shieldFlag] = key.split('|');
  const enemyClass = (['melee', 'agile', 'ranged', 'explosive'].includes(enemyClassRaw)
    ? enemyClassRaw
    : 'melee') as EnemyClass;
  const shield = shieldFlag === '1' ? '盾あり' : '盾なし';
  return {
    enemyClass,
    label: `${ENEMY_CLASS_LABELS[enemyClass]} / ${shield}`
  };
}

function catalogEntry(key: TunableParamKey) {
  return {
    key,
    label: TUNABLE_PARAM_META[key].label,
    unit: TUNABLE_PARAM_META[key].unit,
    blurb: TUNABLE_PARAM_META[key].blurb,
    min: PRESET_BOUNDS[key].min,
    max: PRESET_BOUNDS[key].max
  };
}

export function buildTuningDashboard(opts: {
  aggregate: TuningStatus;
  contexts: Record<
    string,
    {
      selectedPresetId: string;
      tunedParams: ParamOverlay | null;
      tunedBestScore: number;
      paramExploreCount: number;
      paramAdoptCount: number;
      noImproveStreak: number;
    }
  >;
}): TuningDashboard {
  const catalog = ALL_SIM_TUNABLE_KEYS.map(catalogEntry);
  const byClass: TuningClassCatalog[] = (
    Object.keys(CLASS_TUNABLE_KEYS) as EnemyClass[]
  )
    .map((enemyClass) => ({
      enemyClass,
      label: ENEMY_CLASS_LABELS[enemyClass],
      keys: tunableKeysForClass(enemyClass).map(catalogEntry)
    }))
    // UIは探索対象があるクラスだけ出す（近接・敏捷の空ブロックで「たくさん」に見えないように）
    .filter((group) => group.keys.length > 0);

  const contexts: TuningContextRow[] = Object.entries(opts.contexts)
    .map(([key, entry]) => {
      const { enemyClass, label } = parseContextKey(key);
      const classKeys = tunableKeysForClass(enemyClass);
      if (classKeys.length === 0) return null;
      const presetId = entry.selectedPresetId as CombatPresetId;
      const cleanedOverlay = filterSimTuneOverlay(entry.tunedParams, enemyClass);
      const base = getPresetParams(presetId);
      const current = applyParamOverlay(presetId, cleanedOverlay);
      const params: TuningParamRow[] = classKeys.map((paramKey) => {
        const baseValue = Number(base[paramKey]);
        const currentValue = Number(current[paramKey]);
        const tuned = cleanedOverlay != null
          && Object.prototype.hasOwnProperty.call(cleanedOverlay, paramKey);
        return {
          key: paramKey,
          label: TUNABLE_PARAM_META[paramKey].label,
          unit: TUNABLE_PARAM_META[paramKey].unit,
          blurb: TUNABLE_PARAM_META[paramKey].blurb,
          min: PRESET_BOUNDS[paramKey].min,
          max: PRESET_BOUNDS[paramKey].max,
          base: baseValue,
          current: currentValue,
          tuned,
          delta: currentValue - baseValue
        };
      });
      const bestScore = Number.isFinite(entry.tunedBestScore)
        ? entry.tunedBestScore
        : null;
      return {
        key,
        label,
        enemyClass,
        presetId,
        status: describeTuningStatus({
          paramExploreCount: entry.paramExploreCount,
          paramAdoptCount: entry.paramAdoptCount,
          noImproveStreak: entry.noImproveStreak,
          bestScore
        }),
        paramExploreCount: entry.paramExploreCount,
        paramAdoptCount: entry.paramAdoptCount,
        noImproveStreak: entry.noImproveStreak,
        bestScore,
        tunedKeys: params.filter((row) => row.tuned).map((row) => row.key),
        params
      };
    })
    .filter((row): row is TuningContextRow => row != null)
    .sort((a, b) => b.paramExploreCount - a.paramExploreCount || a.key.localeCompare(b.key));

  return {
    aggregate: opts.aggregate,
    method: {
      tunableCount: ALL_SIM_TUNABLE_KEYS.length,
      mutateKeysPerTrial: '1〜2個（当該クラスのみ）',
      stepRatio: STEP_RATIO,
      note:
        '探索は敵クラス固有3キーのみ'
        + `（${ALL_SIM_TUNABLE_KEYS.join(' / ')}）。`
        + '近接・敏捷・効用重み・本番間合いは表示も探索もしない。'
    },
    catalog,
    byClass,
    contexts
  };
}
