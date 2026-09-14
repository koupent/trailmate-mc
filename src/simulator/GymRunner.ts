import path from 'node:path';
import { CombatOptimizer } from '../combat/CombatOptimizer.js';
import { CombatEpisodeTracker, scoreEpisode } from '../combat/CombatEpisodeTracker.js';
import { CombatStateStore } from '../combat/CombatStateStore.js';
import {
  classifyEncounterEnemyClass,
  type CombatContext
} from '../combat/CombatProfiles.js';
import {
  classifyEncounterSituation,
  situationMeta,
  type SituationId
} from '../combat/EncounterSituation.js';
import {
  mergeUtilityWeights,
  mutateUtilityWeights,
  seedBankForSituation,
  UTILITY_EQUATION,
  UTILITY_WEIGHT_BOUNDS,
  UTILITY_WEIGHT_KEYS,
  UTILITY_WEIGHT_META,
  type UtilityWeights
} from '../combat/CombatUtility.js';
import { generateArena, type ArenaKind, ARENA_KINDS } from './ArenaGenerator.js';
import {
  pickCurriculumArenaKind,
  type ArenaPerformance
} from './ArenaCurriculum.js';
import {
  stepSimulation,
  type SimulationDecision,
  type SimulationState
} from './SimulationCore.js';
import { buildReviewMarkdown, type FailureCluster, type ReviewSummary } from './ReviewPack.js';
import type {
  LastEpisodeView,
  ParamTrialView,
  TuningDashboard
} from '../combat/ParamTuner.js';
import { TUNABLE_PARAM_META } from '../combat/ParamTuner.js';

export type UtilityTrialView = {
  seed: number;
  situationId: SituationId;
  situationLabel: string;
  changedKeys: string[];
  changes: Array<{ key: string; label: string; from: number; to: number }>;
  episodeScore: number;
  bankScore: number;
  baselineBankScore: number;
  win: boolean;
  died: boolean;
  outcome: 'adopted' | 'rejected';
};

export type UtilityTuningDashboard = {
  equation: string;
  methodNote: string;
  situations: Array<{
    id: SituationId;
    label: string;
    blurb: string;
    exploreCount: number;
    adoptCount: number;
    noImproveStreak: number;
    bestBankScore: number | null;
    weights: Array<{
      key: string;
      label: string;
      role: string;
      sign: string;
      value: number;
      base: number;
      min: number;
      max: number;
      tuned: boolean;
    }>;
  }>;
  recentTrials: UtilityTrialView[];
};

export type EpisodeResult = {
  seed: number;
  arenaKind: string;
  win: boolean;
  died: boolean;
  ticks: number;
  botHp: number;
  damageTaken: number;
  attacks: number;
  shots: number;
  kills: number;
  presetId: string;
  exploring: boolean;
  exploringParams: boolean;
  paramsAdopted: boolean;
  changedKeys: string[];
  changes: Array<{ key: string; from: number; to: number }>;
  enemyClass: string;
  hasShield: boolean;
  enemyKinds: string[];
  score: number;
  learnReason: string;
  /** 次アリーナを選んだ理由（explore / coverage / weakness / rematch） */
  curriculumReason: string | null;
  failureKind: FailureKind | null;
  trace: TraceSample[];
  finalState: SimulationState;
};

export type FailureKind =
  | 'death'
  | 'elevated-ranged-stall'
  | 'wall-blocked'
  | 'surrounded'
  | 'heavy-damage'
  | 'timeout';

export type TraceSample = {
  tick: number;
  movement: string;
  intent: string | null;
  botHp: number;
  bot: { x: number; y: number; z: number };
  enemies: Array<{ id: number; kind: string; x: number; y: number; z: number; hp: number }>;
};

export type GymStats = {
  episodes: number;
  wins: number;
  deaths: number;
  avgDamage: number;
  avgScore: number;
  byArena: Record<string, { episodes: number; wins: number; deaths: number; avgScore: number }>;
  byPreset: Record<string, { episodes: number; avgScore: number; wins: number }>;
  clusters: FailureCluster[];
  recent: EpisodeResult[];
  worst: EpisodeResult[];
  tuning: TuningDashboard;
  utility: UtilityTuningDashboard;
};

