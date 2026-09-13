import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { itemDisplayNameJa } from '../src/i18n/itemNames.ts';

describe('itemDisplayNameJa', () => {
  it('maps common registry names to Japanese', () => {
    assert.equal(itemDisplayNameJa('torch'), '松明');
    assert.equal(itemDisplayNameJa('cooked_mutton'), '焼き羊肉');
    assert.equal(itemDisplayNameJa('diamond_sword'), 'ダイヤモンドの剣');
  });

  it('falls back to registry name when unknown', () => {
    assert.equal(itemDisplayNameJa('totally_not_a_real_item_zz'), 'totally_not_a_real_item_zz');
  });
});
