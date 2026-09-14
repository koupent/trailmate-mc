import {
  baselinePresetId,
  defensivePresetId,
  getPresetParams,
  listPresetsForContext,
  type CombatContext,
  type CombatPresetId,
  type CombatPresetParams
} from './CombatProfiles.js';
import type { CombatEpisode } from './CombatEpisodeTracker.js';
import { scoreEpisode } from './CombatEpisodeTracker.js';
import { CombatStateStore } from './CombatStateStore.js';
import {
  applyParamOverlay,
  buildTuningDashboard,
  describeTuningStatus,
  mutateParamOverlayDetailed,
  type ParamOverlay,
  type TuningDashboard,
  type TuningStatus
} from './ParamTuner.js';
import { tunableKeysForClass, filterSimTuneOverlay } from './CombatTuneCatalog.js';

export type CombatLearningOptions = {
  enabled: boolean;
  exploreRate: number;
  /** 連続パラメータ探索の確率（プリセット探索とは独立）。 */
  paramExploreRate: number;
  minTrials: number;
  minHealthToExplore: number;
  /** 探索中の1エピソードでこの値以上被弾したら即座にロールバックする。 */
  exploreDamageAbort: number;
  /** 悪化した探索結果がこの回数続いたら、探索を短時間休止する。 */
  maxConsecutiveWorse: number;
  exploreCooldownMs: number;
  /** このスコア差以上なら数値オーバーレイを採用する。 */
  paramAdoptMargin: number;
};

export type PresetChoice = {
  presetId: CombatPresetId;
  params: CombatPresetParams;
  reason: 'disabled' | 'baseline' | 'selected' | 'explore' | 'defensive' | 'rollback';
  exploring: boolean;
  exploringParams: boolean;
  paramOverlay: ParamOverlay | null;
  /** この回にいじったキー（数値探索時のみ）。 */
  changedKeys: string[];
  changes: Array<{ key: string; from: number; to: number }>;
};

const DEFAULT_OPTIONS: CombatLearningOptions = {
  enabled: true,
  exploreRate: 0.12,
  paramExploreRate: 0.28,
  minTrials: 3,
  minHealthToExplore: 12,
  exploreDamageAbort: 8,
  maxConsecutiveWorse: 2,
  exploreCooldownMs: 45000,
  paramAdoptMargin: 0.2
};

export class CombatOptimizer {
  private readonly options: CombatLearningOptions;
  private readonly store: CombatStateStore;
  private lastLogKey = '';