export type GymRunnerOptions = {
  statePath?: string;
  learningEnabled?: boolean;
  maxTicks?: number;
  keepRecent?: number;
  keepWorst?: number;
};

const DEFAULT_MAX_TICKS = 150;
const TRACE_EVERY = 8;

export class GymRunner {
  private readonly optimizer: CombatOptimizer;
  private readonly store: CombatStateStore;
  private readonly storePath: string;
  private readonly maxTicks: number;
  private readonly keepRecent: number;
  private readonly keepWorst: number;
  private results: EpisodeResult[] = [];
  private paramTrials: ParamTrialView[] = [];
  private utilityTrials: UtilityTrialView[] = [];
  private lastEpisodeView: LastEpisodeView | null = null;
  private learningEnabled: boolean;
  /** 効用探索はシードバンク再シミュが重いので控えめに。 */
  // 効用重み探索は停止（原則駆動の MixedCombatPlan が決定）。常に 0。
  private readonly utilityExploreRate = 0;


  constructor(options: GymRunnerOptions = {}) {
    this.storePath = options.statePath
      || path.join(process.cwd(), 'data', 'sim-combat-state.json');
    this.store = new CombatStateStore(this.storePath);
    this.learningEnabled = options.learningEnabled !== false;
    this.optimizer = new CombatOptimizer(this.store, {
      enabled: this.learningEnabled,
      exploreRate: 0.12,
      paramExploreRate: 0.08,
      minTrials: 3
    });
    this.maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
    this.keepRecent = options.keepRecent ?? 40;
    this.keepWorst = options.keepWorst ?? 12;
  }

  setLearningEnabled(enabled: boolean): void {
    this.learningEnabled = enabled;
  }

  flush(): void {
    this.optimizer.flush();
  }

  /**
   * 画面統計と箱庭学習状態をクリアする。
   * ロジック改修後に新旧エピソードが混ざるのを防ぐ。
   */
  resetSession(): { clearedEpisodes: number; statePath: string } {
    const clearedEpisodes = this.results.length;
    this.results = [];
    this.paramTrials = [];
    this.utilityTrials = [];
    this.lastEpisodeView = null;
    this.optimizer.flush();
    this.store.reset();
    return { clearedEpisodes, statePath: this.storePath };
  }

  getStats(): GymStats {
    const episodes = this.results.length;
    const wins = this.results.filter((item) => item.win).length;
    const deaths = this.results.filter((item) => item.died).length;
    const avgDamage = episodes
      ? this.results.reduce((sum, item) => sum + item.damageTaken, 0) / episodes
      : 0;
    const avgScore = episodes
      ? this.results.reduce((sum, item) => sum + item.score, 0) / episodes
      : 0;

    const byArena: GymStats['byArena'] = {};
    const byPreset: GymStats['byPreset'] = {};
    for (const result of this.results) {
      const arena = byArena[result.arenaKind] || {
        episodes: 0,
        wins: 0,
        deaths: 0,
        avgScore: 0
      };
      arena.avgScore = (arena.avgScore * arena.episodes + result.score) / (arena.episodes + 1);
      arena.episodes += 1;
      if (result.win) arena.wins += 1;
      if (result.died) arena.deaths += 1;
      byArena[result.arenaKind] = arena;

      const preset = byPreset[result.presetId] || { episodes: 0, avgScore: 0, wins: 0 };
      preset.avgScore = (preset.avgScore * preset.episodes + result.score) / (preset.episodes + 1);
      preset.episodes += 1;
      if (result.win) preset.wins += 1;
      byPreset[result.presetId] = preset;
    }

    return {
      episodes,
      wins,
      deaths,
      avgDamage,
      avgScore,
      byArena,
      byPreset,
      clusters: this.buildClusters(),
      recent: this.results.slice(-this.keepRecent),
      worst: [...this.results]
        .sort((a, b) => a.score - b.score)
        .slice(0, this.keepWorst),
      tuning: {
        ...this.optimizer.getTuningDashboard(),
        recentTrials: this.paramTrials.slice(0, 16),
        lastEpisode: this.lastEpisodeView
      },
      utility: this.buildUtilityDashboard()
    };
  }

