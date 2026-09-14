/**
 * 純近接複数: 扇内に寄ってきたら narrowing（位置取り）する。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAttackFanSafePoint } from '../src/combat/attackFanSafeZone.js';
import { isDangerFanPressure } from '../src/combat/MixedCombatPlan.js';
import { generateArena } from '../src/simulator/ArenaGenerator.js';
import { stepSimulation } from '../src/simulator/SimulationCore.js';

describe('純近接の扇狭窄', () => {
  it('近接2体が扇内なら meleeExposed>=2 で圧あり', () => {
    const bot = { x: 0, y: 1, z: 0 };
    const threats = [
      { id: 1, x: 2.2, y: 1, z: 1.2, kind: 'zombie' },
      { id: 2, x: -2.2, y: 1, z: 1.2, kind: 'zombie' }
    ];
    const safe = chooseAttackFanSafePoint(bot, threats);
    assert.ok((safe?.meleeExposedCount ?? 0) >= 2);
    assert.equal(
      isDangerFanPressure({
        rangedExposedCount: safe?.rangedExposedCount ?? 0,
        meleeExposedCount: safe?.meleeExposedCount ?? 0
      }),
      true
    );
  });

  it('1体だけ近いときは圧なし（一本集中）', () => {
    const bot = { x: 0, y: 1, z: 0 };
    const threats = [
      { id: 1, x: 2.0, y: 1, z: 0, kind: 'zombie' },
      { id: 2, x: 10, y: 1, z: 0, kind: 'zombie' }
    ];
    const safe = chooseAttackFanSafePoint(bot, threats);
    assert.ok((safe?.meleeExposedCount ?? 0) <= 1);
    assert.equal(
      isDangerFanPressure({
        rangedExposedCount: 0,
        meleeExposedCount: safe?.meleeExposedCount ?? 0
      }),
      false
    );
  });

  it('手元に近接2体がいれば positioning へ入る', () => {
    let state = generateArena(100, 'flat-melee');
    state.bot = { ...state.bot, x: 0, z: 0 };
    const template = state.enemies[0] || {
      id: 1,
      kind: 'zombie' as const,
      hp: 20,
      x: 0,
      y: state.bot.y,
      z: 0,
      yaw: 0
    };
    state.enemies = [
      { ...template, id: 101, kind: 'zombie', hp: 20, x: 2.2, y: state.bot.y, z: 1.3 },
      { ...template, id: 102, kind: 'zombie', hp: 20, x: -2.2, y: state.bot.y, z: 1.3 }
    ];
    const moves: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      moves.push(String(result.decision.movement));
      if (result.decision.movement === 'positioning') {
        assert.ok(true);
        return;
      }
      if (state.ended) break;
    }
    assert.fail(`近接複数の扇圧で位置取りすること moves=${moves.join(',')}`);
  });
});
