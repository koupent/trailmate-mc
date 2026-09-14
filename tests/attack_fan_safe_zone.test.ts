import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseAttackFanSafePoint,
  chooseRangedSkirtPoint,
  isPointExposedToEnemy,
  umbraAnchor
} from '../src/combat/attackFanSafeZone.js';
import { chooseStackThreatPosition } from '../src/combat/threatArc.js';

describe('攻撃扇ベースの安全地帯', () => {
  it('遠距離＋手前近接: 肉壁の影側は非露出、射線が通る点は露出', () => {
    const skeleton = { x: 0, y: 1, z: 10, kind: 'skeleton', id: 1 };
    const zombie = { x: 0, y: 1, z: 5, kind: 'zombie', id: 2 };
    const shadow = { x: 0, y: 1, z: 2 };
    const openFlank = { x: 4, y: 1, z: 2 };

    const behindMeat = isPointExposedToEnemy({
      enemy: skeleton,
      point: shadow,
      others: [zombie]
    });
    assert.equal(behindMeat.exposed, false);
    assert.equal(behindMeat.blocked, true);
    assert.ok(behindMeat.coverPoint, 'meat wall should report cover');

    const clearLos = isPointExposedToEnemy({
      enemy: skeleton,
      point: openFlank,
      others: [zombie]
    });
    assert.equal(clearLos.exposed, true);
    assert.equal(clearLos.blocked, false);
  });

  it('壁越し: 地形遮蔽なら遠距離非露出', () => {
    const skeleton = { x: 0, y: 1, z: 8, kind: 'skeleton', id: 1 };
    const behindWall = { x: 0, y: 1, z: 1 };
    const hit = isPointExposedToEnemy({
      enemy: skeleton,
      point: behindWall,
      others: [],
      terrainBlocked: true
    });
    assert.equal(hit.exposed, false);
    assert.equal(hit.blocked, true);

    const open = isPointExposedToEnemy({
      enemy: skeleton,
      point: behindWall,
      others: [],
      terrainBlocked: false
    });
    assert.equal(open.exposed, true);
  });

  it('単体近接: 小扇の外へ不用意に逃げ続けない', () => {
    const bot = { x: 0, y: 1, z: 0 };
    const zombie = { x: 2.2, y: 1, z: 0, kind: 'zombie', id: 1 };
    const safe = chooseAttackFanSafePoint(bot, [zombie], {
      minEnemyDistance: 1.4
    });
    assert.ok(safe);
    assert.equal(safe!.rangedExposedCount, 0);
    assert.equal(safe!.moved, false);
    assert.ok(
      Math.hypot(safe!.safePoint.x - bot.x, safe!.safePoint.z - bot.z) < 0.1,
      'single melee stays put'
    );
  });

  it('肉壁の影にいるときは移動せず、安全点は影アンカー', () => {
    const bot = { x: 0, y: 1, z: 2 };
    const threats = [
      { x: 0, y: 1, z: 10, kind: 'skeleton', id: 1 },
      { x: 0, y: 1, z: 5, kind: 'zombie', id: 2 }
    ];
    const anchor = umbraAnchor(threats[0], threats[1], 1.55);
    const safe = chooseAttackFanSafePoint(bot, threats);
    assert.ok(safe);
    assert.equal(safe!.rangedExposedCount, 0);
    assert.equal(safe!.moved, false);
    assert.equal(safe!.mode, 'umbra');
    assert.ok(
      Math.hypot(safe!.safePoint.x - anchor.x, safe!.safePoint.z - anchor.z) < 0.2,
      'safe marker stays on meat-wall umbra'
    );
  });

  it('露出中は影アンカーへ寄せ、stickyで飛び散らない', () => {
    const bot = { x: 4, y: 1, z: 2 };
    const skeleton = { x: 0, y: 1, z: 10, kind: 'skeleton', id: 1 };
    const zombie = { x: 0, y: 1, z: 5, kind: 'zombie', id: 2 };
    const threats = [skeleton, zombie];
    const anchor = umbraAnchor(skeleton, zombie, 1.55);
    const first = chooseAttackFanSafePoint(bot, threats);
    assert.ok(first);
    assert.equal(first!.rangedExposedCount > 0, true);
    assert.equal(first!.moved, true);
    assert.equal(first!.mode, 'umbra');
    assert.equal(
      isPointExposedToEnemy({
        enemy: skeleton,
        point: { ...first!.safePoint, y: 1 },
        others: [zombie]
      }).exposed,
      false
    );

    const second = chooseAttackFanSafePoint(bot, threats, {
      stickySafePoint: first!.safePoint
    });
    assert.ok(second);
    assert.ok(
      Math.hypot(
        second!.safePoint.x - first!.safePoint.x,
        second!.safePoint.z - first!.safePoint.z
      ) < 0.5,
      'sticky keeps same umbra'
    );
    assert.ok(
      Math.hypot(second!.safePoint.x - anchor.x, second!.safePoint.z - anchor.z) < 1.2
      || Math.hypot(first!.safePoint.x - anchor.x, first!.safePoint.z - anchor.z) < 1.2,
      'safe near umbra anchor'
    );
  });

  it('純遠距離: 斜め接近点で真正面を避ける', () => {
    const bot = { x: 0, y: 1, z: 0 };
    const skeleton = { x: 0, y: 1, z: 8, kind: 'skeleton', id: 1 };
    const safe = chooseAttackFanSafePoint(bot, [skeleton], {
      skirtSide: 1,
      skirtMode: 'advance'
    });
    assert.ok(safe);
    assert.equal(safe!.mode, 'skirt');
    assert.equal(safe!.moved, true);
    const toEnemy = Math.atan2(skeleton.x - bot.x, skeleton.z - bot.z);
    const toSafe = Math.atan2(safe!.safePoint.x - bot.x, safe!.safePoint.z - bot.z);
    let delta = Math.abs(toSafe - toEnemy);
    while (delta > Math.PI) delta = Math.abs(delta - Math.PI * 2);
    assert.ok(delta > 0.25, `skirt must not be head-on (delta=${delta})`);
  });

  it('chooseStackThreatPosition は単体遠距離でも接近点を返す', () => {
    const bot = { x: 0, y: 1, z: 0 };
    const threats = [{ x: 7, y: 1, z: 0, kind: 'skeleton', id: 1 }];
    const selection = chooseStackThreatPosition(bot, threats, {
      skirtSide: -1,
      skirtMode: 'dodge'
    });
    assert.ok(selection.safePoint);
    assert.equal(selection.moved, true);
    assert.ok(selection.rangedExposedCount > 0);
  });

  it('chooseStackThreatPosition は遠距離非露出なら動かない', () => {
    const bot = { x: 0, y: 1, z: 2 };
    const threats = [
      { x: 0, y: 1, z: 10, kind: 'skeleton', id: 1 },
      { x: 0, y: 1, z: 5, kind: 'zombie', id: 2 }
    ];
    const selection = chooseStackThreatPosition(bot, threats, {
      minEnemyDistance: 1.6,
      minimumImprovement: (2 * Math.PI) / 180
    });
    assert.equal(selection.moved, false);
    assert.equal(selection.rangedExposedCount, 0);
  });

  it('skirt は dodge と advance で横成分の強さが違う', () => {
    const bot = { x: 0, z: 0 };
    const focus = { x: 0, z: 8 };
    const dodge = chooseRangedSkirtPoint(bot, focus, { side: 1, mode: 'dodge' });
    const advance = chooseRangedSkirtPoint(bot, focus, { side: 1, mode: 'advance' });
    assert.ok(Math.abs(dodge.x) > Math.abs(advance.x), 'dodge strafes harder');
    assert.ok(advance.z > dodge.z, 'advance closes more');
  });
});