  private buildUtilityDashboard(): UtilityTuningDashboard {
    return {
      equation: UTILITY_EQUATION,
      methodNote:
        '効用重みは行動決定に未使用・探索停止。'
        + '箱庭で動かす数値は敵クラス固有3キーのみ（上のチューニング欄）。',
      // 重みバーは出さない（パラメータがたくさんあるように見えるのを防ぐ）
      situations: [],
      recentTrials: []
    };
  }

  runEpisode(seed: number, kind?: ArenaKind): EpisodeResult {
    let curriculumReason: string | null = null;
    let resolvedKind = kind;
    let resolvedSeed = seed;

    if (resolvedKind == null) {
      const rematch = this.maybePickFailureRematch(seed);
      if (rematch) {
        resolvedSeed = rematch.seed;
        resolvedKind = rematch.kind;
        curriculumReason = 'rematch';
      } else {
        const pick = pickCurriculumArenaKind({
          seed,
          performance: this.buildArenaPerformance()
        });
        resolvedKind = pick.kind;
        curriculumReason = pick.reason;
      }
    }

    return this.runConfiguredEpisode(resolvedSeed, resolvedKind, curriculumReason);
  }

  private maybePickFailureRematch(seed: number): { seed: number; kind: ArenaKind } | null {
    const failures = this.results.filter((item) => item.failureKind && item.died);
    if (failures.length < 4) return null;
    const rng = ((seed * 1103515245 + 12345) >>> 0) / 0x100000000;
    // 失敗ログが溜まったら、たまに同じ苦手シードを再戦して改善を測る
    if (rng >= 0.18) return null;
    const pick = failures[seed % failures.length];
    if (!ARENA_KINDS.includes(pick.arenaKind as ArenaKind)) return null;
    return { seed: pick.seed, kind: pick.arenaKind as ArenaKind };
  }

  private buildArenaPerformance(): ArenaPerformance[] {
    const stats = this.getStats().byArena;
    return ARENA_KINDS.map((kind) => {
      const row = stats[kind];
      return {
        kind,
        episodes: row?.episodes ?? 0,
        wins: row?.wins ?? 0,
        deaths: row?.deaths ?? 0,
        avgScore: row?.avgScore ?? 0
      };
    });
  }

