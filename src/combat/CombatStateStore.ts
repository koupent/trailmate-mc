import fs from 'node:fs';
import path from 'node:path';
import type { CombatContext, CombatPresetId } from './CombatProfiles.js';
import { contextKey } from './CombatProfiles.js';
import { filterSimTuneOverlay } from './CombatTuneCatalog.js';
import type { ParamOverlay } from './ParamTuner.js';
import {
  ALL_SITUATION_IDS,
  type SituationId
} from './EncounterSituation.js';
import {
  mergeUtilityWeights,
  type UtilityWeights
} from './CombatUtility.js';

/** v4: 状況型ごとの効用重み。v3 のプリセット数値オーバーレイも維持。 */
export const COMBAT_STATE_VERSION = 4;

export type PresetStats = {
  trials: number;
  totalScore: number;
  avgScore: number;
  deaths: number;
  damageSum: number;
  kills: number;
};

export type ContextLearningState = {
  selectedPresetId: CombatPresetId;
  bestPresetId: CombatPresetId;
  consecutiveWorse: number;
  exploreCooldownUntil: number;
  presets: Record<string, PresetStats>;
  /** 選択プリセットに重ねる自動チューニング結果。 */
  tunedParams: ParamOverlay | null;
  tunedBestScore: number;
  paramExploreCount: number;
  paramAdoptCount: number;
  noImproveStreak: number;
};

export type SituationLearningState = {
  /** 採用済み重み（未設定キーは default）。 */
  weights: Partial<UtilityWeights>;
  bestBankScore: number;
  exploreCount: number;
  adoptCount: number;
  noImproveStreak: number;
};

export type CombatStateFile = {
  version: number;
  updatedAt: number;
  contexts: Record<string, ContextLearningState>;
  situations: Record<string, SituationLearningState>;
  enemyNameStats: Record<string, { fights: number; damage: number; kills: number }>;
};

export function emptySituationLearning(id: SituationId): SituationLearningState {
  return {
    weights: {},
    bestBankScore: Number.NEGATIVE_INFINITY,
    exploreCount: 0,
    adoptCount: 0,
    noImproveStreak: 0
  };
}

export function emptyCombatState(): CombatStateFile {
  const situations: Record<string, SituationLearningState> = {};
  for (const id of ALL_SITUATION_IDS) {
    situations[id] = emptySituationLearning(id);
  }
  return {
    version: COMBAT_STATE_VERSION,
    updatedAt: 0,
    contexts: {},
    situations,
    enemyNameStats: {}
  };
}

export function emptyPresetStats(): PresetStats {
  return {
    trials: 0,
    totalScore: 0,
    avgScore: 0,
    deaths: 0,
    damageSum: 0,
    kills: 0
  };
}

function emptyContextLearning(fallbackPresetId: CombatPresetId): ContextLearningState {
  return {
    selectedPresetId: fallbackPresetId,
    bestPresetId: fallbackPresetId,
    consecutiveWorse: 0,
    exploreCooldownUntil: 0,
    presets: {},
    tunedParams: null,
    tunedBestScore: Number.NEGATIVE_INFINITY,
    paramExploreCount: 0,
    paramAdoptCount: 0,
    noImproveStreak: 0
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readParamOverlay(raw: unknown): ParamOverlay | null {
  if (!isObject(raw)) return null;
  const out: ParamOverlay = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      (out as Record<string, number>)[key] = n;
    }
  }
  // 古いJSONに残った探索外キーは読み込み時に捨てる
  return filterSimTuneOverlay(out);
}

