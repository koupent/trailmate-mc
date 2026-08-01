import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
  applyCombatStepAssist,
  stepAheadAlongBearing
} from '../src/combat/combatStepAssist.js';

function makeBot(blocks: Record<string, string>) {
  const controls = new Map<string, boolean>();
  return {
    entity: {
      position: { x: 0.5, y: 64, z: 0.5 },
      yaw: 0,
      onGround: true
    },
    blockAt(pos: Vec3) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const name = blocks[key] ?? 'air';
      return name === 'air'
        ? { name, boundingBox: 'empty' }
        : { name, boundingBox: 'block' };
    },
    setControlState(name: string, state: boolean) {
      controls.set(name, state);
    },
    getControlState(name: string) {
      return controls.get(name) ?? false;
    }
  };
}

describe('combatStepAssist', () => {
  it('detects a one-block step ahead along bearing', () => {
    const bot = makeBot({
      '0,63,0': 'stone',
      '0,64,0': 'air',
      '1,64,0': 'stone',
      '1,65,0': 'air',
      '1,66,0': 'air'
    });
    const step = stepAheadAlongBearing(bot, Math.PI / 2);
    assert.ok(step);
    assert.equal(step?.rise, 1);
  });

  it('applies jump when a step is ahead', () => {
    const bot = makeBot({
      '0,63,0': 'stone',
      '0,64,0': 'air',
      '0,64,1': 'stone',
      '0,65,1': 'air',
      '0,66,1': 'air'
    });
    const applied = applyCombatStepAssist(bot, 0);
    assert.equal(applied, true);
    assert.equal(bot.getControlState('jump'), true);
  });

  it('does not jump when the path ahead is flat', () => {
    const bot = makeBot({
      '0,63,1': 'stone',
      '0,64,1': 'air',
      '0,65,1': 'air',
      '0,63,0': 'stone',
      '0,64,0': 'air',
      '0,65,0': 'air'
    });
    const applied = applyCombatStepAssist(bot, Math.PI / 2);
    assert.equal(applied, false);
    assert.equal(bot.getControlState('jump'), false);
  });
});
