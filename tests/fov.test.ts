import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInFov } from '../src/world/fov.js';

describe('isInFov', () => {
  it('detects targets in front of yaw 0 (-Z)', () => {
    assert.equal(isInFov({ x: 0, z: 0 }, 0, { x: 0, z: -5 }, 120), true);
    assert.equal(isInFov({ x: 0, z: 0 }, 0, { x: 0, z: 5 }, 120), false);
  });
});