  private runConfiguredEpisode(
    seed: number,
    kind: ArenaKind,
    curriculumReason: string | null
  ): EpisodeResult {
    let state = generateArena(seed, kind);
    const enemyKinds = [...new Set(state.enemies.map((enemy) => enemy.kind))];
    const situation = classifyEncounterSituation(state.enemies);
    const situationId = situation.id;
    const context: CombatContext = {
      enemyClass: classifyEncounterEnemyClass(state.enemies),
      hasShield: state.inventory.includes('shield')
    };
    const choice = this.optimizer.pickPreset({
      context,
      health: state.bot.hp,
      // 探索クールダウンは壁時計。箱庭の state.now(0起算)を渡すと常にクールダウン扱いになる。
      now: Date.now()
    });
    state.activePresetId = choice.presetId;
    state.presetParams = choice.params;
    state.situationId = situationId;

    const sitEntry = this.store.getSituationState(situationId);
    let exploringUtility = false;
    let utilityOverlay: Partial<UtilityWeights> = { ...sitEntry.weights };
    let utilityChanges: Array<{ key: string; from: number; to: number }> = [];
    let utilityChangedKeys: string[] = [];
    if (
      this.learningEnabled
      && !choice.exploring
      && !choice.exploringParams
      && situationId !== 'single'
      && Math.random() < this.utilityExploreRate
    ) {
      const mutation = mutateUtilityWeights(situationId, sitEntry.weights);
      exploringUtility = true;
      utilityOverlay = mutation.overlay;
      utilityChangedKeys = mutation.changedKeys;
      utilityChanges = mutation.changes;
    }
    const trialWeights = mergeUtilityWeights(situationId, utilityOverlay);
    state.utilityWeights = trialWeights;

    const tracker = new CombatEpisodeTracker();
    const primary = state.enemies[0];
    tracker.begin({
      context,
      presetId: choice.presetId,
      exploring: choice.exploring,
      exploringParams: choice.exploringParams,
      paramOverlay: choice.paramOverlay,
      enemyName: primary?.kind || null,
      enemyId: primary?.id ?? null,
      enemyCount: state.enemies.length,
      now: state.now
    });

    const trace: TraceSample[] = [];
    let decision: SimulationDecision | null = null;
    let stalledElevated = 0;

    for (let index = 0; index < this.maxTicks; index += 1) {
      ({ state, decision } = stepSimulation(state));
      const live = state.enemies.filter((enemy) => enemy.hp > 0);
      tracker.noteEnemyCount(live.length);
      if (state.tick % TRACE_EVERY === 0 || state.bot.hp <= 0 || live.length === 0) {
        trace.push(sampleTrace(state, decision));
      }
      if (state.arenaKind === 'elevated-ranged' && decision?.movement === 'dodge') {
        stalledElevated += 1;
      }
      if (state.bot.hp <= 0) break;
      if (live.length === 0) break;
    }

    const startHp = 20;
    const damageTaken = Math.max(state.damageTaken, startHp - state.bot.hp);
    if (tracker.current) {
      tracker.current.damageTaken = damageTaken;
      tracker.current.hitsLanded = state.attacks;
      tracker.current.kills = Math.max(0, (tracker.current.startEnemyCount || 0) - state.enemies.filter((e) => e.hp > 0).length);
      tracker.current.died = state.bot.hp <= 0;
    }
    const episode = tracker.end({ now: state.now })!;
    episode.learnable = true;
    episode.damageTaken = damageTaken;
    episode.hitsLanded = state.attacks;
    episode.kills = Math.max(0, episode.startEnemyCount - state.enemies.filter((e) => e.hp > 0).length);
    episode.died = state.bot.hp <= 0;

    const learn = this.optimizer.completeEpisode(episode);
    const score = scoreEpisode(episode).total;
    const win = state.bot.hp > 0 && state.enemies.every((enemy) => enemy.hp <= 0);
    const failureKind = classifyFailure(state, win, stalledElevated, this.maxTicks);
    const contextLabel = `${context.enemyClass}${context.hasShield ? '+盾' : ''}`;

    let utilityAdopted = false;
    if (exploringUtility) {
      const baselineWeights = this.store.getMergedSituationWeights(situationId);
      const bankScore = this.evaluateUtilitySeedBank(situationId, trialWeights);
      const baselineBank = Number.isFinite(sitEntry.bestBankScore)
        && sitEntry.bestBankScore > -1e8
        ? sitEntry.bestBankScore
        : this.evaluateUtilitySeedBank(situationId, baselineWeights);
      const exploreCount = sitEntry.exploreCount + 1;
      const improved = bankScore >= baselineBank + 0.35 && !episode.died;
      if (improved) {
        utilityAdopted = true;
        this.store.setSituationWeights(situationId, utilityOverlay, {
          bestBankScore: bankScore,
          exploreCount,
          adoptCount: sitEntry.adoptCount + 1,
          noImproveStreak: 0
        });
        console.log(
          `[combat-learn] utility-adopted situation=${situationId} `
          + `bank=${bankScore.toFixed(2)} (was ${baselineBank.toFixed(2)}) `
          + `keys=${utilityChangedKeys.join(',')}`
        );
      } else {
        this.store.patchSituationMeta(situationId, {
          exploreCount,
          noImproveStreak: sitEntry.noImproveStreak + 1,
          bestBankScore: Math.max(
            Number.isFinite(sitEntry.bestBankScore) ? sitEntry.bestBankScore : -Infinity,
            baselineBank
          )
        });
      }
      this.utilityTrials.unshift({
        seed,
        situationId,
        situationLabel: situation.label,
        changedKeys: utilityChangedKeys,
        changes: utilityChanges.map((row) => ({
          key: row.key,
          label: UTILITY_WEIGHT_META[row.key as keyof typeof UTILITY_WEIGHT_META]?.label || row.key,
          from: row.from,
          to: row.to
        })),
        episodeScore: score,
        bankScore,
        baselineBankScore: baselineBank,
        win,
        died: episode.died,
        outcome: utilityAdopted ? 'adopted' : 'rejected'
      });
      if (this.utilityTrials.length > 40) this.utilityTrials = this.utilityTrials.slice(0, 40);
    }

    const result: EpisodeResult = {
      seed,
      arenaKind: state.arenaKind || kind,
      win,
      died: state.bot.hp <= 0,
      ticks: state.tick,
      botHp: state.bot.hp,
      damageTaken,
      attacks: state.attacks,
      shots: state.shots,
      kills: episode.kills,
      presetId: choice.presetId,
      exploring: choice.exploring,
      exploringParams: choice.exploringParams || exploringUtility,
      paramsAdopted: learn.paramsAdopted || utilityAdopted,
      changedKeys: exploringUtility ? utilityChangedKeys : choice.changedKeys,
      changes: exploringUtility
        ? utilityChanges.map((row) => ({ key: row.key, from: row.from, to: row.to }))
        : choice.changes,
      enemyClass: context.enemyClass,
      hasShield: context.hasShield,
      enemyKinds,
      score,
      learnReason: exploringUtility
        ? (utilityAdopted ? 'utility-adopted' : 'utility-reject')
        : learn.reason,
      curriculumReason,
      failureKind,
      trace: trace.slice(-16),
      finalState: state
    };
    this.results.push(result);
    if (this.results.length > 500) this.results = this.results.slice(-400);

    this.lastEpisodeView = {
      seed,
      arenaKind: result.arenaKind,
      contextLabel: `${situation.label} / ${contextLabel}`,
      enemyKinds,
      presetId: choice.presetId,
      exploringParams: choice.exploringParams || exploringUtility,
      exploringPreset: choice.exploring,
      changedKeys: exploringUtility ? utilityChangedKeys : choice.changedKeys,
      score,
      win,
      died: result.died,
      paramsAdopted: learn.paramsAdopted || utilityAdopted,
      intentLabel: exploringUtility
        ? `効用重み探索(${situation.label}): ${utilityChangedKeys.join(', ') || '—'}`
        : choice.exploringParams
          ? `数値探索: ${choice.changedKeys.join(', ') || '—'}`
          : choice.exploring
            ? `プリセット探索: ${choice.presetId}`
            : `運用中 · ${situation.label}`
    };

    if (choice.exploringParams && choice.changedKeys.length) {
      this.paramTrials.unshift({
        seed,
        arenaKind: result.arenaKind,
        contextLabel,
        enemyClass: context.enemyClass,
        hasShield: context.hasShield,
        enemyKinds,
        presetId: choice.presetId,
        changedKeys: choice.changedKeys,
        changes: choice.changes.map((row) => {
          const key = row.key as keyof typeof TUNABLE_PARAM_META;
          const meta = TUNABLE_PARAM_META[key];
          return {
            key: row.key,
            label: meta?.label || row.key,
            from: row.from,
            to: row.to,
            unit: meta?.unit || ''
          };
        }),
        score,
        win,
        died: result.died,
        outcome: learn.paramsAdopted ? 'adopted' : 'rejected'
      });
      if (this.paramTrials.length > 40) this.paramTrials = this.paramTrials.slice(0, 40);
    }

    return result;
  }

