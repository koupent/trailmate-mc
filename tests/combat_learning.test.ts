import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baselinePresetId,
  blendCrowdAvoidDirection,
  classifyEnemy,
  clampPreset,
  countBucket,
  decideSpacing,
  getPresetParams,
  listPresetsForContext,
  PRESET_BOUNDS
} from '../src/combat/CombatProfiles.js';
import {
  CombatEpisodeTracker,
  scoreEpisode
} from '../src/combat/CombatEpisodeTracker.js';
import {
  CombatStateStore,
  normalizeCombatState
} from '../src/combat/CombatStateStore.js';
import { CombatOptimizer } from '../src/combat/CombatOptimizer.js';

describe('CombatProfiles', () => {
  it('classifies common hostiles', () => {
    assert.equal(classifyEnemy('zombie'), 'melee');
    assert.equal(classifyEnemy('spider'), 'agile');
    assert.equal(classifyEnemy('skeleton'), 'ranged');
    assert.equal(classifyEnemy('creeper'), 'explosive');
  });

  it('maps enemy counts to buckets', () => {
    assert.equal(countBucket(1), 'solo');
    assert.equal(countBucket(2), 'duo');
    assert.equal(countBucket(5), 'swarm');
  });

  it('clamps preset values into safety bounds', () => {
    const clamped = clampPreset({
      ...getPresetParams('melee-solo-baseline'),
      followRange: 99,
      crowdAvoidBias: -3
    });
    assert.equal(clamped.followRange, PRESET_BOUNDS.followRange.max);
    assert.equal(clamped.crowdAvoidBias, PRESET_BOUNDS.crowdAvoidBias.min);
  });

  it('returns context-specific preset lists', () => {
    const solo = listPresetsForContext({
      enemyClass: 'melee',
      countBucket: 'solo',
      hasShield: false
    });
    const swarm = listPresetsForContext({
      enemyClass: 'melee',
      countBucket: 'swarm',
      hasShield: true
    });
    assert.ok(solo.includes('melee-solo-baseline'));
    assert.ok(swarm.includes('melee-swarm-baseline'));
    assert.notEqual(solo[0], swarm[0]);
  });

  it('decides backstep when hugging a melee enemy', () => {
    const params = getPresetParams('melee-solo-baseline');
    const decision = decideSpacing({
      params,
      enemyClass: 'melee',
      distance: 1.4,
      enemyFacingBot: 1
    });
    assert.equal(decision.needBackstep, true);
    assert.equal(decision.needStrafe, true);
  });

  it('blends crowd-avoid direction by bias', () => {
    const blended = blendCrowdAvoidDirection({
      awayFromTarget: { x: 1, z: 0 },
      awayFromCrowd: { x: 0, z: 1 },
      bias: 0.5
    });
    assert.ok(blended.x > 0);
    assert.ok(blended.z > 0);
  });
});

describe('CombatEpisodeTracker scoring', () => {
  it('rewards kills and penalizes damage', () => {
    const tracker = new CombatEpisodeTracker();
    const episode = tracker.begin({
      context: { enemyClass: 'melee', countBucket: 'solo', hasShield: false },
      presetId: 'melee-solo-baseline',
      exploring: false,
      enemyName: 'zombie',
      enemyId: 1,
      enemyCount: 1,
      now: 1000
    });
    tracker.recordKill();
    tracker.recordDamage(4);
    const ended = tracker.end({ now: 4000 });
    assert.ok(ended);
    const score = scoreEpisode(ended!);
    assert.ok(score.kills > 0);
    assert.ok(score.damage < 0);
    assert.ok(score.total < score.kills);
    assert.equal(episode.presetId, 'melee-solo-baseline');
  });

  it('splits episodes when the count bucket changes', () => {
    const tracker = new CombatEpisodeTracker();
    tracker.begin({
      context: { enemyClass: 'melee', countBucket: 'solo', hasShield: false },
      presetId: 'melee-solo-baseline',
      exploring: false,
      enemyName: 'zombie',
      enemyId: 1,
      enemyCount: 1,
      now: 1000
    });
    const split = tracker.noteEnemyCount(3, 1500);
    assert.ok(split);
    assert.equal(split!.peakEnemyCount, 3);
    assert.equal(tracker.current, null);
  });

  it('marks interrupted episodes unlearnable', () => {
    const tracker = new CombatEpisodeTracker();
    tracker.begin({
      context: { enemyClass: 'melee', countBucket: 'duo', hasShield: true },
      presetId: 'melee-duo-baseline',
      exploring: true,
      enemyName: 'zombie',
      enemyId: 2,
      enemyCount: 2
    });
    tracker.markInterrupted();
    const ended = tracker.end();
    assert.equal(ended?.learnable, false);
    assert.equal(ended?.interrupted, true);
  });
});

