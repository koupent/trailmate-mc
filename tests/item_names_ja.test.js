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

  it('keeps a bundled copy under src/i18n for volume-mounted locales', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const bundled = path.join(process.cwd(), 'src', 'i18n', 'items-ja.json');
    assert.equal(fs.existsSync(bundled), true);
  });
});
