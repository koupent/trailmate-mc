import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideMixedCombatPlan,
  isDangerFanPressure
} from '../src/combat/MixedCombatPlan.js';
import { classifyEncounterSituation } from '../src/combat/EncounterSituation.js';

const mixedSit = classifyEncounterSituation([
  { kind: 'zombie', hp: 20 },
  { kind: 'skeleton', hp: 20 }
]);

const meleeCrowdSit = classifyEncounterSituation([
  { kind: 'zombie', hp: 20 },
  { kind: 'zombie', hp: 20 }
]);

const explosiveSit = classifyEncounterSituation([
  { kind: 'creeper', hp: 20 },
  { kind: 'skeleton', hp: 20 },
  { kind: 'zombie', hp: 20 }
]);

const base = {
  explosiveImmediateDanger: false,
  focusIsExplosive: false,
  holdingCover: false,
  hasMeleeBlocker: true,
  meleeContactInterrupt: false,
  umbraGoal: null as { x: number; z: number } | null,
  skirtGoal: null as { x: number; z: number } | null,
  approachGoal: null as { x: number; z: number } | null
};

describe('MixedCombatPlan 位相（原則駆動）', () => {
  it('着火して殴れないときだけ evade', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: explosiveSit,
      spanDeg: 40,
      arcLatched: false,
      selectionMoved: false,
      explosiveImmediateDanger: true,
      canStrikeFocus: false,
      focusIsExplosive: true,
      rangedExposed: true,
      dangerFanExposed: true,
      hasRanged: true,
      dodgePhase: 'dodge',
      skirtGoal: { x: 2, z: 2 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'evade-creeper');
  });

  it('遠距離露出中は届いても narrow（歩き殴り）', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: mixedSit,
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: true,
      rangedExposed: true,
      dangerFanExposed: true,
      hasMeleeBlocker: true,
      hasRanged: true,
      dodgePhase: 'dodge',
      umbraGoal: { x: 0, z: 2.5 },
      skirtGoal: { x: 4, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'narrow');
    assert.equal(plan!.strikeWhileMoving, true);
  });

  it('純近接で扇圧がなければ届いていれば strike', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: meleeCrowdSit,
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: true,
      rangedExposed: false,
      dangerFanExposed: false,
      hasRanged: false,
      dodgePhase: 'advance',
      approachGoal: { x: 1, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'strike');
    assert.equal(plan!.moveKind, 'attack');
  });

  it('純近接で複数が扇内なら narrow（歩き殴り可）', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: meleeCrowdSit,
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: true,
      rangedExposed: false,
      dangerFanExposed: true,
      hasRanged: false,
      dodgePhase: 'advance',
      approachGoal: { x: 1, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'narrow');
    assert.equal(plan!.strikeWhileMoving, true);
  });

  it('純近接で扇圧がなければ届かなくても接近（ノックバック後のヒット&アウェイ防止）', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: meleeCrowdSit,
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: false,
      rangedExposed: false,
      dangerFanExposed: false,
      hasRanged: false,
      dodgePhase: 'advance',
      approachGoal: { x: 2, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'strike');
    assert.equal(plan!.moveKind, 'advance');
    assert.deepEqual(plan!.goal, { x: 2, z: 0 });
  });

  it('遠距離露出中で届かなければ narrow', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: mixedSit,
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: false,
      rangedExposed: true,
      dangerFanExposed: true,
      hasRanged: true,
      dodgePhase: 'dodge',
      umbraGoal: { x: 0, z: 2.5 },
      skirtGoal: { x: 4, z: 0 },
      approachGoal: { x: 2, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'narrow');
  });

  it('肉壁中は finish-cover', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: mixedSit,
      spanDeg: 40,
      arcLatched: false,
      selectionMoved: false,
      canStrikeFocus: false,
      holdingCover: true,
      rangedExposed: false,
      dangerFanExposed: false,
      hasRanged: true,
      dodgePhase: 'advance',
      umbraGoal: { x: 0, z: 2.5 },
      skirtGoal: { x: 3, z: 1 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'finish-cover');
  });

  it('露出中は seek-cover で umbra へ', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: mixedSit,
      spanDeg: 30,
      arcLatched: false,
      selectionMoved: false,
      canStrikeFocus: false,
      rangedExposed: true,
      dangerFanExposed: true,
      hasRanged: true,
      dodgePhase: 'dodge',
      umbraGoal: { x: 0, z: 2.5 },
      skirtGoal: { x: 4, z: 0 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'seek-cover');
  });

  it('届く爆発主対象は strike', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: explosiveSit,
      spanDeg: 80,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: true,
      focusIsExplosive: true,
      rangedExposed: true,
      dangerFanExposed: true,
      hasRanged: true,
      dodgePhase: 'dodge',
      umbraGoal: { x: 0, z: 2 },
      skirtGoal: { x: 3, z: 1 },
      approachGoal: { x: 1, z: 1 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'strike');
    assert.equal(plan!.moveKind, 'attack');
  });

  it('クリーパー主対象の接近中は narrow より接近を優先', () => {
    const plan = decideMixedCombatPlan({
      ...base,
      situation: explosiveSit,
      spanDeg: 100,
      arcLatched: true,
      selectionMoved: true,
      canStrikeFocus: false,
      focusIsExplosive: true,
      rangedExposed: true,
      dangerFanExposed: true,
      hasRanged: true,
      dodgePhase: 'advance',
      skirtGoal: { x: 4, z: 0 },
      approachGoal: { x: 1, z: 2 }
    });
    assert.ok(plan);
    assert.equal(plan!.phase, 'strike');
    assert.equal(plan!.moveKind, 'advance');
  });

  it('isDangerFanPressure: 近接は2体以上、遠距離は1体で圧', () => {
    assert.equal(isDangerFanPressure({ rangedExposedCount: 0, meleeExposedCount: 1 }), false);
    assert.equal(isDangerFanPressure({ rangedExposedCount: 0, meleeExposedCount: 2 }), true);
    assert.equal(isDangerFanPressure({ rangedExposedCount: 1, meleeExposedCount: 0 }), true);
  });
});
