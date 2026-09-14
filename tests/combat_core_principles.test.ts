/**
 * 戦闘コア原則の破壊検知テスト。
 * 落ちたら「学習チューニングが大原則を上書きした」可能性が高い。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMBAT_CORE_PRINCIPLES } from '../src/combat/CombatCorePrinciples.js';
import {
  decideCombatIntent,
  decideCombatMoveKind,
  decideRangedDodgeBurst,
  idleRangedDodgeLatch
} from '../src/combat/CombatIntent.js';
import { createScenario, stepSimulation } from '../src/simulator/SimulationCore.js';

describe('戦闘コア原則（上書き禁止）', () => {
  it('原則カタログが揃っている', () => {
    assert.equal(COMBAT_CORE_PRINCIPLES.threatArcNarrowing.id, 'threat-arc-narrowing');
    assert.equal(COMBAT_CORE_PRINCIPLES.rangedWithoutShield.id, 'ranged-without-shield');
    assert.equal(COMBAT_CORE_PRINCIPLES.rangedWithShield.id, 'ranged-with-shield');
  });

  it('CORE: 複数脅威の扇補正は接触以外で位置取りを選ぶ', () => {
    const intent = decideCombatIntent({
      distanceToPrimary: 3,
      meleeAttackRange: 3.5,
      rangedThreatCount: 0,
      hasShield: false,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(decideCombatMoveKind({
      intent,
      dodgePhase: 'advance',
      canMeleeAttack: true,
      multiThreatReposition: true,
      meleeContactInterrupt: false
    }), 'positioning');
  });

  it('CORE: 盾なし遠距離は回避意図、盾ありは防御意図', () => {
    const noShield = decideCombatIntent({
      distanceToPrimary: 8,
      meleeAttackRange: 3.5,
      rangedThreatCount: 1,
      hasShield: false,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(noShield.priority, 'dodge');
    const withShield = decideCombatIntent({
      distanceToPrimary: 8,
      meleeAttackRange: 3.5,
      rangedThreatCount: 1,
      hasShield: true,
      guardRangedThreatThreshold: 1,
      explosiveImmediateDanger: false
    });
    assert.equal(withShield.priority, 'guard');
  });

  it('CORE: 盾なし前進中の被弾は再回避する', () => {
    const started = decideRangedDodgeBurst({
      now: 1000,
      underRangedPressure: true,
      distanceToPrimary: 8,
      meleeAttackRange: 3.5,
      latch: idleRangedDodgeLatch(),
      burstMs: 400,
      advanceMs: 1500
    });
    const advancing = decideRangedDodgeBurst({
      now: started.latch.burstUntil,
      underRangedPressure: true,
      distanceToPrimary: 7,
      meleeAttackRange: 3.5,
      latch: started.latch,
      hasShield: false
    });
    assert.equal(advancing.phase, 'advance');
    const hit = decideRangedDodgeBurst({
      now: advancing.latch.advanceUntil - 100,
      underRangedPressure: true,
      distanceToPrimary: 6.5,
      meleeAttackRange: 3.5,
      latch: advancing.latch,
      lastDamageAt: advancing.latch.advanceUntil - 50,
      hasShield: false
    });
    assert.equal(hit.phase, 'dodge');
  });

  it('CORE: multi-positioning シナリオで位置取り移動が出る', () => {
    let state = createScenario('multi-positioning');
    let sawPositioning = false;
    for (let tick = 0; tick < 20; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (result.decision.movement === 'positioning') {
        sawPositioning = true;
        break;
      }
    }
    assert.ok(sawPositioning, '扇補正の位置取りが喪失していないこと');
  });

  it('CORE: 遠距離露出中は扇が広い間に攻撃へ切り替えて狭窄を打ち切らない', () => {
    let state = createScenario('dynamic-mixed');
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 40 };
    state.enemies = [
      { id: 1, kind: 'zombie', x: 2.5, y: 1, z: 0, hp: 40 },
      { id: 2, kind: 'skeleton', x: -8, y: 1, z: 0, hp: 20 }
    ];
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];
    let sawWideAttack = false;
    let minSpanDuringPositioning = 999;
    for (let tick = 0; tick < 36; tick += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const span = result.decision.spanDeg;
      if (result.decision.movement === 'positioning' && span != null) {
        minSpanDuringPositioning = Math.min(minSpanDuringPositioning, span);
      }
      if (result.decision.movement === 'attack' && span != null && span > 90) {
        sawWideAttack = true;
        break;
      }
      if (state.ended) break;
    }
    assert.equal(sawWideAttack, false, '遠距離露出中に扇が広いのに攻撃へ切り替わった');
    assert.ok(minSpanDuringPositioning < 180, '位置取り中に扇が評価されている');
  });

  it('CORE: 盾なし単体遠距離の初手は回避', () => {
    const state = createScenario('single-ranged');
    state.inventory = ['stone_sword'];
    const result = stepSimulation(state);
    assert.equal(result.decision.movement, 'dodge');
    assert.equal(result.decision.intent?.priority, 'dodge');
  });
});
