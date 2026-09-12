import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTag } from '../dashboard/update.mjs';

describe('update normalizeTag', () => {
  it('strips leading v and lowercases', () => {
    assert.equal(normalizeTag('v1.2.3'), '1.2.3');
    assert.equal(normalizeTag('V1.2.3'), '1.2.3');
    assert.equal(normalizeTag('1.2.3'), '1.2.3');
  });

  it('treats empty as empty', () => {
    assert.equal(normalizeTag(''), '');
    assert.equal(normalizeTag(null), '');
  });
});
