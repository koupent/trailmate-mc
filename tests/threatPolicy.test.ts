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
  selfImmediateRange: 6
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
  it('視野角に関係なくowner近傍の敵を護衛脅威とみなす', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(0, 64, 0),
      { name: 'zombie', type: 'hostile', position: pos(0, 64, 8) },
      RANGES
    );
    assert.equal(reason, 'owner-near');
  });

  it('Bot直近の敵を即時自己防衛脅威とみなす', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(20, 64, 0),
      { name: 'zombie', type: 'hostile', position: pos(2, 64, 0) },
      RANGES
    );
    assert.equal(reason, 'self-immediate');
  });

  it('ownerとBotの両方から遠い敵を無視する', () => {
    const reason = isProtectThreat(
      pos(0, 64, 0),
      pos(0, 64, 0),
      { name: 'skeleton', type: 'hostile', position: pos(0, 64, 14) },
      RANGES
    );
    assert.equal(reason, null);
  });

  it('遠い非脅威よりowner近傍の敵を選ぶ', () => {
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

  it('新規対象の選択には視線が必要', () => {
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

  it('owner被弾の攻撃者をowner近傍より優先する', () => {
    const ownerNear = {
      id: 1,
      name: 'skeleton',
      type: 'hostile',
      position: pos(5, 64, 0)
    };
    const ownerAttacker = {
      id: 2,
      name: 'zombie',
      type: 'hostile',
      position: pos(10, 64, 0)
    };
    const bot = {
      entity: { position: pos(0, 64, 0) },
      entities: { 1: ownerNear, 2: ownerAttacker }
    };
    const picked = pickProtectTarget(
      bot,
      pos(0, 64, 0),
      RANGES,
      () => true,
      { attackerId: 2, seenAt: Date.now() }
    );
    assert.equal(picked, ownerAttacker);
  });
});
