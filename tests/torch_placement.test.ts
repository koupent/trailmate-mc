import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateBrightness,
  isTorchBlockName,
  nearestTorchDistance,
  torchScanRadius,
  TORCH_LIGHT_LEVEL
} from '../src/reflexes/torchPlacement.js';

function blockAtFrom(blocks: Record<string, string>) {
  return (x: number, y: number, z: number) => ({ name: blocks[`${x},${y},${z}`] ?? 'air' });
}

describe('torchPlacement', () => {
  it('recognizes torch blocks', () => {
    assert.equal(isTorchBlockName('torch'), true);
    assert.equal(isTorchBlockName('wall_torch'), true);
    assert.equal(isTorchBlockName('soul_torch'), false);
    assert.equal(isTorchBlockName('stone'), false);
    assert.equal(isTorchBlockName(undefined), false);
  });

  it('finds the closest torch in 3D, including across height changes', () => {
    const blockAt = blockAtFrom({
      '0,64,6': 'torch',
      '3,68,0': 'wall_torch'
    });

    const distance = nearestTorchDistance(blockAt, { x: 0.5, y: 64.2, z: 0.5 }, 7);
    assert.equal(distance, 5);
  });

  it('returns null when no torch is in range', () => {
    const blockAt = blockAtFrom({ '0,64,10': 'torch' });
    assert.equal(nearestTorchDistance(blockAt, { x: 0, y: 64, z: 0 }, 7), null);
  });

  it('estimates brightness from torch distance', () => {
    assert.equal(estimateBrightness({ skyLight: 0, isNight: true, torchDistance: 0 }), 14);
    assert.equal(estimateBrightness({ skyLight: 0, isNight: true, torchDistance: 6 }), 8);
    assert.equal(estimateBrightness({ skyLight: 0, isNight: true, torchDistance: null }), 0);
    assert.equal(estimateBrightness({ skyLight: 0, isNight: true, torchDistance: 20 }), 0);
  });

  it('counts sky light during the day but not at night', () => {
    assert.equal(estimateBrightness({ skyLight: 15, isNight: false, torchDistance: null }), 15);
    assert.equal(estimateBrightness({ skyLight: 15, isNight: true, torchDistance: null }), 0);
    assert.equal(estimateBrightness({ skyLight: null, isNight: false, torchDistance: null }), 0);
  });

  it('scans only as far as a torch can still matter', () => {
    assert.equal(torchScanRadius(7), TORCH_LIGHT_LEVEL - 7);
    assert.equal(torchScanRadius(0), TORCH_LIGHT_LEVEL);
    assert.equal(torchScanRadius(14), 1);
  });
});