export function normalizeCombatState(raw: unknown): CombatStateFile {
  if (!isObject(raw)) return emptyCombatState();
  const version = Number(raw.version);
  // v2/v3 は状況重み無しで引き継ぎ、v4 へ昇格。
  if (version !== 2 && version !== 3 && version !== COMBAT_STATE_VERSION) {
    return emptyCombatState();
  }
  const state = emptyCombatState();
  state.updatedAt = Number(raw.updatedAt) || 0;
  if (isObject(raw.contexts)) {
    for (const [key, value] of Object.entries(raw.contexts)) {
      if (!isObject(value)) continue;
      const presets: Record<string, PresetStats> = {};
      if (isObject(value.presets)) {
        for (const [presetId, stats] of Object.entries(value.presets)) {
          if (!isObject(stats)) continue;
          presets[presetId] = {
            trials: Math.max(0, Number(stats.trials) || 0),
            totalScore: Number(stats.totalScore) || 0,
            avgScore: Number(stats.avgScore) || 0,
            deaths: Math.max(0, Number(stats.deaths) || 0),
            damageSum: Math.max(0, Number(stats.damageSum) || 0),
            kills: Math.max(0, Number(stats.kills) || 0)
          };
        }
      }
      const fallback = String(value.bestPresetId || value.selectedPresetId || 'melee-baseline');
      state.contexts[key] = {
        selectedPresetId: String(value.selectedPresetId || fallback),
        bestPresetId: String(value.bestPresetId || fallback),
        consecutiveWorse: Math.max(0, Number(value.consecutiveWorse) || 0),
        exploreCooldownUntil: Number(value.exploreCooldownUntil) || 0,
        presets,
        tunedParams: readParamOverlay(value.tunedParams),
        tunedBestScore: Number.isFinite(Number(value.tunedBestScore))
          ? Number(value.tunedBestScore)
          : Number.NEGATIVE_INFINITY,
        paramExploreCount: Math.max(0, Number(value.paramExploreCount) || 0),
        paramAdoptCount: Math.max(0, Number(value.paramAdoptCount) || 0),
        noImproveStreak: Math.max(0, Number(value.noImproveStreak) || 0)
      };
    }
  }
  if (isObject(raw.situations)) {
    for (const id of ALL_SITUATION_IDS) {
      const value = raw.situations[id];
      if (!isObject(value)) continue;
      const weightsRaw = isObject(value.weights) ? value.weights : {};
      const weights: Partial<UtilityWeights> = {};
      for (const [k, v] of Object.entries(weightsRaw)) {
        const n = Number(v);
        if (Number.isFinite(n)) (weights as Record<string, number>)[k] = n;
      }
      state.situations[id] = {
        weights,
        bestBankScore: Number.isFinite(Number(value.bestBankScore))
          ? Number(value.bestBankScore)
          : Number.NEGATIVE_INFINITY,
        exploreCount: Math.max(0, Number(value.exploreCount) || 0),
        adoptCount: Math.max(0, Number(value.adoptCount) || 0),
        noImproveStreak: Math.max(0, Number(value.noImproveStreak) || 0)
      };
    }
  }
  if (isObject(raw.enemyNameStats)) {
    for (const [name, value] of Object.entries(raw.enemyNameStats)) {
      if (!isObject(value)) continue;
      state.enemyNameStats[name] = {
        fights: Math.max(0, Number(value.fights) || 0),
        damage: Math.max(0, Number(value.damage) || 0),
        kills: Math.max(0, Number(value.kills) || 0)
      };
    }
  }
  return state;
}

export class CombatStateStore {
  private state: CombatStateFile;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  getSnapshot(): CombatStateFile {
    return this.state;
  }

  getContextState(ctx: CombatContext, fallbackPresetId: CombatPresetId): ContextLearningState {
    const key = contextKey(ctx);
    let entry = this.state.contexts[key];
    if (!entry) {
      entry = emptyContextLearning(fallbackPresetId);
      this.state.contexts[key] = entry;
      this.dirty = true;
    }
    if (!entry.selectedPresetId) entry.selectedPresetId = fallbackPresetId;
    if (!entry.bestPresetId) entry.bestPresetId = fallbackPresetId;
    if (entry.tunedParams === undefined) entry.tunedParams = null;
    if (!Number.isFinite(entry.tunedBestScore)) entry.tunedBestScore = Number.NEGATIVE_INFINITY;
    entry.paramExploreCount = Math.max(0, entry.paramExploreCount || 0);
    entry.paramAdoptCount = Math.max(0, entry.paramAdoptCount || 0);
    entry.noImproveStreak = Math.max(0, entry.noImproveStreak || 0);
    return entry;
  }

  recordEpisodeResult(opts: {
    ctx: CombatContext;
    presetId: CombatPresetId;
    score: number;
    damageTaken: number;
    kills: number;
    died: boolean;
    enemyName: string | null;
  }): ContextLearningState {
    const baseline = opts.presetId;
    const entry = this.getContextState(opts.ctx, baseline);
    const stats = entry.presets[opts.presetId] || emptyPresetStats();
    stats.trials += 1;
    stats.totalScore += opts.score;
    stats.avgScore = stats.totalScore / stats.trials;
    stats.damageSum += opts.damageTaken;
    stats.kills += opts.kills;
    if (opts.died) stats.deaths += 1;
    entry.presets[opts.presetId] = stats;

    const name = opts.enemyName || 'unknown';
    const nameStats = this.state.enemyNameStats[name] || { fights: 0, damage: 0, kills: 0 };
    nameStats.fights += 1;
    nameStats.damage += opts.damageTaken;
    nameStats.kills += opts.kills;
    this.state.enemyNameStats[name] = nameStats;

    this.dirty = true;
    this.scheduleSave();
    return entry;
  }

  setSelectedPreset(ctx: CombatContext, presetId: CombatPresetId, asBest = false): void {
    const entry = this.getContextState(ctx, presetId);
    entry.selectedPresetId = presetId;
    if (asBest) entry.bestPresetId = presetId;
    this.dirty = true;
    this.scheduleSave();
  }

