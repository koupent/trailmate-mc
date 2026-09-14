/**
 * 混成フォーカス: 僅差・ノックバックでは主対象を切り替えない。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FOCUS_URGENCY_SWITCH_MARGIN,
  selectCommittedFocus,
  threatUrgency
} from '../src/combat/CombatFocus.js';

describe('selectCommittedFocus', () => {
  const bot = { x: 0, z: 0 };

  it('同距離付近の近接＋遠距離で sticky を維持する', () => {
    const melee = { id: 1, x: 5, z: 0, kind: 'zombie', hp: 20 };
    const ranged = { id: 2, x: 2.5, z: 4.33, kind: 'skeleton', hp: 20 }; // ~5m, ~120°
    const first = selectCommittedFocus({
      bot,
      threats: [melee, ranged],
      stickyId: null,
      now: 0,
      stickyMs: 900
    });
    assert.ok(first.primary);
    const committedId = first.primary!.id;

    // ノックバック相当: 主対象を少し遠ざける（僅差逆転）
    const afterKb = committedId === melee.id
      ? [{ ...melee, x: 6.1 }, ranged]
      : [melee, { ...ranged, x: 3.2, z: 5.2 }];
    const second = selectCommittedFocus({
      bot,
      threats: afterKb,
      stickyId: committedId,
      now: 1000,
      stickyMs: 900
    });
    assert.equal(second.primary!.id, committedId, '僅差では sticky 維持');
    assert.equal(second.switched, false);
  });

  it('urgency マージンを超えたら切り替える', () => {
    const sticky = { id: 1, x: 8, z: 0, kind: 'zombie', hp: 20 };
    const closer = { id: 2, x: 3, z: 0, kind: 'skeleton', hp: 20 };
    const stickyU = threatUrgency(bot, sticky);
    const closerU = threatUrgency(bot, closer);
    assert.ok(
      stickyU > closerU + FOCUS_URGENCY_SWITCH_MARGIN,
      'テスト前提: 明らかに近い方がある'
    );
    const result = selectCommittedFocus({
      bot,
      threats: [sticky, closer],
      stickyId: sticky.id,
      now: 0,
      stickyMs: 900
    });
    assert.equal(result.primary!.id, closer.id);
    assert.equal(result.switched, true);
  });

  it('着火クリーパーは sticky より優先する', () => {
    const sticky = { id: 1, x: 4, z: 0, kind: 'zombie', hp: 20 };
    const creeper = { id: 2, x: 6, z: 0, kind: 'creeper', hp: 20 };
    const result = selectCommittedFocus({
      bot,
      threats: [sticky, creeper],
      stickyId: sticky.id,
      now: 0,
      stickyMs: 900,
      hardOverrideId: creeper.id
    });
    assert.equal(result.primary!.id, creeper.id);
  });

  it('sticky 死亡後は urgency 最小を選ぶ', () => {
    const remaining = { id: 2, x: 5, z: 0, kind: 'skeleton', hp: 20 };
    const result = selectCommittedFocus({
      bot,
      threats: [remaining],
      stickyId: 1,
      now: 0,
      stickyMs: 900
    });
    assert.equal(result.primary!.id, remaining.id);
    assert.equal(result.switched, true);
  });
});