  /** 学習副作用なしで固定バンクを採点する。 */
  private evaluateUtilitySeedBank(
    situationId: SituationId,
    weights: UtilityWeights
  ): number {
    const cases = seedBankForSituation(situationId);
    if (!cases.length) return 0;
    let sum = 0;
    for (const item of cases) {
      sum += this.scoreEpisodeWithWeights(item.seed, item.kind, weights);
    }
    return sum / cases.length;
  }

  private scoreEpisodeWithWeights(
    seed: number,
    kind: ArenaKind,
    weights: UtilityWeights
  ): number {
    let state = generateArena(seed, kind);
    const context: CombatContext = {
      enemyClass: classifyEncounterEnemyClass(state.enemies),
      hasShield: state.inventory.includes('shield')
    };
    const choice = this.optimizer.pickPreset({
      context,
      health: state.bot.hp,
      now: Date.now()
    });
    state.activePresetId = choice.presetId;
    state.presetParams = choice.params;
    state.utilityWeights = weights;
    const tracker = new CombatEpisodeTracker();
    const primary = state.enemies[0];
    tracker.begin({
      context,
      presetId: choice.presetId,
      exploring: false,
      exploringParams: false,
      paramOverlay: null,
      enemyName: primary?.kind || null,
      enemyId: primary?.id ?? null,
      enemyCount: state.enemies.length,
      now: state.now
    });
    for (let index = 0; index < Math.min(this.maxTicks, 90); index += 1) {
      ({ state } = stepSimulation(state));
      const live = state.enemies.filter((enemy) => enemy.hp > 0);
      tracker.noteEnemyCount(live.length);
      if (state.bot.hp <= 0 || live.length === 0) break;
    }
    if (tracker.current) {
      tracker.current.damageTaken = Math.max(state.damageTaken, 20 - state.bot.hp);
      tracker.current.hitsLanded = state.attacks;
      tracker.current.kills = Math.max(
        0,
        (tracker.current.startEnemyCount || 0)
          - state.enemies.filter((enemy) => enemy.hp > 0).length
      );
      tracker.current.died = state.bot.hp <= 0;
    }
    const episode = tracker.end({ now: state.now });
    if (!episode) return -50;
    episode.learnable = false;
    return scoreEpisode(episode).total;
  }

