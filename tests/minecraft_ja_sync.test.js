import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { namesFromJaJp } from '../scripts/sync-minecraft-ja.mjs';
import { entityDisplayNameJa } from '../src/i18n/entityNames.ts';

describe('namesFromJaJp', () => {
  it('keeps item and entity ids and lets item names override blocks', () => {
    const { items, entities } = namesFromJaJp({
      'block.minecraft.torch': '松明ブロック',
      'item.minecraft.torch': '松明',
      'block.minecraft.stone': '石',
      'item.minecraft.diamond_sword': 'ダイヤモンドの剣',
      'item.minecraft.potion.effect.night_vision': '無視する',
      'entity.minecraft.zombie': 'ゾンビ',
      'entity.minecraft.Not Valid': '無視する'
    });
    assert.equal(items.torch, '松明');
    assert.equal(items.stone, '石');
    assert.equal(items.diamond_sword, 'ダイヤモンドの剣');
    assert.equal(items['potion.effect.night_vision'], undefined);
    assert.equal(entities.zombie, 'ゾンビ');
    assert.equal(entities['not valid'], undefined);
    assert.deepEqual(Object.keys(items), ['diamond_sword', 'stone', 'torch']);
  });
});

describe('entityDisplayNameJa', () => {
  it('uses the synced Japanese name and shows a raw id when missing', () => {
    assert.equal(entityDisplayNameJa('zombie'), 'ゾンビ');
    assert.equal(entityDisplayNameJa('minecraft:creeper'), 'クリーパー');
    assert.equal(entityDisplayNameJa('nope_mob'), 'minecraft:nope_mob');
    assert.equal(entityDisplayNameJa(''), '不明');
  });
});
