/**
 * 近接2体で扇狭窄に膠着して殴れない退行を防ぐ。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScenario, stepSimulation } from '../src/simulator/SimulationCore.js';

describe('近接2体の接近・攻撃', () => {
  it('近い近接へ寄せて攻撃に入れる（回り込み膠着しない）', () => {
    let state = createScenario('dynamic-melee-pincer');
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 28 };
    state.enemies = [
      { id: 1, kind: 'zombie', x: 3.2, y: 1, z: 0.5, hp: 40 },
      { id: 2, kind: 'zombie', x: -5, y: 1, z: 2, hp: 40 }
    ];
    state.enemyAi = { enabled: true, speedScale: 1 };
    state.inventory = ['stone_sword'];

    let hits = 0;
    let attackMoves = 0;
    let minDistToNear = Infinity;
    for (let i = 0; i < 20; i += 1) {
      const nearBefore = state.enemies.find((e) => e.id === 1);
      const hpBefore = nearBefore?.hp ?? 0;
      const result = stepSimulation(state);
      state = result.state;
      const near = state.enemies.find((e) => e.id === 1);
      if (near) {
        minDistToNear = Math.min(
          minDistToNear,
          Math.hypot(state.bot.x - near.x, state.bot.z - near.z)
        );
        if (near.hp < hpBefore) hits += 1;
      }
      if (result.decision.movement === 'attack') attackMoves += 1;
      if (state.ended) break;
    }
    assert.ok(minDistToNear <= 3.5, `近い敵に寄せること dist=${minDistToNear}`);
    assert.ok(hits >= 3, `攻撃が入ること hits=${hits}`);
    assert.ok(attackMoves >= 1, `attack 位相に入れること moves=${attackMoves}`);
  });
});
