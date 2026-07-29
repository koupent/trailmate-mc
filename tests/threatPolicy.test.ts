import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_PROTECT_RANGE } from '../src/world/entities.js';
import {
  isProtectThreat,
  pickProtectTarget,
  type ProtectRanges
} from '../src/world/threatPolicy.js';

const RANGES: ProtectRanges = {
  botChaseRange: 12,
  ownerProtectRange: OWNER_PROTECT_RANGE,
  selfImmediateRange: 3.5
};

function pos(x: number, y: number, z: number) {
  return {
    x,
    y,
    z,
    distanceTo(other: { x: number; y: number; z: number }) {
      return Math.hypot(x - other.x, y - other.y, z - other.z);
    }
  };
}

describe('threatPolicy', () => {
  it('marks enemies near the owner as protect threats without FOV', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(0, 64, 0),
      { name: 'zombie', type: 'hostile', position: pos(0, 64, 6) },
      RANGES
    );
    assert.equal(reason, 'owner-near');
  });

  it('marks bot-adjacent enemies as self-immediate', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(20, 64, 0),
      { name: 'zombie', type: 'hostile', position: pos(2, 64, 0) },
      RANGES
    );
    assert.equal(reason, 'self-immediate');
  });

  it('ignores enemies far from both owner and bot', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(0, 64, 0),
      { name: 'skeleton', type: 'hostile', position: pos(0, 64, 10) },
      RANGES
    );
    assert.equal(reason, null);
  });

  it('picks the owner-near enemy over a farther non-threat', () => {
    const ownerNear = {
      id: 1,
      name: 'skeleton',
      type: 'hostile',
      position: pos(5, 64, 0)
    };
    const far = {
      id: 2,
      name: 'zombie',
      type: 'hostile',
      position: pos(11, 64, 0)
    };
    const bot = {
      entity: { position: pos(0, 64, 0) },
      entities: { 1: ownerNear, 2: far }
    };
    const picked = pickProtectTarget(bot, pos(6, 64, 0), RANGES, () => true);
    assert.equal(picked, ownerNear);
  });

  it('requires line of sight for new picks', () => {
    const enemy = {
      id: 1,
      name: 'zombie',
      type: 'hostile',
      position: pos(4, 64, 0)
    };
    const bot = {
      entity: { position: pos(0, 64, 0) },
      entities: { 1: enemy }
    };
    const picked = pickProtectTarget(bot, pos(1, 64, 0), RANGES, () => false);
    assert.equal(picked, null);
  });
});
