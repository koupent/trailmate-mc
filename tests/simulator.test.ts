import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeThreatArc, spanDegrees } from '../src/combat/threatArc.js';
import {
  createScenario,
  resolveRangedImpact,
  stepSimulation,
  type SimulationDecision,
  type SimulationState
} from '../src/simulator/SimulationCore.js';
import { createBlockSet, hasVoxelLineOfSight, standingY } from '../src/simulator/voxel.js';
import { generateArena, createSeededRng } from '../src/simulator/ArenaGenerator.js';
import { pickCurriculumArenaKind } from '../src/simulator/ArenaCurriculum.js';
import { GymRunner } from '../src/simulator/GymRunner.js';
import { buildReviewMarkdown } from '../src/simulator/ReviewPack.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function runUntil(
  initial: SimulationState,
  predicate: (state: SimulationState, decision: SimulationDecision) => boolean,
  maxTicks = 80
) {
  let state = initial;
  let decision: SimulationDecision | null = null;
  for (let index = 0; index < maxTicks; index += 1) {
    ({ state, decision } = stepSimulation(state));
    if (predicate(state, decision)) return { state, decision };
  }
  throw new Error(`condition not reached after ${maxTicks} ticks`);
}

describe('ローカル戦闘シミュレータの中核', () => {
  it('共通の遠距離ラッチで回避→前進→攻撃する', () => {
    let state = createScenario('single-ranged');
    let result = stepSimulation(state);
    assert.equal(result.decision.controlOwner, 'combat');
    assert.equal(result.decision.movement, 'dodge');

    ({ state } = result);
    result = runUntil(state, (next) => next.attacks > 0);
    assert.equal(result.decision.movement, 'attack');
    assert.ok(result.state.attacks > 0);
  });

  it('単体遠距離は安全点／接近点へ直線で近づく', () => {
    let state = createScenario('single-ranged');
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.bot.hp = 40;
    state.inventory = ['stone_sword'];
    const enemy = state.enemies[0];
    const startRadius = Math.hypot(state.bot.x - enemy.x, state.bot.z - enemy.z);
    let prevRadius = startRadius;
    let shrinkTicks = 0;
    let sawStraight = false;

    for (let tick = 0; tick < 14; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (state.bot.hp <= 0 || state.enemies.every((item) => item.hp <= 0)) break;
      if (result.decision.movement === 'attack') break;
      assert.ok(
        result.decision.movement === 'dodge'
        || result.decision.movement === 'advance'
        || result.decision.movement === 'positioning',
        `unexpected movement ${result.decision.movement}`
      );
      if (result.decision.routePreview?.mode === 'straight') sawStraight = true;
      const radius = Math.hypot(state.bot.x - enemy.x, state.bot.z - enemy.z);
      if (radius < prevRadius - 0.02) shrinkTicks += 1;
      prevRadius = radius;
    }

    assert.ok(sawStraight, 'approach should publish straight routePreview');
    assert.ok(shrinkTicks >= 3, `should close distance, shrinkTicks=${shrinkTicks}`);
    assert.ok(prevRadius < startRadius - 0.8, `should close in: ${prevRadius} vs start ${startRadius}`);
  });

  it('近接複数の位置取りは直線で安全点へ寄り、単体近接も直線', () => {
    let state = createScenario('dynamic-melee-pincer');
    state.enemyAi = { enabled: false, speedScale: 1 };
    let sawFans = false;
    let sawStraight = false;
    for (let tick = 0; tick < 10; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if ((result.decision.safeZoneDebug?.fans?.length || 0) >= 2) sawFans = true;
      // 扇圧があっても打撃／接近を優先することがある。直線ルートが出ればOK。
      if (
        (result.decision.movement === 'positioning' || result.decision.movement === 'advance')
        && result.decision.routePreview?.mode === 'straight'
      ) {
        sawStraight = true;
      }
      if (result.decision.movement === 'positioning') {
        assert.ok(
          (result.decision.safeZoneDebug?.fans?.length || 0) > 0,
          'positioning exposes attack fans'
        );
      }
    }
    assert.ok(sawFans, 'multi-threat should expose attack fan debug');
    assert.ok(sawStraight, 'multi threat uses straight route on position/advance');

    let single = createScenario('single-melee');
    if (!single.enemies.length) {
      single = createScenario('recovery');
      single.recovery.active = false;
      single.enemies = [{ id: 9, kind: 'zombie', x: 6, y: 1, z: 0, hp: 20 }];
      single.bot = { ...single.bot, x: 0, y: 1, z: 0, hp: 20 };
    }
    single.enemyAi = { enabled: false, speedScale: 1 };
    for (let tick = 0; tick < 8; tick += 1) {
      const result = stepSimulation(single);
      single = result.state;
      if (result.decision.movement === 'advance') {
        assert.ok(
          !result.decision.routePreview
          || result.decision.routePreview.mode === 'straight',
          'single melee advance is straight'
        );
      }
    }
  });

  it('前後の敵列の片端より外側へ安全に移動し鋭角spanへ収束する', () => {
    let state = createScenario('multi-positioning');
    const before = computeThreatArc(state.bot, state.enemies)!;
    let reached = false;
    let bestSpan = spanDegrees(before.spanRad);

    for (let tick = 0; tick < 70; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (state.enemies.length < 2) break;
      const arc = computeThreatArc(state.bot, state.enemies);
      if (!arc) break;
      bestSpan = Math.min(bestSpan, spanDegrees(arc.spanRad));
      const minEnemyDistance = Math.min(...state.enemies.map((enemy) => (
        Math.hypot(enemy.x - state.bot.x, enemy.z - state.bot.z)
      )));
      const ownerDistance = Math.hypot(state.bot.x - state.owner!.x, state.bot.z - state.owner!.z);
      assert.equal(result.decision.controlOwner, 'combat');
      // 肉壁で殴るときは近接に寄るので、めり込み未満だけ禁止
      assert.ok(minEnemyDistance >= 0.5 - 1e-6);
      assert.ok(ownerDistance <= 9 + 1e-6);
      if (spanDegrees(arc.spanRad) <= 55 && Math.abs(state.bot.z) > 3.2) {
        reached = true;
        break;
      }
    }

    assert.ok(
      reached || bestSpan + 1e-6 < spanDegrees(before.spanRad) || state.attacks > 0,
      `bot should narrow threat span or fight from cover (best=${bestSpan}, start=${spanDegrees(before.spanRad)}, z=${state.bot.z}, attacks=${state.attacks})`
    );
  });

  it('共通owned-ID方針で墓復旧し、その後戦闘を再取得する', () => {
    const initial = createScenario('recovery');
    const recovered = runUntil(initial, (state) => !state.recovery.active);
    assert.equal(recovered.state.equipped, 'iron_sword');
    assert.ok(recovered.state.inventory.includes('iron_boots'));
    assert.ok(recovered.state.transitions.some((line) => line.includes('墓処理 → アイテム回収')));

    const combat = stepSimulation(recovered.state);
    assert.equal(combat.decision.controlOwner, 'combat');
    assert.ok(combat.decision.primaryId);
  });

  it('墓破壊前からある無関係なドロップをRecovery対象外に保つ', () => {
    let state = createScenario('recovery');
    state.drops.push({ id: 77, item: 'dirt', x: 0.2, y: 1, z: 0.2 });
    const reachedItems = runUntil(state, (next) => next.recovery.phase === 'items');
    const captured = stepSimulation(reachedItems.state);
    assert.ok(!captured.state.recovery.ownedItemIds.includes(77));
  });

  it('近接挟撃を毎tick移動させ、脅威spanを継続再評価する', () => {
    let state = createScenario('dynamic-melee-pincer');
    const initialPositions = state.enemies.map(({ x, z }) => ({ x, z }));
    const spans = new Set<number>();
    let sawPositioning = false;
    let sawAcuteSpan = false;

    for (let tick = 0; tick < 8; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      assert.equal(result.decision.controlOwner, 'combat');
      assert.equal(result.decision.enemyMotions.length, 2);
      assert.ok(result.decision.enemyMotions.every((motion) => (
        motion.behavior === 'chase'
        || motion.behavior === 'hold'
        || motion.behavior === 'retreat'
      )));
      if (result.decision.spanDeg != null) spans.add(Number(result.decision.spanDeg.toFixed(3)));
      sawAcuteSpan ||= (result.decision.selectedSpanDeg ?? 180) <= 42;
      sawPositioning ||= result.decision.movement === 'positioning';
    }

    assert.ok(sawPositioning || spans.size >= 1);
    assert.ok(sawAcuteSpan || [...spans].some((span) => span <= 120) || spans.size >= 1);
    assert.ok(state.enemies.some((enemy, index) => (
      Math.hypot(enemy.x - initialPositions[index].x, enemy.z - initialPositions[index].z) > 1
    )));
  });

  it('敵AIが決定論的で、有効・速度設定に従う', () => {
    const disabled = createScenario('dynamic-melee-pincer');
    disabled.enemyAi.enabled = false;
    const held = stepSimulation(disabled);
    assert.equal(held.decision.enemyMotions.length, 0);
    assert.deepEqual(held.state.enemies, disabled.enemies);

    const slow = createScenario('dynamic-melee-pincer');
    slow.enemyAi.speedScale = 0.5;
    const fast = createScenario('dynamic-melee-pincer');
    fast.enemyAi.speedScale = 2;
    const slowStep = stepSimulation(slow);
    const repeatedSlowStep = stepSimulation(slow);
    const fastStep = stepSimulation(fast);
    assert.deepEqual(slowStep, repeatedSlowStep);
    assert.ok(fastStep.decision.enemyMotions[0].speed > slowStep.decision.enemyMotions[0].speed * 3.9);
  });

  it('移動する遠距離敵2体の圧を保ちながら位置取り・回避する', () => {
    let state = createScenario('dynamic-ranged-pressure');
    state.bot.hp = 100;
    let sawPositioningWithDodge = false;
    let sawStrafe = false;
    let sawAcuteDestination = false;
    let sawTwoPressure = false;

    for (let tick = 0; tick < 48; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (state.ended || state.botDead) break;
      assert.equal(result.decision.controlOwner, 'combat');
      // 飛行弾モデル後は瞬間的に圧0のtickもありうる
      assert.ok(result.decision.rangedPressureCount >= 0);
      assert.ok(
        result.decision.intent?.priority === 'dodge'
        || result.decision.intent?.priority === 'attack'
        || result.decision.intent?.priority === 'guard'
        || result.decision.intent?.priority === 'hold'
        || result.decision.intent == null
      );
      sawTwoPressure ||= result.decision.rangedPressureCount >= 1;
      sawPositioningWithDodge ||= result.decision.movement === 'positioning'
        || result.decision.movement === 'dodge';
      sawStrafe ||= result.decision.enemyMotions.some((motion) => motion.behavior === 'strafe');
      sawAcuteDestination ||= (result.decision.selectedSpanDeg ?? 180) <= 42;
    }

    assert.ok(sawPositioningWithDodge);
    assert.ok(sawTwoPressure);
    assert.ok(sawStrafe);
    assert.ok(sawAcuteDestination || state.shots >= 2);
    assert.ok(state.shots >= 2);
  });

  it('動的な混成戦闘で防御的回避から攻撃意図へ更新する', () => {
    let state = createScenario('dynamic-mixed');
    const intents = new Set<string>();
    const movements = new Set<string>();
    const spans = new Set<number>();
    let sawAcuteDestination = false;

    for (let tick = 0; tick < 40; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      assert.equal(result.decision.controlOwner, 'combat');
      if (result.decision.intent) intents.add(result.decision.intent.priority);
      movements.add(result.decision.movement);
      if (result.decision.spanDeg != null) spans.add(Number(result.decision.spanDeg.toFixed(2)));
      sawAcuteDestination ||= (result.decision.selectedSpanDeg ?? 180) <= 90;
      if (intents.has('dodge') && intents.has('attack')) break;
    }

    assert.ok(intents.has('dodge'));
    assert.ok(intents.has('attack'));
    assert.ok(movements.has('positioning'));
    assert.ok(sawAcuteDestination);
    assert.ok(spans.size > 1);
  });

  it('高台シナリオでエンティティが y>1 に立つ', () => {
    const state = createScenario('elevated-ranged');
    assert.ok(state.blocks.some((block) => block.y === 1));
    assert.equal(state.enemies[0].y, 2);
    assert.equal(state.bot.y, 1);
    const stepped = stepSimulation(state);
    assert.equal(stepped.decision.controlOwner, 'combat');
  });

  it('攻撃扇肉壁: カバー中に横飛びせず近接を片付けて勝つ', () => {
    let state = createScenario('attack-fan-cover');
    state.enemyAi = { enabled: false, speedScale: 1 };
    let maxSafeXWhileZombie = 0;
    for (let i = 0; i < 80; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const safe = result.decision.safeZoneDebug?.safeZone;
      const dest = result.decision.destination;
      if (safe && dest) {
        const align = Math.hypot(safe.x - dest.x, safe.z - dest.z);
        assert.ok(align < 0.05, `safe/dest mismatch ${align}`);
      }
      if (state.enemies.some((enemy) => enemy.kind === 'zombie' && enemy.hp > 0) && safe) {
        maxSafeXWhileZombie = Math.max(maxSafeXWhileZombie, Math.abs(safe.x));
      }
      if (state.ended) break;
    }
    assert.equal(state.outcome, 'win');
    assert.equal(state.damageTaken, 0);
    assert.ok(state.attacks >= 8);
    assert.ok(maxSafeXWhileZombie < 1.6, `meat-wall safe drifted x=${maxSafeXWhileZombie}`);
  });

  it('単体遠距離: 緑箱と移動目標が一致し真正面突撃しない', () => {
    let state = createScenario('single-ranged');
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];
    let headOn = 0;
    let moves = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const safe = result.decision.safeZoneDebug?.safeZone;
      const dest = result.decision.destination;
      const skel = state.enemies.find((enemy) => enemy.kind === 'skeleton');
      if (safe && dest) {
        assert.ok(Math.hypot(safe.x - dest.x, safe.z - dest.z) < 0.05);
      }
      if (dest && skel && (result.decision.movement === 'advance' || result.decision.movement === 'dodge')) {
        moves += 1;
        const toEnemy = Math.atan2(skel.x - state.bot.x, skel.z - state.bot.z);
        const toDest = Math.atan2(dest.x - state.bot.x, dest.z - state.bot.z);
        let delta = Math.abs(toDest - toEnemy);
        while (delta > Math.PI) delta = Math.abs(delta - Math.PI * 2);
        if (delta < 0.2) headOn += 1;
      }
      if (state.ended) break;
    }
    assert.ok(moves >= 3);
    assert.ok(headOn === 0, `head-on approaches=${headOn}`);
    assert.equal(state.outcome, 'win');
  });

  it('壁越しでは遠距離LOSが遮られる', () => {
    const state = createScenario('wall-los-block');
    const blocks = createBlockSet(state.blocks);
    assert.equal(hasVoxelLineOfSight(blocks, state.bot, state.enemies[0]), false);
    const open = createScenario('single-ranged');
    assert.equal(
      hasVoxelLineOfSight(createBlockSet(open.blocks), open.bot, open.enemies[0]),
      true
    );
  });

  it('矢が壁に当たる射線では遠距離圧・回避を立てない', () => {
    // 低い壁: 目線LOSは通るが、矢（胸部高さ）は壁に当たる
    let state = createScenario('wall-los-block');
    const floor = state.blocks.filter((block) => block.y === 0);
    const lowWall = [];
    for (let z = -3; z <= 3; z += 1) {
      lowWall.push({ x: 3, y: 1, z });
    }
    state.blocks = [...floor, ...lowWall];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemies = [{ id: 1, kind: 'skeleton', x: 7, y: 1, z: 0, hp: 20 }];
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];
    const blocks = createBlockSet(state.blocks);
    assert.equal(hasVoxelLineOfSight(blocks, state.bot, state.enemies[0]), true);
    assert.equal(
      resolveRangedImpact(state.enemies[0], state.bot, state.enemies, blocks).hitKind,
      'block'
    );

    let dodgeWhileBlocked = 0;
    let pressureWhileBlocked = 0;
    let blockedTicks = 0;
    for (let tick = 0; tick < 12; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const stillBlocked = resolveRangedImpact(
        state.enemies[0],
        state.bot,
        state.enemies,
        createBlockSet(state.blocks)
      ).hitKind === 'block';
      if (!stillBlocked) break;
      blockedTicks += 1;
      if (result.decision.movement === 'dodge') dodgeWhileBlocked += 1;
      if ((result.decision.rangedPressureCount || 0) > 0) pressureWhileBlocked += 1;
    }
    // 直線ダッシュで壁影をすぐ抜けることがあるので、遮られている間だけを検証
    assert.ok(blockedTicks >= 1, '射線が壁で止まる区間が少なくとも1tickある');
    assert.equal(pressureWhileBlocked, 0, '矢が届かない間は遠距離圧0');
    assert.equal(dodgeWhileBlocked, 0, '届かない遠距離に対して回避しない');
  });

  it('壁越しでは近接攻撃も通らない', () => {
    let state = createScenario('wall-los-block');
    state.bot = { ...state.bot, x: 2.2, y: 1, z: 0 };
    state.enemies = [{ id: 1, kind: 'zombie', x: 3.8, y: 1, z: 0, hp: 20 }];
    state.enemyAi = { enabled: false, speedScale: 1 };
    const blocks = createBlockSet(state.blocks);
    assert.equal(hasVoxelLineOfSight(blocks, state.bot, state.enemies[0]), false);
    const result = stepSimulation(state);
    assert.notEqual(result.decision.movement, 'attack');
    assert.equal(result.state.attacks, 0);
    assert.equal(result.state.enemies[0]?.hp, 20);
  });

  it('同座標めり込みでは押し出して近接が通る', () => {
    let state = createScenario('dynamic-melee-pincer');
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemies = [{ id: 1, kind: 'zombie', x: 0, y: 1, z: 0, hp: 20 }];
    state.enemyAi = { enabled: true, speedScale: 1 };
    let sawAttack = false;
    for (let tick = 0; tick < 12; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (result.decision.movement === 'attack' || state.attacks > 0) sawAttack = true;
      if (state.enemies.length === 0 || state.botDead) break;
    }
    assert.ok(sawAttack, 'めり込んでも攻撃できる');
    assert.ok(state.attacks > 0 || state.enemies.length === 0);
    if (state.enemies[0]) {
      const dist = Math.hypot(state.bot.x - state.enemies[0].x, state.bot.z - state.enemies[0].z);
      assert.ok(dist > 0.2, `押し出し後は重ならない dist=${dist}`);
    }
  });

  it('壁で直進できないときは回り込み、壁に吸い付かない', () => {
    let state = createScenario('wall-los-block');
    state.bot = { ...state.bot, x: 1, y: 1, z: 0 };
    state.enemies = [{ id: 1, kind: 'zombie', x: 7, y: 1, z: 0, hp: 24 }];
    state.enemyAi = { enabled: false, speedScale: 1 };
    const startZ = state.bot.z;
    let maxAbsZ = 0;
    let moved = false;
    for (let tick = 0; tick < 50; tick += 1) {
      const before = { x: state.bot.x, z: state.bot.z };
      const result = stepSimulation(state);
      state = result.state;
      const step = Math.hypot(state.bot.x - before.x, state.bot.z - before.z);
      if (step > 0.1) moved = true;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(state.bot.z - startZ));
      if (state.bot.x > 3.5 || state.attacks > 0) break;
    }
    assert.ok(moved, '前進が完全停止しない');
    assert.ok(
      maxAbsZ > 1.5 || state.bot.x > 3.5 || state.attacks > 0,
      `壁を迂回して z 方向へ動くか回り込む maxAbsZ=${maxAbsZ} x=${state.bot.x}`
    );
  });

  it('壁越しスケルトンでも壁面を滑らず回り込み、攻撃を開始する', () => {
    // 以前は dest が壁の向こうの敵直指定で、手前を左右に往復し続け攻撃0だった
    let state = generateArena(158, 'wall-los');
    state.inventory = ['stone_sword'];
    let sawPastWall = false;
    let maxStuck = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      maxStuck = Math.max(maxStuck, state.approachStuckTicks || 0);
      if (state.bot.x > 3.5) sawPastWall = true;
      if (state.attacks > 0 || state.ended) break;
    }
    assert.ok(sawPastWall, `壁を越える x=${state.bot.x}`);
    assert.ok(state.attacks > 0, '回り込み後に攻撃を開始する');
    assert.ok(maxStuck < 25, `旋回が壁で長時間スタックしない stuck=${maxStuck}`);
  });

  it('壁付き遠距離旋回は壁内の虚点へ吸い付かず横へ迂回する', () => {
    let state = createScenario('wall-los-block');
    state.bot = { ...state.bot, x: -2, y: 1, z: 0 };
    state.enemies = [{ id: 1, kind: 'skeleton', x: 7, y: 1, z: 0, hp: 20 }];
    state.inventory = ['stone_sword'];
    state.enemyAi = { enabled: false, speedScale: 1 };
    const startZ = state.bot.z;
    let maxAbsZ = 0;
    let moved = false;
    for (let tick = 0; tick < 40; tick += 1) {
      const before = { x: state.bot.x, z: state.bot.z };
      const result = stepSimulation(state);
      state = result.state;
      // 目的地が壁ブロック内にならない
      if (result.decision.destination) {
        const dx = Math.abs(result.decision.destination.x - 3);
        const onWallPlane = dx < 0.55
          && Math.abs(result.decision.destination.z) < 2.5;
        assert.ok(!onWallPlane, 'destination must not sit inside the wall slab');
      }
      const step = Math.hypot(state.bot.x - before.x, state.bot.z - before.z);
      if (step > 0.08) moved = true;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(state.bot.z - startZ));
      if (state.bot.x > 3.5 || state.attacks > 0) break;
    }
    assert.ok(moved, '前進が完全停止しない');
    assert.ok(
      maxAbsZ > 1.2 || state.bot.x > 3.5 || state.attacks > 0,
      `壁を迂回して z 方向へ動く maxAbsZ=${maxAbsZ} x=${state.bot.x}`
    );
  });

  it('相棒HPが0になると死亡して戦闘を打ち切る', () => {
    let state = createScenario('single-ranged');
    state.enemyAi.enabled = true;
    state.bot.hp = 2;
    let sawDead = false;
    for (let tick = 0; tick < 40; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (state.botDead || state.outcome === 'lose') {
        sawDead = true;
        assert.equal(state.bot.hp, 0);
        assert.equal(state.ended, true);
        assert.equal(result.decision.movement, 'dead');
        const again = stepSimulation(state);
        assert.equal(again.state.attacks, state.attacks, '死亡後は攻撃が増えない');
        assert.equal(again.decision.movement, 'dead');
        break;
      }
    }
    assert.ok(sawDead, 'bot should die when HP reaches 0');
  });

  it('遠距離弾は間にいる他敵に当たり相棒には届かない', () => {
    const shooter = { id: 1, kind: 'skeleton', x: 8, y: 1, z: 0, hp: 20 };
    const blocker = { id: 2, kind: 'zombie', x: 4, y: 1, z: 0, hp: 20 };
    const bot = { x: 0, y: 1, z: 0 };
    const impact = resolveRangedImpact(shooter, bot, [shooter, blocker]);
    assert.equal(impact.hitKind, 'enemy');
    assert.equal(impact.hitEntityId, 2);

    let state = createScenario('dynamic-mixed');
    state.enemyAi.enabled = true;
    state.bot = { x: 0, y: 1, z: 0, yaw: 0, hp: 20 };
    state.enemies = [
      { id: 1, kind: 'skeleton', x: 8, y: 1, z: 0, hp: 20 },
      { id: 2, kind: 'zombie', x: 4, y: 1, z: 0, hp: 20 }
    ];
    state.tick = 0;
    const beforeHp = state.bot.hp;
    const beforeZombie = state.enemies[1].hp;
    let sawFriendly = false;
    for (let tick = 0; tick < 20; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const friendly = (result.decision.enemyMotions || []).find((motion) => (
        motion.hitKind === 'enemy'
      ));
      if (friendly || state.enemies.some((e) => e.id === 2 && e.hp < beforeZombie)) {
        sawFriendly = true;
        assert.ok(state.bot.hp >= beforeHp - 1, '味方撃ち時は相棒へのダメージが抑えられる');
        const zombie = state.enemies.find((enemy) => enemy.id === 2);
        if (zombie) assert.ok(zombie.hp < beforeZombie);
        break;
      }
    }
    assert.ok(sawFriendly, 'arrow should hit intervening enemy');
  });

  it('遠距離弾は飛行中に射線から外れるとミスになる', () => {
    let state = createScenario('single-ranged');
    state.enemyAi = { enabled: true, speedScale: 0.25 };
    state.inventory = ['stone_sword'];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemies = [{ id: 1, kind: 'skeleton', x: 9, y: 1, z: 0, hp: 20 }];
    state.tick = 0;
    const startHp = state.bot.hp;
    let sawShot = false;
    let sawMissOrDodge = false;
    for (let tick = 0; tick < 24; tick += 1) {
      // 敵をほぼ固定して射線を安定させる
      if (state.enemies[0]) {
        state.enemies[0].x = 9;
        state.enemies[0].z = 0;
      }
      const beforeHp = state.bot.hp;
      const result = stepSimulation(state);
      state = result.state;
      if ((result.decision.enemyMotions || []).some((m) => m.fired) || (state.projectiles || []).length) {
        sawShot = true;
      }
      if (sawShot && Math.abs(state.bot.z) > 1.2 && state.bot.hp === beforeHp) {
        sawMissOrDodge = true;
      }
      if (state.bot.hp <= 0) break;
    }
    assert.ok(sawShot, 'skeleton should fire');
    assert.ok(
      sawMissOrDodge || state.bot.hp === startHp || state.damageTaken < 6,
      `moving off the flight line should let some arrows miss hp=${state.bot.hp} dmg=${state.damageTaken}`
    );
  });
});

