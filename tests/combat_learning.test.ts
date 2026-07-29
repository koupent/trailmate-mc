import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  baselinePresetId,
  blendCrowdAvoidDirection,
  classifyEnemy,
  isRangedEntity,
  clampPreset,
  decideSpacing,
  getPresetParams,
  listPresetsForContext,
  PRESET_BOUNDS
} from '../src/combat/CombatProfiles.js';
import {
  chooseBestThreatPosition,
  computeThreatArc,
  evaluateThreatPosition,
  generateThreatPositionCandidates,
  movementControlsTowardBearing,
  perpendicularDodgeBearing,
  shouldEnterArcNarrowing,
  shouldExitArcNarrowing,
  ENTER_ARC_NARROW_SPAN_RAD,
  EXIT_ARC_NARROW_SPAN_RAD,
  spanDegrees,
  strafeSignForOpenArc
} from '../src/combat/threatArc.js';
import {
  decideCombatIntent,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch
} from '../src/combat/CombatIntent.js';
import {
  CombatEpisodeTracker,
  scoreEpisode
} from '../src/combat/CombatEpisodeTracker.js';
import {
  CombatStateStore,
  normalizeCombatState
} from '../src/combat/CombatStateStore.js';
import { CombatOptimizer } from '../src/combat/CombatOptimizer.js';
import {
  combatOwnsControl,
  refreshCombatControlUntil
} from '../src/combat/TacticalOwnership.js';

