import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isHostile } from '../src/world/entities.js';
import { buildMobCatalog, listUnsetEncounters, setMobHostility } from '../src/world/mobHostility.js';

const sulfurViaBackwards = {
  name: 'slime',
  type: 'mob',
  metadata: { 2: { translate: 'vb.entity.sulfur_cube', fallback: '26.2 Sulfur Cube' } }
};

describe('isHostile', () => {
  beforeEach(() => setMobHostility({}));

  it('敵対モブと既知の未分類の敵は攻撃する', () => {
    assert.equal(isHostile({ name: 'zombie', type: 'hostile' }), true);
    assert.equal(isHostile({ name: 'slime', type: 'mob' }), true);
  });

  it('type mob の友好モブ・動物・物体は攻撃しない', () => {
    for (const name of ['iron_golem', 'snow_golem', 'allay', 'copper_golem']) {
      assert.equal(isHostile({ name, type: 'mob' }), false, name);
    }
    assert.equal(isHostile({ name: 'cow', type: 'animal' }), false);
    assert.equal(isHostile({ name: 'text_display', type: 'other', metadata: { 2: '26.2 Fancy Sign' } }), false);
  });

  it('ViaBackwards で置き換わった新モブは未設定として攻撃せず、遭遇を記録する', () => {
    assert.equal(isHostile(sulfurViaBackwards), false);
    assert.equal(isHostile({ name: 'slime', type: 'mob', metadata: { 2: '{"text":"26.2 Sulfur Cube"}' } }), false);
    assert.deepEqual(
      listUnsetEncounters().find((mob) => mob.id === 'sulfur_cube'),
      { id: 'sulfur_cube', label: 'Sulfur Cube' }
    );
  });

  it('保存した設定が既定より優先される', () => {
    setMobHostility({ sulfur_cube: 'attack', zombie: 'ignore' });
    assert.equal(isHostile(sulfurViaBackwards), true);
    assert.equal(isHostile({ name: 'zombie', type: 'hostile' }), false);
    assert.equal(listUnsetEncounters().some((mob) => mob.id === 'sulfur_cube'), false);
  });

  it('一覧にはレジストリの敵対・未分類モブと遭遇した未設定モブが入る', () => {
    isHostile(sulfurViaBackwards);
    const catalog = buildMobCatalog({
      entitiesArray: [
        { name: 'zombie', type: 'hostile', displayName: 'Zombie' },
        { name: 'allay', type: 'mob', displayName: 'Allay' },
        { name: 'cow', type: 'animal', displayName: 'Cow' }
      ]
    });
    assert.deepEqual(catalog, [
      { id: 'zombie', label: 'Zombie', default: 'attack' },
      { id: 'allay', label: 'Allay', default: 'ignore' },
      { id: 'sulfur_cube', label: 'Sulfur Cube', default: null }
    ]);
  });
});
