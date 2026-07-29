import type { CombatContext } from './CombatProfiles.js';

export type CombatEpisode = {
  context: CombatContext;
  presetId: string;
  exploring: boolean;
  enemyName: string | null;
  enemyId: number | string | null;
  startedAt: number;
  endedAt: number | null;
  startEnemyCount: number;
  peakEnemyCount: number;
  damageTaken: number;
  hitsLanded: number;
  kills: number;
  retreated: boolean;
  died: boolean;
  interrupted: boolean;
  /** 割り込みや復旧処理の混在により、安全に学習できない場合は false。 */
  learnable: boolean;
};

export type EpisodeScoreBreakdown = {
  total: number;
  kills: number;
  hits: number;
  damage: number;
  retreat: number;
  death: number;
  duration: number;
};

/**
 * 戦闘エピソードを採点する。高いほど良い。
 */
export function scoreEpisode(episode: CombatEpisode): EpisodeScoreBreakdown {
  const durationSec = Math.max(
    0.5,
    ((episode.endedAt ?? Date.now()) - episode.startedAt) / 1000
  );

  const kills = episode.kills * 3;
  const hits = Math.min(episode.hitsLanded, 12) * 0.25;
  const damage = -episode.damageTaken * 1.0;
  const retreat = episode.retreated ? -2.5 : 0;
  const death = episode.died ? -12 : 0;
  // 無限の引き撃ちを「安全」と誤認しないよう、時間経過を軽く減点する。
  const duration = -Math.min(8, durationSec * 0.15);

  const total = kills + hits + damage + retreat + death + duration;
  return { total, kills, hits, damage, retreat, death, duration };
}

export class CombatEpisodeTracker {
  private active: CombatEpisode | null = null;

  get current(): CombatEpisode | null {
    return this.active;
  }

  begin(opts: {
    context: CombatContext;
    presetId: string;
    exploring: boolean;
    enemyName: string | null;
    enemyId: number | string | null;
    enemyCount: number;
    now?: number;
  }): CombatEpisode {
    this.active = {
      context: opts.context,
      presetId: opts.presetId,
      exploring: opts.exploring,
      enemyName: opts.enemyName,
      enemyId: opts.enemyId,
      startedAt: opts.now ?? Date.now(),
      endedAt: null,
      startEnemyCount: opts.enemyCount,
      peakEnemyCount: opts.enemyCount,
      damageTaken: 0,
      hitsLanded: 0,
      kills: 0,
      retreated: false,
      died: false,
      interrupted: false,
      learnable: true
    };
    return this.active;
  }

  /** 近傍敵数の最大値を記録する（学習コンテキストは分割しない）。 */
  noteEnemyCount(enemyCount: number): void {
    if (!this.active) return;
    this.active.peakEnemyCount = Math.max(this.active.peakEnemyCount, enemyCount);
  }

  recordDamage(amount: number): void {
    if (!this.active || amount <= 0) return;
    this.active.damageTaken += amount;
  }

  recordHit(): void {
    if (!this.active) return;
    this.active.hitsLanded += 1;
  }

  recordKill(): void {
    if (!this.active) return;
    this.active.kills += 1;
  }

  markRetreated(): void {
    if (!this.active) return;
    this.active.retreated = true;
  }

  markDied(): void {
    if (!this.active) return;
    this.active.died = true;
  }

  markInterrupted(): void {
    if (!this.active) return;
    this.active.interrupted = true;
    this.active.learnable = false;
  }

  markUnlearnable(): void {
    if (!this.active) return;
    this.active.learnable = false;
  }

  end(opts?: { now?: number; reason?: string }): CombatEpisode | null {
    if (!this.active) return null;
    const episode = this.active;
    episode.endedAt = opts?.now ?? Date.now();
    this.active = null;
    return episode;
  }
}