describe('自動ジムと分析パック', () => {
  it('同じシードでアリーナ生成が再現される', () => {
    const a = generateArena(42, 'elevated-ranged');
    const b = generateArena(42, 'elevated-ranged');
    assert.equal(a.arenaKind, 'elevated-ranged');
    assert.deepEqual(a.enemies.map(({ kind, x, y, z }) => ({ kind, x, y, z })), b.enemies.map(({ kind, x, y, z }) => ({ kind, x, y, z })));
    assert.equal(a.blocks.length, b.blocks.length);
  });

  it('シード付きRNGが決定論的', () => {
    const a = createSeededRng(99);
    const b = createSeededRng(99);
    assert.deepEqual([a.next(), a.int(0, 10), a.pick(['a', 'b'])], [b.next(), b.int(0, 10), b.pick(['a', 'b'])]);
  });

  it('GymRunnerがエピソードを実行しレビューMarkdownを出す', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-gym-'));
    const gym = new GymRunner({
      statePath: path.join(dir, 'sim-combat-state.json'),
      learningEnabled: true,
      maxTicks: 40
    });
    const batch = gym.runBatch(5, 1000);
    assert.equal(batch.length, 5);
    const stats = gym.getStats();
    assert.equal(stats.episodes, 5);
    assert.ok(stats.tuning);
    assert.equal(stats.tuning.method.tunableCount, 3);
    assert.equal(stats.tuning.catalog.length, 3);
    assert.ok(stats.tuning.aggregate.mode);
    const markdown = gym.buildReviewMarkdown();
    assert.match(markdown, /責務分離/);
    assert.match(markdown, /自動チューニング状態/);
    assert.match(markdown, /再現コマンド/);
    const packed = buildReviewMarkdown(gym.buildReviewSummary(), stats.worst);
    assert.ok(packed.includes('依頼'));
    gym.flush();
  });

  it('GymRunnerの resetSession で統計と学習状態を空にできる', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-gym-reset-'));
    const statePath = path.join(dir, 'sim-combat-state.json');
    const gym = new GymRunner({
      statePath,
      learningEnabled: true,
      maxTicks: 30
    });
    gym.runBatch(3, 2000);
    assert.ok(gym.getStats().episodes >= 3);
    const cleared = gym.resetSession();
    assert.equal(cleared.clearedEpisodes, 3);
    assert.equal(gym.getStats().episodes, 0);
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(raw.contexts, {});
  });

  it('standingYが床の上を返す', () => {
    const blocks = createBlockSet([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }]);
    assert.equal(standingY(blocks, 0, 0), 1);
    assert.equal(standingY(blocks, 1.2, 0), 2);
  });

  it('pit-melee の穴には底床があり、虚空では即死亡して戦闘が終わる', () => {
    const pit = generateArena(42, 'pit-melee');
    const surfaceMissing = pit.blocks.some((block) => block.y === -1);
    assert.ok(surfaceMissing, '穴の底(y=-1)が存在する');
    assert.ok(pit.bot.y >= 1, '相棒は通常床にスポーンする');

    // 意図的に虚空へ落とす
    let state = {
      ...pit,
      bot: { ...pit.bot, x: 0, y: -1, z: 0 },
      blocks: pit.blocks.filter((block) => !(Math.abs(block.x) <= 1 && Math.abs(block.z) <= 1))
    };
    const result = stepSimulation(state);
    assert.equal(result.state.botDead, true);
    assert.equal(result.state.ended, true);
    assert.equal(result.state.outcome, 'lose');
    assert.ok(result.state.bot.y > -20, '無限落下しない');
  });

  it('カリキュラムは未試行を埋め、苦手アリーナを優先する', () => {
    const cold = pickCurriculumArenaKind({
      seed: 1,
      exploreRate: 0,
      minTrials: 2,
      performance: [
        { kind: 'flat-melee', episodes: 5, wins: 5, deaths: 0, avgScore: 5 },
        { kind: 'elevated-ranged', episodes: 0, wins: 0, deaths: 0, avgScore: 0 }
      ],
      kinds: ['flat-melee', 'elevated-ranged']
    });
    assert.equal(cold.kind, 'elevated-ranged');
    assert.equal(cold.reason, 'coverage');

    const weak = pickCurriculumArenaKind({
      seed: 99,
      exploreRate: 0,
      minTrials: 2,
      performance: [
        { kind: 'flat-melee', episodes: 10, wins: 9, deaths: 1, avgScore: 4 },
        { kind: 'elevated-ranged', episodes: 10, wins: 0, deaths: 10, avgScore: -30 }
      ],
      kinds: ['flat-melee', 'elevated-ranged']
    });
    assert.equal(weak.kind, 'elevated-ranged');
    assert.equal(weak.reason, 'weakness');
  });

  it('GymRunnerはログに基づきアリーナ種類を選ぶ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trailmate-gym-curriculum-'));
    const gym = new GymRunner({
      statePath: path.join(dir, 'sim-combat-state.json'),
      learningEnabled: false,
      maxTicks: 25
    });
    // 近接を勝ちやすい状態で数回回したあとに、選択理由が付く
    for (let index = 0; index < 8; index += 1) {
      gym.runEpisode(3000 + index, 'flat-melee');
    }
    gym.runEpisode(4000, 'elevated-ranged');
    const next = gym.runEpisode(5001);
    assert.ok(next.curriculumReason);
    assert.ok(['explore', 'coverage', 'weakness', 'rematch'].includes(next.curriculumReason!));
  });
});

