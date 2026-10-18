import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSchema } from '../src/settings/companionSettings.js';

describe('companion settings schema', () => {
  const fields = settingsSchema().flatMap((category) => category.sections.flatMap((section) => section.fields));

  it('すべての項目が既定の設定に存在し、既定値が範囲内にある', () => {
    for (const field of fields) {
      if (field.kind === 'bool') {
        assert.equal(typeof field.default, 'boolean', field.path);
        continue;
      }
      assert.equal(typeof field.default, 'number', field.path);
      const shown = (field.default as number) * (field.scale ?? 1);
      assert.ok(shown >= field.min! && shown <= field.max!, `${field.path}: ${shown}`);
    }
  });

  it('同じ項目を二度載せない', () => {
    const paths = fields.map((field) => field.path);
    assert.equal(new Set(paths).size, paths.length);
  });
});
