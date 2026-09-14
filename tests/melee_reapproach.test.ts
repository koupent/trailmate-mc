/**
 * 純近接複数: ノックバックで間合いが空いても回り込みへ落ちず、近い敵へ詰め直す。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateArena } from '../src/simulator/ArenaGenerator.js';
import { stepSimulation } from '../src/simulator/SimulationCore.js';

describe('純近接の再接近（423回帰）', () => {
  it('2体近接で attack 後に positioning へ落ちない', () => {
    let state = generateArena(423, 'flat-melee');
    let sawAttack = false;
    let positioningAfterAttack = 0;
    let attacks = 0;
    for (let i = 0; i < 24; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      const move = result.decision.movement;
      if (move === 'attack') {
        sawAttack = true;
        attacks += 1;
      }
      if (sawAttack && move === 'positioning') {
        positioningAfterAttack += 1;
      }
      if (state.ended) break;
    }
    assert.ok(sawAttack, '攻撃が発生すること');
    assert.equal(
      positioningAfterAttack,
      0,
      `純近接で攻撃後に扇狭窄へ落ちた count=${positioningAfterAttack}`
    );
    assert.ok(attacks >= 4, `近い敵を殴り続けること attacks=${attacks}`);
  });
});