  setExploreCooldown(ctx: CombatContext, until: number): void {
    const entry = this.getContextState(ctx, 'melee-baseline');
    entry.exploreCooldownUntil = until;
    this.dirty = true;
    this.scheduleSave();
  }

  setConsecutiveWorse(ctx: CombatContext, value: number): void {
    const entry = this.getContextState(ctx, 'melee-baseline');
    entry.consecutiveWorse = value;
    this.dirty = true;
    this.scheduleSave();
  }

  setTunedParams(ctx: CombatContext, overlay: ParamOverlay | null): void {
    const entry = this.getContextState(ctx, 'melee-baseline');
    entry.tunedParams = filterSimTuneOverlay(overlay, ctx.enemyClass);
    this.dirty = true;
    this.scheduleSave();
  }

  setParamTuningMeta(ctx: CombatContext, patch: {
    tunedBestScore?: number;
    paramExploreCount?: number;
    paramAdoptCount?: number;
    noImproveStreak?: number;
  }): void {
    const entry = this.getContextState(ctx, 'melee-baseline');
    if (patch.tunedBestScore != null) entry.tunedBestScore = patch.tunedBestScore;
    if (patch.paramExploreCount != null) entry.paramExploreCount = patch.paramExploreCount;
    if (patch.paramAdoptCount != null) entry.paramAdoptCount = patch.paramAdoptCount;
    if (patch.noImproveStreak != null) entry.noImproveStreak = patch.noImproveStreak;
    this.dirty = true;
    this.scheduleSave();
  }

  getSituationState(situationId: SituationId): SituationLearningState {
    let entry = this.state.situations[situationId];
    if (!entry) {
      entry = emptySituationLearning(situationId);
      this.state.situations[situationId] = entry;
      this.dirty = true;
    }
    entry.exploreCount = Math.max(0, entry.exploreCount || 0);
    entry.adoptCount = Math.max(0, entry.adoptCount || 0);
    entry.noImproveStreak = Math.max(0, entry.noImproveStreak || 0);
    if (!entry.weights) entry.weights = {};
    if (!Number.isFinite(entry.bestBankScore)) entry.bestBankScore = Number.NEGATIVE_INFINITY;
    return entry;
  }

  getMergedSituationWeights(situationId: SituationId): UtilityWeights {
    const entry = this.getSituationState(situationId);
    return mergeUtilityWeights(situationId, entry.weights);
  }

  setSituationWeights(
    situationId: SituationId,
    weights: Partial<UtilityWeights>,
    meta?: Partial<Pick<SituationLearningState, 'bestBankScore' | 'exploreCount' | 'adoptCount' | 'noImproveStreak'>>
  ): void {
    const entry = this.getSituationState(situationId);
    entry.weights = { ...weights };
    if (meta?.bestBankScore != null) entry.bestBankScore = meta.bestBankScore;
    if (meta?.exploreCount != null) entry.exploreCount = meta.exploreCount;
    if (meta?.adoptCount != null) entry.adoptCount = meta.adoptCount;
    if (meta?.noImproveStreak != null) entry.noImproveStreak = meta.noImproveStreak;
    this.dirty = true;
    this.scheduleSave();
  }

  patchSituationMeta(
    situationId: SituationId,
    meta: Partial<Pick<SituationLearningState, 'bestBankScore' | 'exploreCount' | 'adoptCount' | 'noImproveStreak'>>
  ): void {
    const entry = this.getSituationState(situationId);
    if (meta.bestBankScore != null) entry.bestBankScore = meta.bestBankScore;
    if (meta.exploreCount != null) entry.exploreCount = meta.exploreCount;
    if (meta.adoptCount != null) entry.adoptCount = meta.adoptCount;
    if (meta.noImproveStreak != null) entry.noImproveStreak = meta.noImproveStreak;
    this.dirty = true;
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.writeAtomic();
    this.dirty = false;
  }

  /** 箱庭学習用の統計を空に戻す（本番 combat-state.json とは別ファイル想定）。 */
  reset(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.state = emptyCombatState();
    this.dirty = true;
    this.writeAtomic();
    this.dirty = false;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 2500);
  }

  private load(): CombatStateFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyCombatState();
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return normalizeCombatState(raw);
    } catch (err) {
      this.quarantineCorruptFile();
      console.warn(
        '[combat] failed to load combat-state.json, using defaults:',
        (err as Error).message || err
      );
      return emptyCombatState();
    }
  }

  private quarantineCorruptFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(this.filePath, `${this.filePath}.corrupt-${stamp}`);
    } catch {
      /* 失敗は無視する */
    }
  }

  private writeAtomic(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.state.updatedAt = Date.now();
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(
        '[combat] failed to save combat-state.json:',
        (err as Error).message || err
      );
    }
  }
}
