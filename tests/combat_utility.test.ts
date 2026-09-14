import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyEncounterSituation } from '../src/combat/EncounterSituation.js';
import {
  mergeUtilityWeights,
  mutateUtilityWeights,
  scoreUtilityCandidate,
  UTILITY_EQUATION
} from '../src/combat/CombatUtility.js';

describe('遭遇型と効用スコア', () => {
  it('敵構成から状況型を分ける', () => {
    assert.equal(
      classifyEncounterSituation([
        { kind: 'skeleton', hp: 20 },
        { kind: 'zombie', hp: 20 }
      ]).id,
      'mixed-ranged-melee'
    );
    assert.equal(
      classifyEncounterSituation([
        { kind: 'skeleton', hp: 20 },
        { kind: 'skeleton', hp: 20 }
      ]).id,
      'ranged-multi'
    );
    assert.equal(
      classifyEncounterSituation([
        { kind: 'zombie', hp: 20 },
        { kind: 'creeper', hp: 20 }
      ]).id,
      'explosive-mixed'
    );
  });

  it('方程式テキストと重み微調整がある', () => {
    assert.match(UTILITY_EQUATION, /wSpan/);
    const base = mergeUtilityWeights('mixed-ranged-melee', null);
    const mut = mutateUtilityWeights('mixed-ranged-melee', null, () => 0.2);
    assert.ok(mut.changedKeys.length >= 1);
    assert.ok(Number.isFinite(base.wSpan));
  });

  it('扇が狭い候補の方がスコアが高い', () => {
    const weights = mergeUtilityWeights('melee-crowd', null);
    const threats = [
      { x: -4, z: 0, kind: 'zombie' },
      { x: 4, z: 0, kind: 'zombie' }
    ];
    const wide = scoreUtilityCandidate({
      bot: { x: 0, z: 0 },
      candidate: { x: 0, z: 0 },
      threats,
      focus: threats[0],
      weights
    });
    const narrow = scoreUtilityCandidate({
      bot: { x: 0, z: 0 },
      candidate: { x: 0, z: 6 },
      threats,
      focus: threats[0],
      weights
    });
    assert.ok(narrow.score > wide.score, `narrow=${narrow.score} wide=${wide.score}`);
  });
});
