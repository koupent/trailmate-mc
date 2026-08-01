import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInFov } from '../src/world/fov.js';

describe('isInFov', () => {
  it('yaw 0（-Z）の正面にいる対象を検出する', () => {
    assert.equal(isInFov({ x: 0, z: 0 }, 0, { x: 0, z: -5 }, 120), true);
    assert.equal(isInFov({ x: 0, z: 0 }, 0, { x: 0, z: 5 }, 120), false);
  });
});
