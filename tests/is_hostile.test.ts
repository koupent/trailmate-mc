import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isHostile } from '../src/world/entities.js';

describe('isHostile', () => {
  it('敵対モブは攻撃対象', () => {
    assert.equal(isHostile({ name: 'zombie', type: 'hostile' }), true);
    assert.equal(isHostile({ name: 'slime', type: 'mob' }), true);
  });

  it('type mob に分類される友好モブは攻撃しない', () => {
    for (const name of ['iron_golem', 'snow_golem', 'allay', 'copper_golem']) {
      assert.equal(isHostile({ name, type: 'mob' }), false, name);
    }
  });

  it('サルファキューブは攻撃しない（ネイティブ名・ViaBackwards置換の両方）', () => {
    assert.equal(isHostile({ name: 'sulfur_cube', type: 'hostile' }), false);
    const mapped = { name: 'slime', type: 'mob', metadata: { 2: { translate: 'vb.entity.sulfur_cube', fallback: '26.2 Sulfur Cube' } } };
    assert.equal(isHostile(mapped), false);
    assert.equal(isHostile({ name: 'slime', type: 'mob', metadata: { 2: '{"text":"26.2 Sulfur Cube"}' } }), false);
  });
});