  constructor(
    store: CombatStateStore,
    options?: Partial<CombatLearningOptions>
  ) {
    this.store = store;
    this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  flush(): void {
    this.store.flush();
  }

  getTuningStatus(context: CombatContext): TuningStatus {
    const baseline = baselinePresetId(context);
    const entry = this.store.getContextState(context, baseline);
    return describeTuningStatus({
      paramExploreCount: entry.paramExploreCount,
      paramAdoptCount: entry.paramAdoptCount,
      noImproveStreak: entry.noImproveStreak,
      bestScore: Number.isFinite(entry.tunedBestScore) ? entry.tunedBestScore : null
    });
  }

  /** 全コンテキストのチューニング状態を要約（分析パック用）。 */
  getAggregateTuningStatus(): TuningStatus {
    const snap = this.store.getSnapshot();
    let explore = 0;
    let adopt = 0;
    let streak = 0;
    let best: number | null = null;
    const contexts = Object.values(snap.contexts);
    if (!contexts.length) {
      return describeTuningStatus({
        paramExploreCount: 0,
        paramAdoptCount: 0,
        noImproveStreak: 0,
        bestScore: null
      });
    }
    for (const entry of contexts) {
      explore += entry.paramExploreCount || 0;
      adopt += entry.paramAdoptCount || 0;
      streak = Math.max(streak, entry.noImproveStreak || 0);
      if (Number.isFinite(entry.tunedBestScore)) {
        best = best == null
          ? entry.tunedBestScore
          : Math.max(best, entry.tunedBestScore);
      }
    }
    return describeTuningStatus({
      paramExploreCount: explore,
      paramAdoptCount: adopt,
      noImproveStreak: streak,
      bestScore: best
    });
  }

  /** UI用: 対象パラメータ一覧と文脈別の採用値。 */
  getTuningDashboard(): TuningDashboard {
    const snap = this.store.getSnapshot();
    return buildTuningDashboard({
      aggregate: this.getAggregateTuningStatus(),
      contexts: snap.contexts
    });
  }

  pickPreset(opts: {
    context: CombatContext;
    health: number;
    now?: number;
  }): PresetChoice {
    const now = opts.now ?? Date.now();
    const baseline = baselinePresetId(opts.context);
    if (!this.options.enabled) {
      return this.choice(baseline, 'disabled', false, false, null);
    }

    const entry = this.store.getContextState(opts.context, baseline);
    const candidates = listPresetsForContext(opts.context);
    const selected = candidates.includes(entry.selectedPresetId)
      ? entry.selectedPresetId
      : baseline;
    const best = candidates.includes(entry.bestPresetId)
      ? entry.bestPresetId
      : baseline;

    if (opts.health < this.options.minHealthToExplore) {
      const defensive = defensivePresetId(opts.context);
      return this.choice(defensive, 'defensive', false, false, entry.tunedParams);
    }

    if (now < entry.exploreCooldownUntil) {
      return this.choice(best, 'selected', false, false, entry.tunedParams);
    }

    const baselineStats = entry.presets[baseline];
    const baselineReady = (baselineStats?.trials || 0) >= this.options.minTrials;
    const canExplorePreset = baselineReady
      && candidates.length > 1
      && Math.random() < this.options.exploreRate;

    let presetId: CombatPresetId = baseline;
    let reason: PresetChoice['reason'] = 'baseline';
    let exploring = false;

    if (canExplorePreset) {
      const others = candidates.filter((id) => id !== best);
      presetId = others[Math.floor(Math.random() * others.length)] || baseline;
      reason = 'explore';
      exploring = true;
    } else {
      const selectedStats = entry.presets[selected];
      if (
        selected !== baseline
        && (selectedStats?.trials || 0) >= this.options.minTrials
        && (selectedStats?.avgScore || -Infinity) >= (baselineStats?.avgScore || -Infinity)
      ) {
        presetId = selected;
        reason = 'selected';
      } else {
        presetId = best === baseline ? baseline : best;
        reason = best === baseline ? 'baseline' : 'selected';
      }
    }

    // プリセット探索中は数値も同時にいじらない（結果の帰属を明確にする）
    // 当該クラスに探索キーが無い（近接など）場合は数値探索しない
    const classTuneKeys = tunableKeysForClass(opts.context.enemyClass);
    const canExploreParams = !exploring
      && baselineReady
      && classTuneKeys.length > 0
      && Math.random() < this.options.paramExploreRate;
    if (canExploreParams) {
      const base = getPresetParams(presetId);
      const mutation = mutateParamOverlayDetailed(
        base,
        entry.tunedParams,
        Math.random,
        opts.context.enemyClass
      );
      if (mutation.changedKeys.length === 0) {
        return this.choice(presetId, reason, exploring, false, entry.tunedParams);
      }
      return this.choice(
        presetId,
        reason,
        false,
        true,
        mutation.overlay,
        mutation.changedKeys,
        mutation.changes
      );
    }

    return this.choice(presetId, reason, exploring, false, entry.tunedParams);
  }

  /**
   * 完了したエピソードから学習状態を更新する。選択を戻す場合もある。
   */
  completeEpisode(episode: CombatEpisode): {
    score: number;
    adopted: boolean;
    rolledBack: boolean;
    reason: string;
    paramsAdopted: boolean;
  } {
    if (!this.options.enabled || !episode.learnable || episode.interrupted) {
      return {
        score: scoreEpisode(episode).total,
        adopted: false,
        rolledBack: false,
        reason: 'skipped-unlearnable',
        paramsAdopted: false
      };
    }

    const breakdown = scoreEpisode(episode);
    const score = breakdown.total;
    const ctx = episode.context;
    const baseline = baselinePresetId(ctx);
    const entry = this.store.recordEpisodeResult({
      ctx,
      presetId: episode.presetId,
      score,
      damageTaken: episode.damageTaken,
      kills: episode.kills,
      died: episode.died,
      enemyName: episode.enemyName
    });

    const presetStats = entry.presets[episode.presetId];
    const bestStats = entry.presets[entry.bestPresetId] || entry.presets[baseline];
    let adopted = false;
    let rolledBack = false;
    let reason = 'recorded';
    let paramsAdopted = false;

    const abortExplore = episode.exploring
      && (
        episode.died
        || episode.damageTaken >= this.options.exploreDamageAbort
      );

    if (abortExplore) {
      entry.selectedPresetId = entry.bestPresetId || baseline;
      entry.consecutiveWorse += 1;
      entry.exploreCooldownUntil = Date.now() + this.options.exploreCooldownMs;
      this.store.setSelectedPreset(ctx, entry.selectedPresetId);
      this.store.setConsecutiveWorse(ctx, entry.consecutiveWorse);
      this.store.setExploreCooldown(ctx, entry.exploreCooldownUntil);
      rolledBack = true;
      reason = episode.died ? 'rollback-death' : 'rollback-damage';
      this.logDecision(ctx, episode.presetId, reason, score);
      return { score, adopted, rolledBack, reason, paramsAdopted };
    }

    if (
      episode.exploring
      && bestStats
      && presetStats.trials >= this.options.minTrials
      && presetStats.avgScore + 0.35 < bestStats.avgScore
    ) {
      entry.consecutiveWorse += 1;
      if (entry.consecutiveWorse >= this.options.maxConsecutiveWorse) {
        entry.selectedPresetId = entry.bestPresetId || baseline;
        entry.exploreCooldownUntil = Date.now() + this.options.exploreCooldownMs;
        rolledBack = true;
        reason = 'rollback-worse-streak';
      } else {
        reason = 'explore-worse';
      }
      this.store.setSelectedPreset(ctx, entry.selectedPresetId);
      this.store.setConsecutiveWorse(ctx, entry.consecutiveWorse);
      this.store.setExploreCooldown(ctx, entry.exploreCooldownUntil);
      this.logDecision(ctx, episode.presetId, reason, score);
      return { score, adopted, rolledBack, reason, paramsAdopted };
    }

    // 十分な試行数があり、現行最良値を明確に上回った設定を採用する。
    if (
      presetStats.trials >= this.options.minTrials
      && (
        !bestStats
        || presetStats.avgScore > bestStats.avgScore + 0.25
      )
    ) {
      entry.bestPresetId = episode.presetId;
      entry.selectedPresetId = episode.presetId;
      entry.consecutiveWorse = 0;
      adopted = true;
      reason = 'adopted';
      this.store.setSelectedPreset(ctx, episode.presetId, true);
      this.store.setConsecutiveWorse(ctx, 0);
      this.logDecision(ctx, episode.presetId, reason, score);
    } else if (episode.exploring) {
      entry.consecutiveWorse = 0;
      this.store.setConsecutiveWorse(ctx, 0);
      reason = 'explore-ok';
      this.logDecision(ctx, episode.presetId, reason, score);
    }

    paramsAdopted = this.completeParamExplore(episode, score);
    if (!adopted && !rolledBack && !episode.exploring) {
      this.logDecision(ctx, episode.presetId, reason, score);
    }
    return { score, adopted, rolledBack, reason, paramsAdopted };
  }

  private completeParamExplore(episode: CombatEpisode, score: number): boolean {
    const ctx = episode.context;
    const entry = this.store.getContextState(ctx, episode.presetId);
    if (!episode.exploringParams) {
      // 採用済みオーバーレイ運用中も最良スコアを追従
      if (
        entry.tunedParams
        && score > entry.tunedBestScore
      ) {
        this.store.setParamTuningMeta(ctx, {
          tunedBestScore: score,
          noImproveStreak: 0
        });
      } else if (entry.tunedParams) {
        this.store.setParamTuningMeta(ctx, {
          noImproveStreak: entry.noImproveStreak + 1
        });
      }
      return false;
    }

    const exploreCount = entry.paramExploreCount + 1;
    const improved = score >= entry.tunedBestScore + this.options.paramAdoptMargin
      || (!Number.isFinite(entry.tunedBestScore) && !episode.died);

    if (improved && !episode.died) {
      this.store.setTunedParams(
        ctx,
        filterSimTuneOverlay(episode.paramOverlay, ctx.enemyClass)
      );
      this.store.setParamTuningMeta(ctx, {
        tunedBestScore: score,
        paramExploreCount: exploreCount,
        paramAdoptCount: entry.paramAdoptCount + 1,
        noImproveStreak: 0
      });
      this.logDecision(ctx, episode.presetId, 'params-adopted', score);
      return true;
    }

    this.store.setParamTuningMeta(ctx, {
      paramExploreCount: exploreCount,
      noImproveStreak: entry.noImproveStreak + 1
    });
    this.logDecision(ctx, episode.presetId, 'params-reject', score);
    return false;
  }

  private choice(
    presetId: CombatPresetId,
    reason: PresetChoice['reason'],
    exploring: boolean,
    exploringParams: boolean,
    overlay: ParamOverlay | null,
    changedKeys: string[] = [],
    changes: Array<{ key: string; from: number; to: number }> = []
  ): PresetChoice {
    return {
      presetId,
      params: applyParamOverlay(presetId, overlay),
      reason,
      exploring,
      exploringParams,
      paramOverlay: overlay,
      changedKeys,
      changes
    };
  }

  private logDecision(
    ctx: CombatContext,
    presetId: string,
    reason: string,
    score: number
  ): void {
    const key = `${ctx.enemyClass}|${ctx.hasShield}|${presetId}|${reason}`;
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    console.log(
      `[combat-learn] ${reason} preset=${presetId} `
      + `class=${ctx.enemyClass} shield=${ctx.hasShield} `
      + `score=${score.toFixed(2)}`
    );
  }
}