describe('CombatProfiles', () => {
  it('classifies common hostiles', () => {
    assert.equal(classifyEnemy('zombie'), 'melee');
    assert.equal(classifyEnemy('spider'), 'agile');
    assert.equal(classifyEnemy('skeleton'), 'ranged');
    assert.equal(classifyEnemy('minecraft:Skeleton'), 'ranged');
    assert.equal(isRangedEntity({ name: 'zombie', displayName: 'Skeleton' }), true);
    assert.equal(classifyEnemy('creeper'), 'explosive');
  });

  it('clamps preset values into safety bounds', () => {
    const clamped = clampPreset({
      ...getPresetParams('melee-baseline'),
      followRange: 99,
      crowdAvoidBias: -3
    });
    assert.equal(clamped.followRange, PRESET_BOUNDS.followRange.max);
    assert.equal(clamped.crowdAvoidBias, PRESET_BOUNDS.crowdAvoidBias.min);
  });

  it('returns class-specific preset lists without count buckets', () => {
    const melee = listPresetsForContext({
      enemyClass: 'melee',
      hasShield: false
    });
    const ranged = listPresetsForContext({
      enemyClass: 'ranged',
      hasShield: true
    });
    assert.ok(melee.includes('melee-baseline'));
    assert.ok(ranged.includes('ranged-shield-push'));
    assert.equal(baselinePresetId({ enemyClass: 'melee', hasShield: false }), 'melee-baseline');
  });

  it('lets learned profile selection change bounded dodge timing', () => {
    const baseline = getPresetParams('ranged-baseline');
    const shieldPush = getPresetParams('ranged-shield-push');
    const baselineBurst = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 5,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: baseline.rangedDodgeBurstMs,
      advanceMs: baseline.rangedDodgeReassessMs
    });
    const pushBurst = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 5,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: shieldPush.rangedDodgeBurstMs,
      advanceMs: shieldPush.rangedDodgeReassessMs
    });
    assert.ok(pushBurst.latch.burstUntil < baselineBurst.latch.burstUntil);
    assert.ok(
      pushBurst.latch.advanceUntil - pushBurst.latch.burstUntil
      > baselineBurst.latch.advanceUntil - baselineBurst.latch.burstUntil
    );
  });

  it('decides backstep when hugging a melee enemy', () => {
    const params = getPresetParams('melee-baseline');
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

describe('threatArc positioning', () => {
  const approximately = (actual: number, expected: number, epsilon = 1e-6) => {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
  };

  it('reports 180 degrees when threats flank front and back', () => {
    const bot = { x: 0, z: 0 };
    const arc = computeThreatArc(bot, [
      { x: 0, z: 5 },
      { x: 0, z: -5 }
    ]);
    assert.ok(arc);
    assert.ok(Math.abs(spanDegrees(arc!.spanRad) - 180) < 1);
  });

  it('reports zero span and stays when enemies line up in one direction', () => {
    const bot = { x: 0, z: 0 };
    const threats = [{ x: 0, z: 4 }, { x: 0, z: 8 }];
    const arc = computeThreatArc(bot, threats);
    assert.ok(arc);
    approximately(arc!.spanRad, 0);
    const selection = chooseBestThreatPosition(bot, threats);
    assert.equal(selection.moved, false);
    assert.deepEqual(selection.chosen.position, bot);
  });

  it('does not reposition for one enemy', () => {
    const selection = chooseBestThreatPosition(
      { x: 0, z: 0 },
      [{ x: 3, z: 0 }]
    );
    assert.equal(selection.moved, false);
  });

  it('chooses a perpendicular step that reduces a 180-degree flank', () => {
    const bot = { x: 0, z: 0 };
    const threats = [
      { x: 0, z: 5 },
      { x: 0, z: -5 }
    ];
    const selection = chooseBestThreatPosition(bot, threats, { step: 2 });
    assert.equal(selection.moved, true);
    assert.ok(Math.abs(selection.chosen.position.x) > 1.5);
    assert.ok(selection.chosen.spanRad < selection.current.spanRad);
  });

  it('moves outside a 90-degree corner and improves the span', () => {
    const selection = chooseBestThreatPosition(
      { x: 0, z: 0 },
      [{ x: 0, z: 5 }, { x: 5, z: 0 }],
      { step: 2 }
    );
    assert.equal(selection.moved, true);
    assert.ok(selection.chosen.position.x < 0);
    assert.ok(selection.chosen.position.z < 0);
    assert.ok(selection.chosen.spanRad < selection.current.spanRad);
  });

  it('prefers a safe improvement over a zero-span position beside an enemy', () => {
    const selection = chooseBestThreatPosition(
      { x: 0, z: 0 },
      [{ x: -2, z: 0 }, { x: 2, z: 0 }],
      {
        candidates: [{ x: 1.5, z: 0 }, { x: 0, z: 2 }],
        minEnemyDistance: 1.8
      }
    );
    assert.equal(selection.moved, true);
    assert.deepEqual(selection.chosen.position, { x: 0, z: 2 });
    assert.ok(selection.chosen.minEnemyDistance >= 1.8);
  });

  it('handles bearings that cross the -PI/PI boundary', () => {
    const arc = computeThreatArc(
      { x: 0, z: 0 },
      [{ x: 0.1, z: -5 }, { x: -0.1, z: -5 }]
    );
    assert.ok(arc);
    assert.ok(spanDegrees(arc!.spanRad) < 3);
  });

  it('is invariant to threat ordering and translation', () => {
    const bot = { x: 0, z: 0 };
    const threats = [{ x: 0, z: 5 }, { x: 5, z: 0 }, { x: 2, z: -4 }];
    const first = chooseBestThreatPosition(bot, threats, { step: 2 });
    const reversed = chooseBestThreatPosition(bot, [...threats].reverse(), { step: 2 });
    approximately(first.chosen.position.x, reversed.chosen.position.x);
    approximately(first.chosen.position.z, reversed.chosen.position.z);
    approximately(first.chosen.spanRad, reversed.chosen.spanRad);

    const offset = { x: 11, z: -7 };
    const translated = chooseBestThreatPosition(
      { x: bot.x + offset.x, z: bot.z + offset.z },
      threats.map((threat) => ({ x: threat.x + offset.x, z: threat.z + offset.z })),
      { step: 2 }
    );
    approximately(translated.chosen.position.x, first.chosen.position.x + offset.x);
    approximately(translated.chosen.position.z, first.chosen.position.z + offset.z);
  });

  it('rotates the chosen position with the complete fixed layout', () => {
    const rotate = ({ x, z }: { x: number; z: number }) => ({ x: z, z: -x });
    const bot = { x: 0, z: 0 };
    const threats = [{ x: 0, z: 5 }, { x: 5, z: 0 }];
    const candidates = generateThreatPositionCandidates(bot, 2).slice(1);
    const first = chooseBestThreatPosition(bot, threats, { candidates });
    const rotated = chooseBestThreatPosition(
      rotate(bot),
      threats.map(rotate),
      { candidates: candidates.map(rotate) }
    );
    const expected = rotate(first.chosen.position);
    approximately(rotated.chosen.position.x, expected.x);
    approximately(rotated.chosen.position.z, expected.z);
    approximately(rotated.chosen.spanRad, first.chosen.spanRad);
  });

  it('applies enter/exit hysteresis boundaries', () => {
    assert.equal(
      shouldEnterArcNarrowing({
        threatCount: 2,
        spanRad: ENTER_ARC_NARROW_SPAN_RAD * 0.95
      }),
      false
    );
    assert.equal(
      shouldEnterArcNarrowing({
        threatCount: 2,
        spanRad: ENTER_ARC_NARROW_SPAN_RAD * 1.05
      }),
      true
    );
    assert.equal(shouldExitArcNarrowing(EXIT_ARC_NARROW_SPAN_RAD * 0.9), true);
    assert.equal(shouldExitArcNarrowing(EXIT_ARC_NARROW_SPAN_RAD * 1.1), false);
  });

  it('converts world bearings using Mineflayer yaw instead of the opposite axis', () => {
    // yaw 0 faces -Z. Moving toward +Z therefore means pressing back.
    assert.deepEqual(movementControlsTowardBearing(0, 0), {
      forward: false, back: true, left: false, right: false
    });
    assert.deepEqual(movementControlsTowardBearing(Math.PI, 0), {
      forward: true, back: false, left: false, right: false
    });
    assert.deepEqual(movementControlsTowardBearing(Math.PI / 2, 0), {
      forward: false, back: false, left: false, right: true
    });
  });

  it('keeps single-ranged-enemy dodge perpendicular across yaw boundaries', () => {
    const movementVector = (
      controls: ReturnType<typeof movementControlsTowardBearing>,
      yaw: number
    ) => {
      const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      const x = forward.x * (Number(controls.forward) - Number(controls.back))
        + right.x * (Number(controls.right) - Number(controls.left));
      const z = forward.z * (Number(controls.forward) - Number(controls.back))
        + right.z * (Number(controls.right) - Number(controls.left));
      const length = Math.hypot(x, z);
      return { x: x / length, z: z / length };
    };
    const bearings = [0, Math.PI / 2, -Math.PI / 2, Math.PI - 1e-6, -Math.PI + 1e-6];
    const yaws = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI];
    for (const bearing of bearings) {
      for (const yaw of yaws) {
        const dodge = perpendicularDodgeBearing(bearing, 1);
        const controls = movementControlsTowardBearing(dodge, yaw);
        const movement = movementVector(controls, yaw);
        const shot = { x: Math.sin(bearing), z: Math.cos(bearing) };
        approximately(movement.x * shot.x + movement.z * shot.z, 0, 2e-6);
      }
    }
  });

  it('dodges perpendicular to the aggregated line after multi-threat positioning', () => {
    const threats = [{ x: 0, z: 5 }, { x: 5, z: 0 }];
    const selected = chooseBestThreatPosition({ x: 0, z: 0 }, threats, { step: 2 });
    const narrowed = computeThreatArc(selected.chosen.position, threats);
    assert.ok(narrowed);
    assert.ok(narrowed!.spanRad < selected.current.spanRad);
    const dodge = perpendicularDodgeBearing(narrowed!.midRad, -1);
    const line = { x: Math.sin(narrowed!.midRad), z: Math.cos(narrowed!.midRad) };
    const movement = { x: Math.sin(dodge), z: Math.cos(dodge) };
    approximately(line.x * movement.x + line.z * movement.z, 0);
  });

  it('keeps the open-side strafe sign deterministic', () => {
    const bot = { x: 0, z: 0 };
    const arc = computeThreatArc(bot, [{ x: 2, z: 4 }, { x: 4, z: 2 }]);
    assert.ok(arc);
    assert.equal(strafeSignForOpenArc({
      botPos: bot,
      primaryPos: { x: 2, z: 4 },
      arc: arc!
    }), 1);
  });

  it('exposes danger and movement costs in candidate evaluation', () => {
    const evaluated = evaluateThreatPosition({
      origin: { x: 0, z: 0 },
      candidate: { x: 1.5, z: 0 },
      threats: [{ x: 2, z: 0 }, { x: -2, z: 0 }],
      minEnemyDistance: 1.8
    });
    assert.ok(evaluated.dangerPenalty > 0);
    assert.ok(evaluated.movementPenalty > 0);
    assert.equal(evaluated.score,
      evaluated.spanRad + evaluated.dangerPenalty
      + evaluated.ownerPenalty + evaluated.movementPenalty);
  });
});

describe('positioning combat intent', () => {
  it('keeps attack intent while a close target is reachable during positioning', () => {
    const intent = decideCombatIntent({
      distanceToPrimary: 3,
      meleeAttackRange: 3.5,
      rangedThreatCount: 0,
      hasShield: false,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(intent.attack, true);
    assert.equal(intent.priority, 'attack');
  });

  it('keeps guard under ranged pressure while retaining the possible attack intent', () => {
    const intent = decideCombatIntent({
      distanceToPrimary: 3,
      meleeAttackRange: 3.5,
      rangedThreatCount: 2,
      hasShield: true,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(intent.attack, true);
    assert.equal(intent.guard, true);
    assert.equal(intent.priority, 'guard');
  });

  it('keeps dodge under ranged pressure when no shield is available', () => {
    const intent = decideCombatIntent({
      distanceToPrimary: 5,
      meleeAttackRange: 3.5,
      rangedThreatCount: 2,
      hasShield: false,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(intent.dodge, true);
    assert.equal(intent.priority, 'dodge');
  });

  it('lets an in-range attack break ranged dodge pressure', () => {
    const intent = decideCombatIntent({
      distanceToPrimary: 3.4,
      meleeAttackRange: 3.5,
      rangedThreatCount: 1,
      hasShield: false,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(intent.attack, true);
    assert.equal(intent.dodge, false);
    assert.equal(intent.priority, 'attack');
  });

  it('starts a bounded dodge and enters an explicit advance at the burst limit', () => {
    const started = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 5,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: 600,
      advanceMs: 1200
    });
    assert.equal(started.phase, 'dodge');
    assert.equal(started.dodge, true);
    const atLimit = decideRangedDodgeBurst({
      now: started.latch.burstUntil,
      underRangedPressure: true,
      distanceToPrimary: 5,
      meleeAttackRange: 3.5,
      latch: started.latch,
      burstMs: 600,
      advanceMs: 1200
    });
    assert.equal(atLimit.phase, 'advance');
    assert.equal(atLimit.dodge, false);
  });

  it('keeps advancing while distance improves instead of chaining bursts', () => {
    const started = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 8,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: 600,
      advanceMs: 1800,
      stallMs: 750
    });
    const firstAdvance = decideRangedDodgeBurst({
      now: 1600,
      underRangedPressure: true,
      // The lateral dodge may initially increase distance.
      distanceToPrimary: 9,
      meleeAttackRange: 3.5,
      latch: started.latch,
      burstMs: 600,
      advanceMs: 1800,
      stallMs: 750
    });
    const continued = decideRangedDodgeBurst({
      now: 2250,
      underRangedPressure: true,
      distanceToPrimary: 7.5,
      meleeAttackRange: 3.5,
      latch: firstAdvance.latch,
      burstMs: 600,
      advanceMs: 1800,
      stallMs: 750
    });
    assert.equal(firstAdvance.phase, 'advance');
    assert.equal(continued.phase, 'advance');
    assert.equal(firstAdvance.latch.bestDistance, 9);
    assert.equal(continued.latch.bestDistance, 7.5);
  });

  it('restarts defense only after advance stalls, expires, or takes a fresh hit', () => {
    const started = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 8,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: 600,
      advanceMs: 1800,
      stallMs: 750
    });
    const advancing = decideRangedDodgeBurst({
      now: 1600,
      underRangedPressure: true,
      distanceToPrimary: 7.5,
      meleeAttackRange: 3.5,
      latch: started.latch,
      stallMs: 750
    });
    const stalled = decideRangedDodgeBurst({
      now: 2350,
      underRangedPressure: true,
      distanceToPrimary: 7.5,
      meleeAttackRange: 3.5,
      latch: advancing.latch,
      burstMs: 600,
      advanceMs: 1800,
      stallMs: 750
    });
    assert.equal(stalled.phase, 'dodge');

    const freshHit = decideRangedDodgeBurst({
      now: 1700,
      underRangedPressure: true,
      distanceToPrimary: 7,
      meleeAttackRange: 3.5,
      latch: advancing.latch,
      lastDamageAt: 1699,
      burstMs: 600,
      advanceMs: 1800
    });
    assert.equal(freshHit.phase, 'dodge');
    assert.equal(freshHit.latch.handledDamageAt, 1699);

    const expired = decideRangedDodgeBurst({
      now: started.latch.advanceUntil,
      underRangedPressure: true,
      distanceToPrimary: 6.5,
      meleeAttackRange: 3.5,
      latch: {
        ...advancing.latch,
        lastProgressAt: started.latch.advanceUntil
      },
      burstMs: 600,
      advanceMs: 1800
    });
    assert.equal(expired.phase, 'dodge');
  });

  it('ends an active dodge immediately when attack range becomes available', () => {
    const decision = decideRangedDodgeBurst({
      now: 1200,
      underRangedPressure: true,
      distanceToPrimary: 3,
      meleeAttackRange: 3.5,
      latch: {
        burstUntil: 1600,
        advanceUntil: 3000,
        bestDistance: 5,
        lastProgressAt: 1000,
        handledDamageAt: 0
      }
    });
    assert.equal(decision.phase, 'attack');
    assert.equal(decision.dodge, false);
    assert.equal(decision.latch.burstUntil, 0);
    assert.equal(decision.latch.advanceUntil, 0);
  });
});

describe('tactical ownership latch', () => {
  it('keeps combat ownership through a short target gap then releases it', () => {
    const engagedUntil = refreshCombatControlUntil({
      now: 1000,
      previousUntil: 0,
      activeThreat: true,
      stableMs: 1500
    });
    assert.equal(engagedUntil, 2500);
    assert.equal(combatOwnsControl(2499, engagedUntil), true);
    assert.equal(combatOwnsControl(2500, engagedUntil), false);
  });

  it('refreshes ownership on threat or damage but not an empty observation', () => {
    const unchanged = refreshCombatControlUntil({
      now: 1500,
      previousUntil: 2000,
      activeThreat: false
    });
    const damaged = refreshCombatControlUntil({
      now: 1800,
      previousUntil: unchanged,
      activeThreat: false,
      freshDamage: true,
      stableMs: 1500
    });
    assert.equal(unchanged, 2000);
    assert.equal(damaged, 3300);
  });
});

describe('CombatEpisodeTracker scoring', () => {
  it('rewards kills and penalizes damage', () => {
    const tracker = new CombatEpisodeTracker();
    const episode = tracker.begin({
      context: { enemyClass: 'melee', hasShield: false },
      presetId: 'melee-baseline',
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
    assert.equal(episode.presetId, 'melee-baseline');
  });

  it('updates peak enemy count without splitting the episode', () => {
    const tracker = new CombatEpisodeTracker();
    tracker.begin({
      context: { enemyClass: 'melee', hasShield: false },
      presetId: 'melee-baseline',
      exploring: false,
      enemyName: 'zombie',
      enemyId: 1,
      enemyCount: 1,
      now: 1000
    });
    tracker.noteEnemyCount(3);
    assert.equal(tracker.current?.peakEnemyCount, 3);
    assert.ok(tracker.current);
  });

  it('marks interrupted episodes unlearnable', () => {
    const tracker = new CombatEpisodeTracker();
    tracker.begin({
      context: { enemyClass: 'melee', hasShield: true },
      presetId: 'melee-baseline',
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
    assert.equal(state.version, 2);
    assert.deepEqual(state.contexts, {});
  });

  it('persists and reloads learning state atomically', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-combat-'));
    const filePath = path.join(dir, 'combat-state.json');
    const store = new CombatStateStore(filePath);
    const ctx = { enemyClass: 'melee' as const, hasShield: false };
    store.recordEpisodeResult({
      ctx,
      presetId: 'melee-defensive',
      score: 2.5,
      damageTaken: 2,
      kills: 1,
      died: false,
      enemyName: 'zombie'
    });
    store.setSelectedPreset(ctx, 'melee-defensive', true);
    store.flush();

    const reloaded = new CombatStateStore(filePath);
    const entry = reloaded.getContextState(ctx, 'melee-baseline');
    assert.equal(entry.bestPresetId, 'melee-defensive');
    assert.equal(entry.presets['melee-defensive'].trials, 1);
  });

  it('rolls back an exploring preset after fatal damage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-combat-'));
    const store = new CombatStateStore(path.join(dir, 'combat-state.json'));
    const optimizer = new CombatOptimizer(store, {
      enabled: true,
      exploreRate: 1,
      minTrials: 1,
      minHealthToExplore: 1,
      exploreDamageAbort: 5,
      maxConsecutiveWorse: 2,
      exploreCooldownMs: 1000
    });
    const ctx = {
      enemyClass: 'melee' as const,
      hasShield: false
    };
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
      presetId: 'melee-aggressive',
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
      hasShield: true
    };
    const result = optimizer.completeEpisode({
      context: ctx,
      presetId: 'ranged-shield-push',
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
