import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseStackThreatPosition,
  pickStickyNearestThreatIndex,
  spanDegrees,
  updateArcNarrowLatchByImprovement
} from '../src/combat/threatArc.js';

describe('決定論の扇重ね位置取り', () => {
  it('挟撃の中央から扇が狭まる位置へ寄る', () => {
    const bot = { x: 0, z: 0 };
    const threats = [
      { x: -6, z: 0, kind: 'zombie' },
      { x: 6, z: 0, kind: 'zombie' }
    ];
    const selection = chooseStackThreatPosition(bot, threats, {
      minEnemyDistance: 1.8,
      minimumImprovement: (2 * Math.PI) / 180
    });
    assert.equal(selection.moved, true);
    assert.ok(selection.safePoint || selection.chosen.position, 'target required');
    assert.ok(
      selection.chosen.spanRad + 1e-6 < selection.current.spanRad,
      `span ${spanDegrees(selection.chosen.spanRad)} should be < ${spanDegrees(selection.current.spanRad)}`
    );
  });

  it('最寄り sticky はわずかな距離差では切り替わらない', () => {
    const threats = [
      { x: 2, z: 0 },
      { x: -2.2, z: 0 }
    ];
    const first = pickStickyNearestThreatIndex({ x: 0, z: 0 }, threats, null);
    assert.equal(first, 0);
    const kept = pickStickyNearestThreatIndex({ x: 0.3, z: 0 }, threats, 0);
    assert.equal(kept, 0);
  });

  it('改善できる間だけラッチし、局所最小で外す', () => {
    assert.equal(updateArcNarrowLatchByImprovement({
      latched: false,
      threatCount: 2,
      selectionMoved: true
    }), true);
    assert.equal(updateArcNarrowLatchByImprovement({
      latched: true,
      threatCount: 2,
      selectionMoved: false,
      pursuingGoal: true
    }), true);
    assert.equal(updateArcNarrowLatchByImprovement({
      latched: true,
      threatCount: 2,
      selectionMoved: false,
      pursuingGoal: false
    }), false);
  });
});
