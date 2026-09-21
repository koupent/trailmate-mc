/**
 * 遠距離を殴っているとき、被弾なしで相棒が横跳びしないこと。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateArena } from '../src/simulator/ArenaGenerator.js';
import { stepSimulation } from '../src/simulator/SimulationCore.js';

describe('遠距離殴打中の偽ノックバック', () => {
  it('スケルトン殴打ティックで被弾なしの大きな横移動をしない', () => {
    let state = generateArena(42, 'flat-melee');
    state.bot = { ...state.bot, x: 0, z: 0, hp: 20, y: 1 };
    const template = state.enemies[0] || {
      id: 1,
      kind: 'skeleton' as const,
      hp: 20,
      x: 0,
      y: 1,
      z: 0,
      yaw: 0
    };
    state.enemies = [{
      ...template,
      id: 7,
      kind: 'skeleton',
      hp: 20,
      x: 2.4,
      y: 1,
      z: 0.2
    }];
    state.enemyAi.enabled = false;

    let attackTicks = 0;
    let maxAttackJump = 0;
    for (let i = 0; i < 12; i += 1) {
      const before = { x: state.bot.x, z: state.bot.z, hp: state.bot.hp };
      const result = stepSimulation(state);
      state = result.state;
      const jump = Math.hypot(state.bot.x - before.x, state.bot.z - before.z);
      const dmg = before.hp - state.bot.hp;
      if (result.decision.movement === 'attack') {
        attackTicks += 1;
        if (dmg <= 0) maxAttackJump = Math.max(maxAttackJump, jump);
      }
      if (state.ended) break;
    }
    assert.ok(attackTicks >= 1, '攻撃が発生すること');
    assert.ok(
      maxAttackJump < 0.2,
      `被弾なし攻撃中の横跳びが大きすぎる jump=${maxAttackJump.toFixed(3)}`
    );
  });
});