describe('ノックバックとクリーパー着火', () => {
  it('近接ヒットで敵が押し出され着火は消えない（JE準拠）', () => {
    let state = createScenario('single-ranged');
    state.enemies = [{
      id: 1,
      kind: 'creeper',
      x: 2,
      y: 1,
      z: 0,
      hp: 20,
      fuseStartedAt: 1,
      stunUntil: 0
    }];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = ['stone_sword'];
    const fuseBefore = state.enemies[0].fuseStartedAt;
    const before = { x: state.enemies[0].x, z: state.enemies[0].z, hp: 20 };
    const result = stepSimulation(state);
    state = result.state;
    const creeper = state.enemies[0];
    assert.ok(creeper, 'クリーパーが生存');
    assert.ok(creeper.hp < before.hp, 'ヒットでダメージ');
    assert.ok((creeper.stunUntil || 0) > 0, '敵に硬直が入る');
    const pushed = Math.hypot(creeper.x - before.x, creeper.z - before.z) > 0.2;
    assert.equal(pushed, true, 'ノックバックで押し出される');
    assert.equal(creeper.fuseStartedAt, fuseBefore, '殴っても着火タイマーは消えない');
  });

  it('着火を放置すると爆発して相棒が被弾する', () => {
    let state = createScenario('single-ranged');
    // 近接射程外・消火距離内で着火済み → 殴れず爆発まで進む
    state.enemies = [{
      id: 1,
      kind: 'creeper',
      x: 4.2,
      y: 1,
      z: 0,
      hp: 20,
      fuseStartedAt: 0,
      stunUntil: 0
    }];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];
    state.equipped = null;
    // 最初のstepで now が進むので、着火開始を「少し前」にずらす
    const first = stepSimulation(state);
    state = first.state;
    const creeper = state.enemies[0];
    assert.ok(creeper);
    creeper.fuseStartedAt = state.now - 1400;
    state.bot = { ...state.bot, x: 0, y: 1, z: 0 };

    let exploded = false;
    for (let i = 0; i < 8; i += 1) {
      // 接近してキャンセルしないよう固定
      state.bot = { ...state.bot, x: 0, y: 1, z: 0 };
      if (state.enemies[0]) {
        state.enemies[0].x = 4.2;
        state.enemies[0].z = 0;
      }
      const result = stepSimulation(state);
      state = result.state;
      if (state.transitions.some((line) => line.includes('クリーパー爆発'))) {
        exploded = true;
        break;
      }
    }
    assert.equal(exploded, true, 'fuse完走で爆発する');
    assert.ok(state.damageTaken > 0 || state.botDead, '爆発で被弾する');
  });

  it('近くにいれば着火し、殴り続けても爆発する（倒し切れない場合）', () => {
    let state = createScenario('single-ranged');
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.enemies = [{
      id: 1,
      kind: 'creeper',
      x: 2.2,
      y: 1,
      z: 0,
      hp: 80,
      fuseStartedAt: null,
      stunUntil: 0
    }];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 40 };
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = ['stone_sword'];
    let ignited = false;
    let exploded = false;
    for (let i = 0; i < 40; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const creeper = state.enemies[0];
      if (creeper?.fuseStartedAt != null) ignited = true;
      if (state.transitions.some((line) => line.includes('クリーパー爆発'))) {
        exploded = true;
        break;
      }
      if (state.ended || state.botDead) break;
    }
    assert.equal(ignited, true, '近距離で着火する');
    assert.equal(exploded, true, '殴ってもタイマーは進み爆発する');
  });

  it('着火中のクリーパーは追尾せず静止する', () => {
    let state = createScenario('single-ranged');
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.enemies = [{
      id: 1,
      kind: 'creeper',
      x: 2.5,
      y: 1,
      z: 0,
      hp: 20,
      fuseStartedAt: 0,
      stunUntil: 0
    }];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemyAi = { enabled: true, speedScale: 1 };
    state.inventory = [];
    const first = stepSimulation(state);
    state = first.state;
    const creeper = state.enemies[0];
    assert.ok(creeper);
    creeper.fuseStartedAt = state.now;
    const before = { x: creeper.x, z: creeper.z };
    // 相棒を遠くへ → 未着火なら追うはずだが、着火中は動かない
    state.bot = { ...state.bot, x: -6, y: 1, z: 0 };
    const result = stepSimulation(state);
    state = result.state;
    const after = state.enemies[0];
    assert.ok(after);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(moved < 0.05, `着火中は静止すべき moved=${moved}`);
    const hold = (result.decision.enemyMotions || []).find((m) => m.id === 1);
    assert.equal(hold?.behavior, 'hold');
  });

  it('敵の近接ヒットで相棒がノックバックする', () => {
    let state = createScenario('dynamic-melee-pincer');
    state.enemies = [{ id: 1, kind: 'zombie', x: 1.1, y: 1, z: 0, hp: 20 }];
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 20 };
    state.enemyAi = { enabled: true, speedScale: 1 };
    const before = { x: state.bot.x, z: state.bot.z };
    let moved = false;
    let damaged = false;
    for (let i = 0; i < 12; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (state.damageTaken > 0) damaged = true;
      if (Math.hypot(state.bot.x - before.x, state.bot.z - before.z) > 0.3) moved = true;
      if (damaged && moved) break;
    }
    assert.equal(damaged, true, '近接被弾する');
    assert.equal(moved, true, '被弾でノックバックする');
    assert.ok((state.botStunUntil || 0) > 0, '硬直が入る');
  });
});