describe('CombatOptimizer + StateStore', () => {
  it('restores defaults from corrupt JSON', () => {
    const state = normalizeCombatState({ version: 999, contexts: 'nope' });
    assert.equal(state.version, 1);
    assert.deepEqual(state.contexts, {});
  });

  it('persists and reloads learning state atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-combat-'));
    const filePath = path.join(dir, 'combat-state.json');
    const store = new CombatStateStore(filePath);
    const ctx = { enemyClass: 'melee' as const, countBucket: 'solo' as const, hasShield: false };
    store.recordEpisodeResult({
      ctx,
      presetId: 'melee-solo-defensive',
      score: 2.5,
      damageTaken: 2,
      kills: 1,
      died: false,
      enemyName: 'zombie'
    });
    store.setSelectedPreset(ctx, 'melee-solo-defensive', true);
    store.flush();

    const reloaded = new CombatStateStore(filePath);
    const entry = reloaded.getContextState(ctx, 'melee-solo-baseline');
    assert.equal(entry.bestPresetId, 'melee-solo-defensive');
    assert.equal(entry.presets['melee-solo-defensive'].trials, 1);
  });

  it('rolls back an exploring preset after fatal damage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-combat-'));
    const store = new CombatStateStore(path.join(dir, 'combat-state.json'));
    const optimizer = new CombatOptimizer(store, {
      enabled: true,
      exploreRate: 1,
      swarmExploreRate: 1,
      minTrials: 1,
      minHealthToExplore: 1,
      exploreDamageAbort: 5,
      maxConsecutiveWorse: 2,
      exploreCooldownMs: 1000
    });
    const ctx = {
      enemyClass: 'melee' as const,
      countBucket: 'solo' as const,
      hasShield: false
    };
    // Seed baseline as best.
    store.recordEpisodeResult({
      ctx,
      presetId: baselinePresetId(ctx),
      score: 3,
      damageTaken: 1,
      kills: 1,
      died: false,
      enemyName: 'zombie'
    });
    store.setSelectedPreset(ctx, baselinePresetId(ctx), true);

    const result = optimizer.completeEpisode({
      context: ctx,
      presetId: 'melee-solo-aggressive',
      exploring: true,
      enemyName: 'zombie',
      enemyId: 9,
      startedAt: Date.now() - 2000,
      endedAt: Date.now(),
      startEnemyCount: 1,
      peakEnemyCount: 1,
      damageTaken: 10,
      hitsLanded: 1,
      kills: 0,
      retreated: false,
      died: false,
      interrupted: false,
      learnable: true
    });
    assert.equal(result.rolledBack, true);
    const entry = store.getContextState(ctx, baselinePresetId(ctx));
    assert.equal(entry.selectedPresetId, baselinePresetId(ctx));
  });

  it('skips learning updates for interrupted episodes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-combat-'));
    const store = new CombatStateStore(path.join(dir, 'combat-state.json'));
    const optimizer = new CombatOptimizer(store, { enabled: true });
    const ctx = {
      enemyClass: 'ranged' as const,
      countBucket: 'duo' as const,
      hasShield: true
    };
    const result = optimizer.completeEpisode({
      context: ctx,
      presetId: 'ranged-duo-baseline',
      exploring: true,
      enemyName: 'skeleton',
      enemyId: 3,
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      startEnemyCount: 2,
      peakEnemyCount: 2,
      damageTaken: 2,
      hitsLanded: 0,
      kills: 0,
      retreated: false,
      died: false,
      interrupted: true,
      learnable: false
    });
    assert.equal(result.reason, 'skipped-unlearnable');
    assert.deepEqual(store.getSnapshot().contexts, {});
  });
});
