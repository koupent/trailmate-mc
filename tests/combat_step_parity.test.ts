/**
 * 箱庭と本番が同じ場面で同じ判断をすることを確かめる。
 * 判断（decideCombatStep）は共通なので、違いが出るとしたら観測の作り方
 * （箱庭: simCombatScene、本番: buildLiveCombatScene）。障害物のない平地で比べる。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { decideCombatStep } from '../src/combat/CombatStep.js';
import { getPresetParams } from '../src/combat/CombatProfiles.js';
import { createScenario, normalizeState, simCombatScene } from '../src/simulator/SimulationCore.js';
import { createBlockSet } from '../src/simulator/voxel.js';
import { buildLiveCombatScene } from '../src/reflexes/liveCombatScene.js';

type Enemy = { id: number; kind: string; x: number; z: number; ignited?: boolean };

const PARAMS = getPresetParams('explosive-wide');

function simStep(enemies: Enemy[]) {
  const state = normalizeState({
    ...createScenario('single-ranged'),
    inventory: [],
    enemies: enemies.map((enemy) => ({
      id: enemy.id,
      kind: enemy.kind,
      x: enemy.x,
      y: 1,
      z: enemy.z,
      hp: 20,
      fuseStartedAt: enemy.ignited ? 0 : null
    }))
  });
  const threats = state.enemies;
  return decideCombatStep(simCombatScene(state, createBlockSet(state.blocks), threats, PARAMS), {});
}

function liveStep(enemies: Enemy[]) {
  const entities = enemies.map((enemy) => {
    const metadata: unknown[] = [];
    if (enemy.ignited) metadata[16] = 1;
    return { id: enemy.id, name: enemy.kind, position: new Vec3(enemy.x, 64, enemy.z), metadata };
  });
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    health: 20,
    world: { raycast: () => null }
  };
  return decideCombatStep(buildLiveCombatScene({
    bot: bot as any,
    now: 0,
    tick: 0,
    tickMs: 250,
    threats: entities,
    owner: { x: -5, z: 0 },
    hasShield: false,
    lastDamageAt: 0,
    priorityThreatId: null,
    params: PARAMS
  }), {});
}

const SCENES: Array<[string, Enemy[]]> = [
  ['近接1体が届く', [{ id: 1, kind: 'zombie', x: 2, z: 0 }]],
  ['近接1体が遠い', [{ id: 1, kind: 'zombie', x: 6, z: 0 }]],
  ['遠距離1体', [{ id: 1, kind: 'skeleton', x: 6, z: 0 }]],
  ['近接2体に左右から挟まれる', [
    { id: 1, kind: 'zombie', x: -3, z: 0 },
    { id: 2, kind: 'zombie', x: 3, z: 0 }
  ]],
  ['近接と遠距離の混成', [
    { id: 1, kind: 'zombie', x: -4, z: 0 },
    { id: 2, kind: 'skeleton', x: 4, z: 0 }
  ]],
  ['遠距離2体に前後から挟まれる', [
    { id: 1, kind: 'skeleton', x: 0, z: 4 },
    { id: 2, kind: 'skeleton', x: 0, z: -4 }
  ]],
  ['届く着火クリーパー', [{ id: 1, kind: 'creeper', x: 2.5, z: 0, ignited: true }]],
  ['届かない着火クリーパー', [{ id: 1, kind: 'creeper', x: 3.8, z: 0, ignited: true }]]
];

describe('箱庭と本番の戦闘判断の一致', () => {
  for (const [name, enemies] of SCENES) {
    it(name, () => {
      const sim = simStep(enemies);
      const live = liveStep(enemies);
      assert.equal(live.primary?.id, sim.primary?.id, 'primary');
      assert.equal(live.movement, sim.movement, 'movement');
      assert.equal(live.mixedPlan?.phase, sim.mixedPlan?.phase, 'plan');
      assert.equal(live.strikeTarget?.id, sim.strikeTarget?.id, 'strike target');
      assert.equal(live.directFlee, sim.directFlee, 'direct flee');
      assert.equal(Boolean(live.destination), Boolean(sim.destination), 'has destination');
      if (live.destination && sim.destination) {
        const gap = Math.hypot(live.destination.x - sim.destination.x, live.destination.z - sim.destination.z);
        assert.ok(gap < 0.3, `destination differs by ${gap.toFixed(2)}m`);
      }
    });
  }
});