  runBatch(count: number, startSeed = Date.now() % 1_000_000): EpisodeResult[] {
    const out: EpisodeResult[] = [];
    for (let index = 0; index < count; index += 1) {
      out.push(this.runEpisode(startSeed + index));
    }
    this.flush();
    return out;
  }

  /** 学習には記録せず、初期配置だけ返す（監視画面での再生用）。 */
  loadSeed(seed: number, kind?: ArenaKind): SimulationState {
    return generateArena(seed, kind);
  }

  buildReviewSummary(): ReviewSummary {
    const stats = this.getStats();
    return {
      generatedAt: new Date().toISOString(),
      episodes: stats.episodes,
      winRate: stats.episodes ? stats.wins / stats.episodes : 0,
      deathRate: stats.episodes ? stats.deaths / stats.episodes : 0,
      avgDamage: stats.avgDamage,
      avgScore: stats.avgScore,
      clusters: stats.clusters,
      byArena: stats.byArena,
      byPreset: stats.byPreset,
      tuning: this.optimizer.getAggregateTuningStatus()
    };
  }

  buildReviewMarkdown(): string {
    return buildReviewMarkdown(this.buildReviewSummary(), this.getStats().worst.slice(0, 5));
  }

  private buildClusters(): FailureCluster[] {
    const map = new Map<string, FailureCluster>();
    for (const result of this.results) {
      if (!result.failureKind) continue;
      const entry = map.get(result.failureKind) || {
        kind: result.failureKind,
        label: failureLabel(result.failureKind),
        count: 0,
        seeds: [],
        samples: []
      };
      entry.count += 1;
      if (entry.seeds.length < 3) entry.seeds.push(result.seed);
      if (entry.samples.length < 2) {
        entry.samples.push({
          seed: result.seed,
          arenaKind: result.arenaKind,
          score: result.score,
          damageTaken: result.damageTaken,
          trace: result.trace.slice(-6)
        });
      }
      map.set(result.failureKind, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }
}

function sampleTrace(state: SimulationState, decision: SimulationDecision | null): TraceSample {
  return {
    tick: state.tick,
    movement: decision?.movement || 'stay',
    intent: decision?.intent?.priority ?? null,
    botHp: state.bot.hp,
    bot: { x: state.bot.x, y: state.bot.y, z: state.bot.z },
    enemies: state.enemies.map((enemy) => ({
      id: enemy.id,
      kind: enemy.kind,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      hp: enemy.hp
    }))
  };
}

function classifyFailure(
  state: SimulationState,
  win: boolean,
  stalledElevated: number,
  maxTicks: number
): FailureKind | null {
  if (win) return null;
  if (state.bot.hp <= 0) {
    if (state.enemies.length >= 2) return 'surrounded';
    return 'death';
  }
  if (state.arenaKind === 'elevated-ranged' && stalledElevated >= 20) return 'elevated-ranged-stall';
  if (state.arenaKind === 'wall-los' && state.enemies.some((enemy) => enemy.hp > 0)) return 'wall-blocked';
  if (state.damageTaken >= 10) return 'heavy-damage';
  if (state.tick >= maxTicks - 1) return 'timeout';
  return 'timeout';
}

function failureLabel(kind: FailureKind): string {
  return ({
    death: '死亡',
    'elevated-ranged-stall': '高台遠距離で回避停滞',
    'wall-blocked': '壁越しで接近・交戦不能',
    surrounded: '複数敵に囲まれて死亡',
    'heavy-damage': '大被弾',
    timeout: '時間切れ'
  })[kind];
}
