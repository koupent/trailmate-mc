import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeThreatArc, spanDegrees } from '../src/combat/threatArc.js';
import {
  createScenario,
  stepSimulation,
  type SimulationDecision,
  type SimulationState
} from '../src/simulator/SimulationCore.js';

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

  it('前後の敵列の片端より外側へ安全に移動し鋭角spanへ収束する', () => {
    let state = createScenario('multi-positioning');
    const before = computeThreatArc(state.bot, state.enemies)!;
    let reached = false;

    for (let tick = 0; tick < 30; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const arc = computeThreatArc(state.bot, state.enemies)!;
      const minEnemyDistance = Math.min(...state.enemies.map((enemy) => (
        Math.hypot(enemy.x - state.bot.x, enemy.z - state.bot.z)
      )));
      const ownerDistance = Math.hypot(state.bot.x - state.owner!.x, state.bot.z - state.owner!.z);
      assert.equal(result.decision.controlOwner, 'combat');
      assert.ok(minEnemyDistance >= 1.8 - 1e-6);
      assert.ok(ownerDistance <= 8 + 1e-6);
      if (spanDegrees(arc.spanRad) <= 35 && Math.abs(state.bot.z) > 4) {
        reached = true;
        assert.ok(result.decision.validation.every((check) => check.pass));
        break;
      }
    }

    assert.ok(reached, 'bot should move behind one enemy and aggregate both threat bearings');
    assert.ok(spanDegrees(computeThreatArc(state.bot, state.enemies)!.spanRad) < spanDegrees(before.spanRad));
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
    state.drops.push({ id: 77, item: 'dirt', x: 0.2, z: 0.2 });
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
      assert.ok(result.decision.enemyMotions.every((motion) => motion.behavior === 'chase' && motion.speed > 0));
      if (result.decision.spanDeg != null) spans.add(Number(result.decision.spanDeg.toFixed(3)));
      sawAcuteSpan ||= (result.decision.selectedSpanDeg ?? 180) <= 35;
      sawPositioning ||= result.decision.movement === 'positioning';
    }

    assert.ok(sawPositioning);
    assert.ok(sawAcuteSpan);
    assert.ok(spans.size > 1);
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
    let sawPositioningWithDodge = false;
    let sawStrafe = false;
    let sawAcuteDestination = false;
    let sawTwoPressure = false;

    for (let tick = 0; tick < 36; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      assert.equal(result.decision.controlOwner, 'combat');
      assert.ok(result.decision.rangedPressureCount >= 1);
      assert.equal(result.decision.intent?.priority, 'dodge');
      sawTwoPressure ||= result.decision.rangedPressureCount === 2;
      sawPositioningWithDodge ||= result.decision.movement === 'positioning';
      sawStrafe ||= result.decision.enemyMotions.some((motion) => motion.behavior === 'strafe');
      sawAcuteDestination ||= (result.decision.selectedSpanDeg ?? 180) <= 35;
    }

    assert.ok(sawPositioningWithDodge);
    assert.ok(sawTwoPressure);
    assert.ok(sawStrafe);
    assert.ok(sawAcuteDestination);
    assert.ok(state.shots >= 4);
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
      sawAcuteDestination ||= (result.decision.selectedSpanDeg ?? 180) <= 35;
      if (intents.has('dodge') && intents.has('attack')) break;
    }

    assert.ok(intents.has('dodge'));
    assert.ok(intents.has('attack'));
    assert.ok(movements.has('positioning'));
    assert.ok(sawAcuteDestination);
    assert.ok(spans.size > 1);
  });
});
