/**
 * 本番 adapter: 箱庭純粋ルールとの接続回帰。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideLiveCombatAction,
  decideLiveCombatIntent,
  entityToFocusThreat,
  pickLiveFocus,
  LIVE_FOCUS_STICKY_MS
} from '../src/reflexes/combatPlanAdapter.js';

describe('combatPlanAdapter', () => {
  it('entityToFocusThreat は位置と種別を写す', () => {
    const threat = entityToFocusThreat({
      id: 7,
      name: 'skeleton',
      health: 12,
      position: { x: 3, z: -1 }
    });
    assert.deepEqual(threat, {
      id: 7,
      x: 3,
      z: -1,
      kind: 'skeleton',
      hp: 12
    });
  });

  it('pickLiveFocus は sticky を僅差で維持する', () => {
    const now = 1000;
    const first = pickLiveFocus({
      bot: { x: 0, z: 0 },
      candidates: [
        { id: 1, name: 'zombie', health: 20, position: { x: 4, z: 0 } },
        { id: 2, name: 'skeleton', health: 20, position: { x: 5, z: 1 } }
      ],
      stickyId: null,
      now
    });
    assert.ok(first.primary);
    const stickyId = first.primary!.id;
    const held = pickLiveFocus({
      bot: { x: 0, z: 0 },
      candidates: [
        { id: 1, name: 'zombie', health: 20, position: { x: 4.2, z: 0.1 } },
        { id: 2, name: 'skeleton', health: 20, position: { x: 4.0, z: 0 } }
      ],
      stickyId,
      now: now + LIVE_FOCUS_STICKY_MS - 50
    });
    assert.equal(held.primary?.id, stickyId);
    assert.equal(held.switched, false);
  });

  it('危険扇圧の近接複数は narrow / positioning', () => {
    const intent = decideLiveCombatIntent({
      distanceToPrimary: 4,
      meleeAttackRange: 3.5,
      rangedThreatCount: 0,
      hasShield: false,
      explosiveImmediateDanger: false
    });
    const action = decideLiveCombatAction({
      enemyKinds: [
        { kind: 'zombie', hp: 20 },
        { kind: 'zombie', hp: 20 }
      ],
      spanDeg: 120,
      arcLatched: true,
      selectionMoved: true,
      rangedExposedCount: 0,
      meleeExposedCount: 2,
      canStrikeFocus: false,
      focusKind: 'zombie',
      explosiveImmediateDanger: false,
      hasMeleeBlocker: true,
      meleeContactInterrupt: false,
      dodgePhase: 'idle',
      intent,
      approachGoal: { x: 2, z: 2 }
    });
    assert.equal(action.dangerFanExposed, true);
    assert.equal(action.doNarrow, true);
    assert.ok(action.moveKind === 'positioning' || action.plan?.phase === 'narrow');
  });

  it('扇に晒されていない近接は狭窄しない', () => {
    const intent = decideLiveCombatIntent({
      distanceToPrimary: 2.5,
      meleeAttackRange: 3.5,
      rangedThreatCount: 0,
      hasShield: false,
      explosiveImmediateDanger: false
    });
    const action = decideLiveCombatAction({
      enemyKinds: [
        { kind: 'zombie', hp: 20 },
        { kind: 'zombie', hp: 20 }
      ],
      spanDeg: 80,
      arcLatched: false,
      selectionMoved: true,
      rangedExposedCount: 0,
      meleeExposedCount: 0,
      canStrikeFocus: true,
      focusKind: 'zombie',
      explosiveImmediateDanger: false,
      hasMeleeBlocker: true,
      meleeContactInterrupt: true,
      dodgePhase: 'idle',
      intent
    });
    assert.equal(action.dangerFanExposed, false);
    assert.equal(action.doNarrow, false);
    assert.equal(action.moveKind, 'attack');
  });
});
