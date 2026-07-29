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

export type CombatLearningOptions = {
  enabled: boolean;
  exploreRate: number;
  minTrials: number;
  minHealthToExplore: number;
  /** 探索中の1エピソードでこの値以上被弾したら即座にロールバックする。 */
  exploreDamageAbort: number;
  /** 悪化した探索結果がこの回数続いたら、探索を短時間休止する。 */
  maxConsecutiveWorse: number;
  exploreCooldownMs: number;
};

export type PresetChoice = {
  presetId: CombatPresetId;
  params: CombatPresetParams;
  reason: 'disabled' | 'baseline' | 'selected' | 'explore' | 'defensive' | 'rollback';
  exploring: boolean;
};

const DEFAULT_OPTIONS: CombatLearningOptions = {
  enabled: true,
  exploreRate: 0.12,
  minTrials: 3,
  minHealthToExplore: 12,
  exploreDamageAbort: 8,
  maxConsecutiveWorse: 2,
  exploreCooldownMs: 45000
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

  pickPreset(opts: {
    context: CombatContext;
    health: number;
    now?: number;
  }): PresetChoice {
    const now = opts.now ?? Date.now();
    const baseline = baselinePresetId(opts.context);
    if (!this.options.enabled) {
      return this.choice(baseline, 'disabled', false);
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
      return this.choice(defensive, 'defensive', false);
    }

    if (now < entry.exploreCooldownUntil) {
      return this.choice(best, 'selected', false);
    }

    const baselineStats = entry.presets[baseline];
    const baselineReady = (baselineStats?.trials || 0) >= this.options.minTrials;
    const canExplore = baselineReady
      && candidates.length > 1
      && Math.random() < this.options.exploreRate;

    if (canExplore) {
      const others = candidates.filter((id) => id !== best);
      const pick = others[Math.floor(Math.random() * others.length)] || baseline;
      return this.choice(pick, 'explore', true);
    }

    // 十分な実績がある場合は選択済み設定を優先し、それまでは基準設定を保つ。
    const selectedStats = entry.presets[selected];
    if (
      selected !== baseline
      && (selectedStats?.trials || 0) >= this.options.minTrials
      && (selectedStats?.avgScore || -Infinity) >= (baselineStats?.avgScore || -Infinity)
    ) {
      return this.choice(selected, 'selected', false);
    }
    return this.choice(best === baseline ? baseline : best, 'baseline', false);
  }

  /**
   * 完了したエピソードから学習状態を更新する。選択を戻す場合もある。
   */
  completeEpisode(episode: CombatEpisode): {
    score: number;
    adopted: boolean;
    rolledBack: boolean;
    reason: string;
  } {
    if (!this.options.enabled || !episode.learnable || episode.interrupted) {
      return {
        score: scoreEpisode(episode).total,
        adopted: false,
        rolledBack: false,
        reason: 'skipped-unlearnable'
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
      return { score, adopted, rolledBack, reason };
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
      return { score, adopted, rolledBack, reason };
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
      return { score, adopted, rolledBack, reason };
    }

    if (episode.exploring) {
      entry.consecutiveWorse = 0;
      this.store.setConsecutiveWorse(ctx, 0);
      reason = 'explore-ok';
    }

    this.logDecision(ctx, episode.presetId, reason, score);
    return { score, adopted, rolledBack, reason };
  }

  private choice(
    presetId: CombatPresetId,
    reason: PresetChoice['reason'],
    exploring: boolean
  ): PresetChoice {
    return {
      presetId,
      params: getPresetParams(presetId),
      reason,
      exploring
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
