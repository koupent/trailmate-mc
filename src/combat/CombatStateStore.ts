import fs from 'node:fs';
import path from 'node:path';
import type { CombatContext, CombatPresetId } from './CombatProfiles.js';
import { contextKey } from './CombatProfiles.js';

/** コンテキストキー変更時に更新する（敵数バケットを廃止）。 */
export const COMBAT_STATE_VERSION = 2;

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
};

export type CombatStateFile = {
  version: number;
  updatedAt: number;
  contexts: Record<string, ContextLearningState>;
  enemyNameStats: Record<string, { fights: number; damage: number; kills: number }>;
};

export function emptyCombatState(): CombatStateFile {
  return {
    version: COMBAT_STATE_VERSION,
    updatedAt: 0,
    contexts: {},
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeCombatState(raw: unknown): CombatStateFile {
  if (!isObject(raw) || raw.version !== COMBAT_STATE_VERSION) {
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
      state.contexts[key] = {
        selectedPresetId: String(value.selectedPresetId || value.bestPresetId || ''),
        bestPresetId: String(value.bestPresetId || value.selectedPresetId || ''),
        consecutiveWorse: Math.max(0, Number(value.consecutiveWorse) || 0),
        exploreCooldownUntil: Number(value.exploreCooldownUntil) || 0,
        presets
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
      entry = {
        selectedPresetId: fallbackPresetId,
        bestPresetId: fallbackPresetId,
        consecutiveWorse: 0,
        exploreCooldownUntil: 0,
        presets: {}
      };
      this.state.contexts[key] = entry;
      this.dirty = true;
    }
    if (!entry.selectedPresetId) entry.selectedPresetId = fallbackPresetId;
    if (!entry.bestPresetId) entry.bestPresetId = fallbackPresetId;
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

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
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
