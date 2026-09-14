/**
 * 近接＋遠距離に挟まれたとき、扇が広い間は攻撃へ落とさず回り込み位置取りする。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScenario, stepSimulation } from '../src/simulator/SimulationCore.js';

describe('混成挟まれの扇狭窄', () => {
  it('180°挟まれでは扇が閉じるまで strike に落とさない', () => {
    let state = createScenario('dynamic-mixed');
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 28 };
    state.enemies = [
      { id: 1, kind: 'zombie', x: 2.5, y: 1, z: 0, hp: 40 },
      { id: 2, kind: 'skeleton', x: -8, y: 1, z: 0, hp: 20 }
    ];
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];

    let sawNarrow = false;
    let wideStrike = false;
    let maxAbsZWhileNarrow = 0;
    let rangedPrimaryWhileWide = 0;
    for (let i = 0; i < 18; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const span = result.decision.spanDeg;
      const move = result.decision.movement;
      if (move === 'positioning' && span != null && span > 60) {
        sawNarrow = true;
        maxAbsZWhileNarrow = Math.max(maxAbsZWhileNarrow, Math.abs(state.bot.z));
        if (result.decision.primaryId === 2) rangedPrimaryWhileWide += 1;
      }
      if (move === 'attack' && span != null && span > 90) {
        wideStrike = true;
        break;
      }
      if (state.ended) break;
    }
    assert.equal(wideStrike, false, '扇が広いのに一直線攻撃へ落ちた');
    assert.ok(sawNarrow, '扇狭窄の位置取りが出ること');
    assert.ok(maxAbsZWhileNarrow > 0.4, '射線上の突進ではなく回り込みがあること');
    assert.ok(rangedPrimaryWhileWide <= 2, '狭窄中に遠距離を主対象へ吸い寄せない');
  });
});
