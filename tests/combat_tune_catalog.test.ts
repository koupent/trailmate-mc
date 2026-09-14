/**
 * 敵クラス別パラメータ探索の回帰。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_SIM_TUNABLE_KEYS,
  CLASS_TUNABLE_KEYS,
  tunableKeysForClass
} from '../src/combat/CombatTuneCatalog.js';
import {
  buildTuningDashboard,
  describeTuningStatus,
  mutateParamOverlayDetailed
} from '../src/combat/ParamTuner.js';
import { getPresetParams } from '../src/combat/CombatProfiles.js';
import { generateArena } from '../src/simulator/ArenaGenerator.js';
import { stepSimulation } from '../src/simulator/SimulationCore.js';

describe('CombatTuneCatalog / 敵クラス固有キー', () => {
  it('探索キーは遠距離2＋爆発1のみ', () => {
    assert.deepEqual([...ALL_SIM_TUNABLE_KEYS], [
      'rangedDodgeBurstMs',
      'rangedDodgeReassessMs',
      'creeperSoftEvadeRange'
    ]);
    assert.equal(CLASS_TUNABLE_KEYS.melee.length, 0);
    assert.equal(CLASS_TUNABLE_KEYS.agile.length, 0);
    assert.deepEqual([...CLASS_TUNABLE_KEYS.ranged], [
      'rangedDodgeBurstMs',
      'rangedDodgeReassessMs'
    ]);
    assert.deepEqual([...CLASS_TUNABLE_KEYS.explosive], ['creeperSoftEvadeRange']);
  });

  it('melee mutate は何も変えない', () => {
    const base = getPresetParams('melee-baseline');
    assert.equal(
      mutateParamOverlayDetailed(base, null, () => 0.1, 'melee').changedKeys.length,
      0
    );
  });

  it('ranged / explosive mutate は各クラスのキーのみ', () => {
    const rangedBase = getPresetParams('ranged-baseline');
    const explosiveBase = getPresetParams('explosive-baseline');
    const rangedAllowed = new Set(tunableKeysForClass('ranged'));
    const explosiveAllowed = new Set(tunableKeysForClass('explosive'));

    const ranged = mutateParamOverlayDetailed(rangedBase, null, () => 0.4, 'ranged');
    assert.ok(ranged.changedKeys.length >= 1);
    for (const key of ranged.changedKeys) assert.ok(rangedAllowed.has(key));

    const explosive = mutateParamOverlayDetailed(explosiveBase, null, () => 0.4, 'explosive');
    assert.ok(explosive.changedKeys.length >= 1);
    for (const key of explosive.changedKeys) assert.ok(explosiveAllowed.has(key));
  });

  it('dashboard は探索対象クラスだけ出し catalog は3', () => {
    const dashboard = buildTuningDashboard({
      aggregate: describeTuningStatus({
        paramExploreCount: 0,
        paramAdoptCount: 0,
        noImproveStreak: 0,
        bestScore: null
      }),
      contexts: {
        'melee|0': {
          selectedPresetId: 'melee-baseline',
          tunedParams: { followRange: 2.9, creeperSoftEvadeRange: 4 },
          tunedBestScore: 1,
          paramExploreCount: 3,
          paramAdoptCount: 0,
          noImproveStreak: 1
        },
        'ranged|0': {
          selectedPresetId: 'ranged-baseline',
          tunedParams: { rangedDodgeBurstMs: 700, followRange: 9 },
          tunedBestScore: 2,
          paramExploreCount: 5,
          paramAdoptCount: 1,
          noImproveStreak: 0
        },
        'explosive|0': {
          selectedPresetId: 'explosive-baseline',
          tunedParams: { creeperSoftEvadeRange: 4.1 },
          tunedBestScore: 3,
          paramExploreCount: 2,
          paramAdoptCount: 1,
          noImproveStreak: 0
        }
      }
    });
    assert.equal(dashboard.catalog.length, 3);
    assert.deepEqual(
      dashboard.byClass.map((g) => g.enemyClass),
      ['ranged', 'explosive']
    );
    assert.equal(dashboard.contexts.length, 2);
    assert.ok(dashboard.contexts.every((c) => c.params.length > 0));
    const ranged = dashboard.contexts.find((c) => c.enemyClass === 'ranged');
    assert.ok(ranged);
    assert.deepEqual(
      ranged.params.map((p) => p.key),
      ['rangedDodgeBurstMs', 'rangedDodgeReassessMs']
    );
    assert.equal(ranged.params.some((p) => p.key === 'followRange'), false);
  });
});

describe('敵クラス固有チューニング後の箱庭スモーク', () => {
  it('近接複数が数tick進む', () => {
    let state = generateArena(42, 'flat-melee');
    for (let i = 0; i < 10; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      assert.ok(result.decision.movement);
      if (state.ended) break;
    }
  });

  it('スケルトン接近戦が攻撃に到達する', () => {
    let state = generateArena(42, 'flat-melee');
    state.bot = { ...state.bot, x: 0, z: 0, hp: 20, y: 1 };
    const t = state.enemies[0];
    state.enemies = [{
      ...t,
      id: 9,
      kind: 'skeleton',
      hp: 20,
      x: 2.4,
      y: 1,
      z: 0.2
    }];
    state.enemyAiEnabled = false;
    let attacks = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (result.decision.movement === 'attack') attacks += 1;
      if (state.ended) break;
    }
    assert.ok(attacks >= 1, `attacks=${attacks}`);
  });

  it('クリーパー単体で退避または接近する', () => {
    let state = generateArena(42, 'flat-melee');
    state.bot = { ...state.bot, x: 0, z: 0, hp: 20, y: 1 };
    const t = state.enemies[0];
    state.enemies = [{
      ...t,
      id: 11,
      kind: 'creeper',
      hp: 20,
      x: 4,
      y: 1,
      z: 0,
      fuseStartedAt: null
    }];
    state.enemyAiEnabled = false;
    let saw = false;
    for (let i = 0; i < 10; i += 1) {
      const result = stepSimulation(state);
      state = result.state;
      if (['attack', 'advance', 'dodge', 'positioning'].includes(result.decision.movement || '')) {
        saw = true;
        break;
      }
    }
    assert.equal(saw, true);
  });
});
