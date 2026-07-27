import type { CombatContext } from './CombatProfiles.js';
import { countBucket } from './CombatProfiles.js';

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
  /** False when interrupt / mixed recovery makes learning unsafe. */
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
 * Score an episode. Higher is better.
 * Multi-enemy emphasizes kill/damage ratio more than solo.
 */
export function scoreEpisode(episode: CombatEpisode): EpisodeScoreBreakdown {
  const durationSec = Math.max(
    0.5,
    ((episode.endedAt ?? Date.now()) - episode.startedAt) / 1000
  );
  const bucket = episode.context.countBucket;
  const killWeight = bucket === 'swarm' ? 4.5 : bucket === 'duo' ? 3.5 : 3;
  const damageWeight = bucket === 'swarm' ? 1.4 : bucket === 'duo' ? 1.2 : 1.0;

  const kills = episode.kills * killWeight;
  const hits = Math.min(episode.hitsLanded, 12) * 0.25;
  const damage = -episode.damageTaken * damageWeight;
  const retreat = episode.retreated ? -2.5 : 0;
  const death = episode.died ? -12 : 0;
  // Mild time pressure so endless kiting does not look "safe".
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

  /**
   * If the count bucket changed, close the current episode (caller should start a new one).
   * Returns the closed episode when a split is required.
   */
  noteEnemyCount(enemyCount: number, now = Date.now()): CombatEpisode | null {
    if (!this.active) return null;
    this.active.peakEnemyCount = Math.max(this.active.peakEnemyCount, enemyCount);
    const prev = this.active.context.countBucket;
    const next = countBucket(enemyCount);
    if (prev === next) return null;
    return this.end({ now, reason: 'bucket-change' });
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
