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
  it('一般的な敵を分類する', () => {
    assert.equal(classifyEnemy('zombie'), 'melee');
    assert.equal(classifyEnemy('spider'), 'agile');
    assert.equal(classifyEnemy('skeleton'), 'ranged');
    assert.equal(classifyEnemy('minecraft:Skeleton'), 'ranged');
    assert.equal(isRangedEntity({ name: 'zombie', displayName: 'Skeleton' }), true);
    assert.equal(classifyEnemy('creeper'), 'explosive');
  });

  it('プリセット値を安全範囲内へ制限する', () => {
    const clamped = clampPreset({
      ...getPresetParams('melee-baseline'),
      followRange: 99,
      crowdAvoidBias: -3
    });
    assert.equal(clamped.followRange, PRESET_BOUNDS.followRange.max);
    assert.equal(clamped.crowdAvoidBias, PRESET_BOUNDS.crowdAvoidBias.min);
  });

  it('敵数バケットを使わずクラス別プリセット一覧を返す', () => {
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

  it('学習済みプロファイルにより上限付き回避時間が変わる', () => {
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

  it('近接敵へ密着した場合に後退を選ぶ', () => {
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

  it('補正値に応じて敵集団回避方向を混ぜる', () => {
    const blended = blendCrowdAvoidDirection({
      awayFromTarget: { x: 1, z: 0 },
      awayFromCrowd: { x: 0, z: 1 },
      bias: 0.5
    });
    assert.ok(blended.x > 0);
    assert.ok(blended.z > 0);
  });
});

describe('threatArc位置取り', () => {
  const approximately = (actual: number, expected: number, epsilon = 1e-6) => {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
  };

  it('前後から挟まれた脅威を180度と判定する', () => {
    const bot = { x: 0, z: 0 };
    const arc = computeThreatArc(bot, [
      { x: 0, z: 5 },
      { x: 0, z: -5 }
    ]);
    assert.ok(arc);
    assert.ok(Math.abs(spanDegrees(arc!.spanRad) - 180) < 1);
  });

  it('敵が一方向に並ぶ場合はspan 0と判定して留まる', () => {
    const bot = { x: 0, z: 0 };
    const threats = [{ x: 0, z: 4 }, { x: 0, z: 8 }];
    const arc = computeThreatArc(bot, threats);
    assert.ok(arc);
    approximately(arc!.spanRad, 0);
    const selection = chooseBestThreatPosition(bot, threats);
    assert.equal(selection.moved, false);
    assert.deepEqual(selection.chosen.position, bot);
  });

  it('敵が1体なら位置取りしない', () => {
    const selection = chooseBestThreatPosition(
      { x: 0, z: 0 },
      [{ x: 3, z: 0 }]
    );
    assert.equal(selection.moved, false);
  });

  it('180度の挟撃を改善する直交方向への移動を選ぶ', () => {
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

  it('90度配置の外側へ移動してspanを改善する', () => {
    const selection = chooseBestThreatPosition(
      { x: 0, z: 0 },
      [{ x: 0, z: 5 }, { x: 5, z: 0 }],
      { step: 2 }
    );
    assert.equal(selection.moved, true);
    assert.ok(selection.chosen.pathMinEnemyDistance >= 1.8);
    assert.ok(selection.chosen.spanRad < selection.current.spanRad);
  });

  it('局所的な横移動で妥協せず敵列延長上の安全な位置を選ぶ', () => {
    const selection = chooseBestThreatPosition(
      { x: -5, z: 6.75 },
      [{ x: 0, z: 4 }, { x: 0, z: -4 }],
      {
        step: 2.25,
        minEnemyDistance: 1.8,
        ownerPos: { x: -5, z: 0 },
        maxOwnerDistance: 8
      }
    );
    assert.equal(selection.moved, true);
    assert.ok(Math.abs(selection.chosen.position.z) > 4);
    assert.ok(spanDegrees(selection.chosen.spanRad) <= 35);
    assert.ok(selection.chosen.pathMinEnemyDistance >= 1.8);
  });

  it('敵の隣にあるspan 0の位置より安全な改善位置を優先する', () => {
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

  it('-PIとPIをまたぐ方位を正しく扱う', () => {
    const arc = computeThreatArc(
      { x: 0, z: 0 },
      [{ x: 0.1, z: -5 }, { x: -0.1, z: -5 }]
    );
    assert.ok(arc);
    assert.ok(spanDegrees(arc!.spanRad) < 3);
  });

  it('脅威の列挙順と平行移動に対して不変である', () => {
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

  it('固定配置全体の回転に合わせて選択位置も回転する', () => {
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

  it('開始・終了ヒステリシス境界を適用する', () => {
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

  it('逆軸ではなくMineflayer yawでワールド方位を変換する', () => {
    // yaw 0は-Zを向くため、+Zへの移動ではbackを押す。
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

  it('yaw境界をまたいでも単体遠距離敵への回避を直交方向に保つ', () => {
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

  it('複数脅威の位置取り後は集約射線と直交する方向へ回避する', () => {
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

  it('空いた側への横移動方向を決定論的に選ぶ', () => {
    const bot = { x: 0, z: 0 };
    const arc = computeThreatArc(bot, [{ x: 2, z: 4 }, { x: 4, z: 2 }]);
    assert.ok(arc);
    assert.equal(strafeSignForOpenArc({
      botPos: bot,
      primaryPos: { x: 2, z: 4 },
      arc: arc!
    }), 1);
  });

  it('候補評価に危険度と移動コストを含める', () => {
    const evaluated = evaluateThreatPosition({
      origin: { x: 0, z: 0 },
      candidate: { x: 1.5, z: 0 },
      threats: [{ x: 2, z: 0 }, { x: -2, z: 0 }],
      minEnemyDistance: 1.8
    });
    assert.ok(evaluated.dangerPenalty > 0);
    assert.ok(evaluated.pathDangerPenalty > 0);
    assert.ok(evaluated.movementPenalty > 0);
    assert.equal(evaluated.score,
      evaluated.spanRad + evaluated.dangerPenalty
      + evaluated.pathDangerPenalty + evaluated.ownerPenalty
      + evaluated.movementPenalty);
  });
});

describe('位置取り中の戦闘意図', () => {
  it('位置取り中でも近い対象へ届くなら攻撃意図を維持する', () => {
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

  it('攻撃可能性を残しつつ遠距離圧に対する防御を維持する', () => {
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

  it('盾がない場合は遠距離圧に対する回避を維持する', () => {
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

  it('攻撃距離へ入ったら遠距離回避より攻撃を優先する', () => {
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

  it('上限付き回避を開始しバースト上限で明示的な前進へ移る', () => {
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

  it('距離が改善している間は回避を連鎖せず前進を続ける', () => {
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
      // 横回避の開始直後は距離が広がることがある。
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

  it('前進停滞・期限・新規被弾時だけ防御を再開する', () => {
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

  it('攻撃距離へ入ったら進行中の回避を即座に終了する', () => {
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

describe('戦術所有権ラッチ', () => {
  it('短い対象消失中は戦闘所有権を保ち、その後解除する', () => {
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

  it('脅威・被弾では所有権を更新し、空の観測では更新しない', () => {
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

describe('CombatEpisodeTrackerの採点', () => {
  it('撃破を加点し被弾を減点する', () => {
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

  it('エピソードを分割せず最大敵数を更新する', () => {
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

  it('割り込まれたエピソードを学習対象外にする', () => {
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

describe('CombatOptimizerとStateStore', () => {
  it('破損したJSONから既定値へ復元する', () => {
    const state = normalizeCombatState({ version: 999, contexts: 'nope' });
    assert.equal(state.version, 2);
    assert.deepEqual(state.contexts, {});
  });

  it('学習状態を原子的に保存・再読込する', () => {
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

  it('致命的被弾後に探索中プリセットをロールバックする', () => {
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

  it('割り込まれたエピソードでは学習を更新しない', () => {
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
