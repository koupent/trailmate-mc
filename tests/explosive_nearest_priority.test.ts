/**
 * 爆発混成: 未着火クリーパーをすぐ殴りに行き、矢を浴びながら逃げ回らない。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScenario, stepSimulation } from '../src/simulator/SimulationCore.js';

describe('爆発混成の近い敵優先', () => {
  it('creeper+skeleton で未着火なら回避より攻撃/接近が勝つ', () => {
    let state = createScenario('dynamic-mixed');
    // 床だけの簡易配置: 近くにクリーパー、奥にスケルトン
    state.blocks = state.blocks.filter((b) => b.y === 0);
    state.bot = { ...state.bot, x: 0, y: 1, z: 0, hp: 24 };
    state.enemies = [
      { id: 1, kind: 'creeper', x: 2.2, y: 1, z: 0.4, hp: 20, fuseStartedAt: null },
      { id: 2, kind: 'skeleton', x: 0, y: 1, z: 9, hp: 20 }
    ];
    state.enemyAi = { enabled: false, speedScale: 1 };
    state.inventory = [];
    let attacksOnCreeper = 0;
    let fleeTicks = 0;
    for (let i = 0; i < 24; i += 1) {
      const before = state.enemies.find((e) => e.kind === 'creeper')?.hp ?? 0;
      const result = stepSimulation(state);
      state = result.state;
      const after = state.enemies.find((e) => e.kind === 'creeper')?.hp ?? 0;
      if (after < before) attacksOnCreeper += 1;
      if (result.decision.movement === 'dodge' && result.decision.phase?.id === 'evade-creeper') {
        fleeTicks += 1;
      }
      if (state.ended || after <= 0) break;
    }
    assert.ok(attacksOnCreeper >= 1, `expected creeper hits, got ${attacksOnCreeper}`);
    assert.ok(fleeTicks <= 2, `unignited should not spam flee, fleeTicks=${fleeTicks}`);
  });
});
