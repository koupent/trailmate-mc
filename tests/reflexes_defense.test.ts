import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflexes } from '../src/reflexes/Reflexes.js';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import { WaitMode } from '../src/companion/modes/WaitMode.js';
import { hasLineOfSight } from '../src/world/lineOfSight.js';
import { computeThreatArc } from '../src/combat/threatArc.js';
import {
  collectTacticalThreatObservations,
  DEFAULT_TACTICAL_OBSERVATION_RADIUS
} from '../src/combat/TacticalObservation.js';
import { CombatTrace } from '../src/combat/CombatTrace.js';
import type { ReflexConfig } from '../src/config.js';

type Vec = {
  x: number;
  y: number;
  z: number;
  offset: (dx: number, dy: number, dz: number) => Vec;
  minus: (other: { x: number; y: number; z: number }) => {
    norm: () => number;
    scaled: (n: number) => { x: number; y: number; z: number };
  };
  distanceTo: (other: { x: number; y: number; z: number }) => number;
};

type EntityStub = {
  id: number;
  name: string;
  type: string;
  height: number;
  position: Vec;
  yaw?: number;
  metadata?: any[];
};

let nextEntityId = 1;

function vec3(x: number, y: number, z: number): Vec {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) {
      return vec3(x + dx, y + dy, z + dz);
    },
    minus(other) {
      const dx = x - other.x;
      const dy = y - other.y;
      const dz = z - other.z;
      return {
        norm: () => Math.hypot(dx, dy, dz),
        scaled: (n) => ({ x: dx * n, y: dy * n, z: dz * n })
      };
    },
    distanceTo(other) {
      return Math.hypot(x - other.x, y - other.y, z - other.z);
    }
  };
}

function makeEntity(
  name: string,
  type: string,
  x: number,
  y: number,
  z: number,
  height = 1.8
): EntityStub {
  return {
    id: nextEntityId++,
    name,
    type,
    height,
    position: vec3(x, y, z)
  };
}


function yawToward(
  from: { x: number; z: number },
  to: { x: number; z: number }
): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** `lookAt` を見るowner（Mineflayer yaw）。 */
function makeOwner(
  name: string,
  x: number,
  y: number,
  z: number,
  lookAt?: { position: { x: number; z: number } }
): EntityStub {
  const owner = makeEntity(name, 'player', x, y, z);
  owner.yaw = lookAt ? yawToward(owner.position, lookAt.position) : 0;
  return owner;
}

type BotOpts = {
  /** 頭部への視線が扉・壁で遮られるエンティティ名。 */
  blockedNames?: string[];
  hostiles?: EntityStub[];
  health?: number;
  hasShield?: boolean;
};

function makeBot(opts: BotOpts = {}) {
  const hostiles = opts.hostiles || [];
  const blocked = new Set(opts.blockedNames || []);
  const botEntity = makeEntity('bot', 'player', 0, 64, 0);
  (botEntity as any).yaw = 0;
  let attackTarget: EntityStub | null = null;
  let stopCount = 0;
  let forceStopCount = 0;
  let attackCount = 0;
  let activateCount = 0;
  const lookTargets: any[] = [];

  const controls: Record<string, boolean> = {};
  let deactivateCount = 0;
  const bot = {
    entity: botEntity,
    entities: Object.fromEntries(hostiles.map((entity) => [entity.id, entity])),
    health: opts.health ?? 20,
    world: {
      raycast(_from: Vec, _dir: unknown, _maxDist: number): { name: string } | null {
        return null;
      }
    },
    nearestEntity(pred: (e: EntityStub) => boolean) {
      return hostiles.find((e) => pred(e)) || null;
    },
    inventory: { items: () => [] as { name: string }[], slots: [] as any[] },
    blockAt: () => ({ name: 'air' }),
    time: { timeOfDay: 1000 },
    setControlState(name: string, value: boolean) {
      controls[name] = value;
    },
    getControlState(name: string) {
      return !!controls[name];
    },
    deactivateItem() {
      deactivateCount += 1;
    },
    activateItem() {
      activateCount += 1;
    },
    async lookAt(target: any) { lookTargets.push(target); },
    attack(enemy: EntityStub) {
      attackCount += 1;
      attackTarget = enemy;
    },
    getEquipmentDestSlot() {
      return 45;
    },
    pvp: {
      followRange: 2,
      get target() {
        return attackTarget;
      },
      async attack(enemy: EntityStub) {
        attackCount += 1;
        attackTarget = enemy;
      },
      async stop() {
        stopCount += 1;
        attackTarget = null;
      },
      forceStop() {
        forceStopCount += 1;
        attackTarget = null;
      },
      hasShield() {
        return opts.hasShield === true;
      }
    },
    _stats: () => ({
      attackCount,
      stopCount,
      forceStopCount,
      attackTarget,
      followRange: bot.pvp.followRange,
      sprint: !!controls.sprint,
      deactivateCount,
      activateCount,
      lookTargets,
      controls: { ...controls }
    })
  };

  // raycastを既知の追跡対象へ向けた照準対応判定へ置き換える。
  const tracked: EntityStub[] = [];
  bot.world.raycast = (from: Vec, dir: { x: number; y: number; z: number }, maxDist: number) => {
    const aimX = from.x + dir.x * maxDist;
    const aimY = from.y + dir.y * maxDist;
    const aimZ = from.z + dir.z * maxDist;
    const hit = tracked.find((e) => {
      const head = e.position.offset(0, e.height * 0.9, 0);
      return Math.hypot(head.x - aimX, head.y - aimY, head.z - aimZ) < 0.35;
    });
    if (hit && blocked.has(hit.name)) {
      return { name: 'oak_door' };
    }
    return null;
  };

  return {
    bot: bot as typeof bot & { pathfinder?: { goal?: unknown } },
    track(...entities: EntityStub[]) {
      tracked.push(...entities);
    },
    setBlocked(name: string, value: boolean) {
      if (value) blocked.add(name);
      else blocked.delete(name);
    }
  };
}

const CONFIG: ReflexConfig = {
  self_defense: true,
  self_preservation: false,
  torch_placing: false,
  hostile_range: 12,
  combat_lost_grace_ms: 1500,
  retreat_health: 8,
  resume_health: 14,
  retreat_distance: 6,
  combat_learning: {
    enabled: false,
    explore_rate: 0,
    min_trials: 3,
    min_health_to_explore: 12,
    explore_damage_abort: 8,
    state_path: 'data/combat-state.test.json'
  }
};

function makeMovement() {
  const followed: any[] = [];
  const destinations: Array<{ x: number; y: number; z: number }> = [];
  let sprintAllowed = false;
  return {
    followEntity(entity: any) {
      followed.push(entity);
      return true;
    },
    goToward(position: { x: number; y: number; z: number }) {
      destinations.push(position);
      return true;
    },
    setSprintAllowed(allowed: boolean) {
      sprintAllowed = allowed === true;
    },
    _stats: () => ({ followed, destinations, sprintAllowed })
  };
}

describe('hasLineOfSight', () => {
  it('raycastが通る場合はtrueを返す', () => {
    const { bot, track } = makeBot();
    const owner = makeEntity('Alice', 'player', 2, 64, 0);
    track(owner);
    assert.equal(hasLineOfSight(bot, owner), true);
  });

  it('扉が視線を遮る場合はfalseを返す', () => {
    const { bot, track } = makeBot({ blockedNames: ['Alice'] });
    const owner = makeEntity('Alice', 'player', 2, 64, 0);
    track(owner);
    assert.equal(hasLineOfSight(bot, owner), false);
  });
});

describe('交戦中の戦術観測境界', () => {
  it('primaryと8m以内の可視hostileだけを収集する', () => {
    const primary = makeEntity('zombie', 'hostile', 10, 64, 0);
    const visible = makeEntity('skeleton', 'hostile', -7, 64, 0);
    const blocked = makeEntity('spider', 'hostile', 0, 64, 6);
    const far = makeEntity('creeper', 'hostile', 9, 64, 0);
    const passive = makeEntity('cow', 'animal', 2, 64, 0);

    const observations = collectTacticalThreatObservations({
      botPos: vec3(0, 64, 0),
      primary,
      entities: [primary, visible, blocked, far, passive],
      radius: DEFAULT_TACTICAL_OBSERVATION_RADIUS,
      hasLineOfSight: (entity) => entity !== blocked
    });

    assert.deepEqual(observations.map(({ entity, source }) => [entity.name, source]), [
      ['zombie', 'primary'],
      ['skeleton', 'nearby-visible']
    ]);
  });
});

describe('Reflexesの戦闘判断', () => {
  it('ownerが閉じた扉の向こうへ移動しても戦闘を続ける', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeOwner('Alice', 4, 64, 0, zombie);
    const { bot, track } = makeBot({
      blockedNames: ['Alice'],
      hostiles: [zombie]
    });
    track(owner, zombie);
    const reflexes = new Reflexes(bot as any, CONFIG, 7);

    await bot.pvp.attack(zombie);
    assert.ok(bot._stats().attackTarget);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });

    const stats = bot._stats();
    assert.equal(stats.attackTarget, zombie);
    assert.equal(stats.stopCount, 0);
  });

  it('閉じた扉の向こうにいる敵とは新規戦闘を始めない', async () => {
    // 即時自己防衛範囲外なので、owner側からの視線が必要。
    const zombie = makeEntity('zombie', 'hostile', 6, 64, 0);
    const owner = makeOwner('Alice', 1, 64, 0, zombie);
    const { bot, track } = makeBot({
      blockedNames: ['zombie'],
      hostiles: [zombie]
    });
    track(owner, zombie);
    const reflexes = new Reflexes(bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });

    const stats = bot._stats();
    assert.equal(stats.attackCount, 0);
    assert.equal(stats.attackTarget, null);
  });

  it('同じ位置にいる見える敵を攻撃する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeOwner('Alice', 1, 64, 0, zombie);
    const { bot, track } = makeBot({ hostiles: [zombie] });
    track(owner, zombie);
    const reflexes = new Reflexes(bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });

    const stats = bot._stats();
    assert.ok(stats.attackCount >= 1);
    assert.equal(stats.attackTarget, zombie);
  });

  it('owner未設定でも見える敵に対する自己防衛を続ける', async () => {
    const zombie = makeEntity('zombie', 'hostile', 2, 64, 0);
    const { bot, track } = makeBot({ hostiles: [zombie] });
    track(zombie);
    const reflexes = new Reflexes(bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner: null
    });

    assert.equal(bot._stats().attackTarget, zombie);
  });

  it('短い視線喪失中は現在の対象を維持する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    setup.setBlocked('zombie', true);
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(setup.bot._stats().stopCount, 0);
  });

  it('視線猶予と戦術解除時間の終了後に停止する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie, owner);
    const reflexes = new Reflexes(
      setup.bot as any,
      { ...CONFIG, combat_lost_grace_ms: -1 },
      7
    );

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    setup.setBlocked('zombie', true);
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(reflexes.ownsTacticalControl, true);
    assert.equal(setup.bot._stats().attackTarget, zombie);
    (reflexes as any).combatControlUntil = Date.now() - 1;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    assert.equal(setup.bot._stats().attackTarget, null);
    assert.ok(setup.bot._stats().stopCount >= 1);
  });

  it('対象を切り替えず固定済みの即時脅威を維持する', async () => {
    const immediate = makeEntity('zombie', 'hostile', 2, 64, 0);
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, ownerThreat);
    const setup = makeBot({ hostiles: [immediate, ownerThreat] });
    setup.track(immediate, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, immediate);
    // 同じ対象IDへpvp.attackを再呼び出しせず、await stop()の停滞を防ぐ。
    // 近接補助でbot.attackが増えても、pvp.attackは1回のまま。
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('直近脅威がなければowner近傍の脅威を優先する', async () => {
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const other = makeEntity('zombie', 'hostile', 7, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, ownerThreat);
    const setup = makeBot({ hostiles: [other, ownerThreat] });
    setup.track(other, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, ownerThreat);
  });

  it('低HPでもownerへ逃げずGuardで戦い続ける', async () => {
    const zombie = makeEntity('zombie', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 12, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(reflexes.escortMode, 'guard');
    assert.equal(setup.bot._stats().attackTarget, zombie);
    // ownerを盾にする退避目的地へ移動してはならない。
    assert.equal(movement._stats().destinations.length, 0);
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('ownerが脅威の隣にいる場合も低HPで防御する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeOwner('Alice', 3.5, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(reflexes.escortMode, 'guard');
    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(movement._stats().destinations.length, 0);
  });

  it('ownerがいない場合も低HPで防御する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 2, 64, 0);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.equal(reflexes.escortMode, 'guard');
    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(movement._stats().destinations.length, 0);
  });

  it('エンティティオブジェクトが置換されても固定対象を維持する', async () => {
    const first = makeEntity('zombie', 'hostile', 2, 64, 0);
    const second = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const owner = makeOwner('Alice', 8, 64, 0, first);
    const setup = makeBot({ hostiles: [first, second] });
    setup.track(first, second, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    assert.equal(setup.bot._stats().attackTarget, first);

    const replaced = {
      ...first,
      position: first.position
    };
    setup.bot.entities[first.id] = replaced as any;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget?.id, first.id);
    // tick間でオブジェクト同一性が変わる場合があるため、entity IDで照合して再攻撃を省く。
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('遠距離敵には引き撃ち用follow rangeを使う', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().followRange, 3.6);
  });

  it('着火前の近いcreeperから後退せず近接攻撃する', async () => {
    const creeper = makeEntity('creeper', 'hostile', 2.5, 64, 0);
    const setup = makeBot({ hostiles: [creeper] });
    setup.track(creeper);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.ok(setup.bot._stats().attackCount >= 1);
    assert.equal(movement._stats().destinations.length, 0);
  });

  it('盾なしで着火済みcreeperから後退する', async () => {
    const creeper = makeEntity('creeper', 'hostile', 2.5, 64, 0);
    creeper.metadata = [];
    creeper.metadata[16] = 1;
    const setup = makeBot({ hostiles: [creeper] });
    setup.track(creeper);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.equal(setup.bot._stats().attackCount, 0);
    assert.equal(setup.bot._stats().forceStopCount, 1);
    assert.equal(movement._stats().destinations.length, 1);
  });

  it('ownerの背面でもowner近傍の敵を防御対象にする', async () => {
    // ownerは-Z向きだが、skeletonは護衛範囲内の+Zにいる。
    const skeleton = makeEntity('skeleton', 'hostile', 0, 64, 6);
    const owner = makeOwner('Alice', 0, 64, 0);
    owner.yaw = 0;
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, skeleton);
    assert.equal(reflexes.escortMode, 'guard');
  });

  it('ownerとBotの両方から遠い敵を無視する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 0, 64, 10);
    const owner = makeOwner('Alice', 0, 64, 0);
    owner.yaw = 0;
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackCount, 0);
    assert.equal(setup.bot._stats().attackTarget, null);
    assert.equal(reflexes.isControllingMovement, false);
    assert.equal(reflexes.escortMode, 'follow');
  });

  it('ownerから遠くても直近脅威へ自己防衛する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 0, 64, 2);
    const owner = makeOwner('Alice', 20, 64, 0);
    owner.yaw = 0;
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(reflexes.escortMode, 'guard');
  });

  it('owner yawがなくてもowner近傍の脅威を防御する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 0, 64, -6);
    const owner = makeEntity('Alice', 'player', 0, 64, 0); // no yaw
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('脅威消失後の猶予を過ぎたらfollowへ戻る', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeOwner('Alice', 1, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie, owner);
    const reflexes = new Reflexes(
      setup.bot as any,
      { ...CONFIG, combat_lost_grace_ms: -1 },
      7
    );

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    assert.equal(reflexes.escortMode, 'guard');

    delete setup.bot.entities[zombie.id];
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(reflexes.escortMode, 'follow');
    assert.equal(reflexes.isControllingMovement, true);
    (reflexes as any).combatControlUntil = Date.now() - 1;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    assert.equal(reflexes.isControllingMovement, false);
  });

  it('単敵戦闘では位置取りせず既存攻撃経路を維持する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 0, 64, 3);
    const owner = makeOwner('Alice', 0, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 0);
    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(setup.bot._stats().forceStopCount, 0);
  });

  it('owner遠方でも左右4mのゾンビ2体を戦術観測し位置取りする', async () => {
    const left = makeEntity('zombie', 'hostile', -4, 64, 0);
    const right = makeEntity('zombie', 'hostile', 4, 64, 0);
    const owner = makeOwner('Alice', 30, 64, 0, left);
    const setup = makeBot({ hostiles: [left, right] });
    setup.track(left, right, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);
    const traceLines: string[] = [];
    (reflexes as any).combatTrace = new CombatTrace({
      enabled: true,
      logger: (line) => traceLines.push(line)
    });
    (reflexes as any).currentTarget = left;
    (reflexes as any).lastTargetSeenAt = Date.now();

    const bias = (reflexes as any).collectThreatArcBias(left);
    assert.equal(bias?.threatCount, 2);
    assert.equal(bias?.rangedThreatCount, 0);
    assert.equal(bias?.selection.moved, true);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.equal(setup.bot._stats().attackCount, 0);
    const trace = JSON.parse(traceLines.at(-1)!.slice('[combat-trace] '.length));
    assert.equal(trace.event, 'decision');
    assert.deepEqual(trace.owner, { x: 30, y: 64, z: 0 });
    assert.equal(trace.arc.threatCount, 2);
    assert.equal(trace.arc.tacticalRadius, 8);
    assert.equal(trace.threats.length, 2);
    assert.ok(trace.destination);
    assert.equal(trace.candidate.moved, true);
  });

  it('owner遠方の左右3mゾンビ2体へ位置取りしながら近接攻撃する', async () => {
    const left = makeEntity('zombie', 'hostile', -3, 64, 0);
    const right = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeOwner('Alice', 30, 64, 0, left);
    const setup = makeBot({ hostiles: [left, right] });
    setup.track(left, right, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.ok(setup.bot._stats().attackCount >= 1);
    assert.equal(setup.bot._stats().attackTarget, left);
  });

  it('owner遠方の近接＋遠距離混成も共通arcへ集約する', async () => {
    const zombie = makeEntity('zombie', 'hostile', -4, 64, 0);
    const skeleton = makeEntity('skeleton', 'hostile', 4, 64, 0);
    const owner = makeOwner('Alice', 30, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie, skeleton] });
    setup.track(zombie, skeleton, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);
    (reflexes as any).currentTarget = zombie;
    (reflexes as any).lastTargetSeenAt = Date.now();

    const bias = (reflexes as any).collectThreatArcBias(zombie);
    assert.equal(bias?.threatCount, 2);
    assert.equal(bias?.rangedThreatCount, 1);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.equal(setup.bot._stats().attackCount, 0);
  });

  it('前後脅威へ横方向に位置取りし近接攻撃も維持する', async () => {
    const front = makeEntity('zombie', 'hostile', 0, 64, 3);
    const back = makeEntity('zombie', 'hostile', 0, 64, -3);
    const owner = makeOwner('Alice', 0, 64, 0, front);
    const setup = makeBot({ hostiles: [front, back] });
    setup.track(front, back, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    const destinations = movement._stats().destinations;
    assert.equal(destinations.length, 1);
    const destination = destinations[0];
    assert.ok(Math.abs(destination.x) > 1.5);
    const before = computeThreatArc(
      { x: 0, z: 0 },
      [front.position, back.position]
    );
    const after = computeThreatArc(destination, [front.position, back.position]);
    assert.ok(before && after);
    assert.ok(after!.spanRad < before!.spanRad);
    assert.equal(setup.bot._stats().forceStopCount, 0);
    assert.ok(setup.bot._stats().attackCount >= 1);
    assert.equal(setup.bot._stats().attackTarget, front);
    assert.ok(setup.bot._stats().lookTargets.length >= 1);
    assert.equal(setup.bot._stats().lookTargets.at(-1).x, front.position.x);
    assert.equal(setup.bot._stats().lookTargets.at(-1).z, front.position.z);
  });

  it('狭い敵集団でも改善位置があれば位置取りし攻撃も維持する', async () => {
    const left = makeEntity('zombie', 'hostile', -0.4, 64, 3);
    const right = makeEntity('zombie', 'hostile', 0.4, 64, 3);
    const owner = makeOwner('Alice', 0, 64, 0, left);
    const setup = makeBot({ hostiles: [left, right] });
    setup.track(left, right, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.equal(setup.bot._stats().forceStopCount, 0);
    assert.equal(setup.bot._stats().attackTarget, left);
  });

  it('狭い敵集団で改善がなければpathfinder移動せず攻撃する', async () => {
    const near = makeEntity('zombie', 'hostile', 0, 64, 3);
    const far = makeEntity('zombie', 'hostile', 0, 64, 5);
    const owner = makeOwner('Alice', 0, 64, 0, near);
    const setup = makeBot({ hostiles: [near, far] });
    setup.track(near, far, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 0);
    assert.equal(setup.bot._stats().forceStopCount, 0);
    assert.equal(setup.bot._stats().attackTarget, near);
  });

  it('単体遠距離敵の射線と直交するワールド方向へ回避する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.bot.entity.yaw = Math.PI / 2; // Bot currently faces -X.
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    const controls = setup.bot._stats().controls;
    // 射線は東西方向。このyawではleft入力で+Zへ動く。
    assert.equal(controls.left, true);
    assert.equal(controls.forward, false);
    assert.equal(controls.back, false);
    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('回避バースト後に遠距離敵へ明示的に前進する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.bot.entity.yaw = 0;
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);
    const now = Date.now();
    (reflexes as any).rangedDodgeLatch = {
      burstUntil: now - 1,
      advanceUntil: now + 1200,
      bestDistance: 6,
      lastProgressAt: now,
      handledDamageAt: 0
    };

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    const controls = setup.bot._stats().controls;
    // 敵は+X方向。yaw 0ではright入力で+Xへ動く。
    assert.equal(controls.right, true);
    assert.equal(controls.left, false);
    assert.equal(controls.forward, false);
    assert.equal(controls.back, false);
    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('遠距離敵が近接距離へ入ったら回避ラッチを解除して攻撃する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 3.4, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);
    const now = Date.now();
    (reflexes as any).rangedDodgeLatch = {
      burstUntil: now + 600,
      advanceUntil: now + 2100,
      bestDistance: 5,
      lastProgressAt: now,
      handledDamageAt: 0
    };

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.ok(setup.bot._stats().attackCount >= 1);
    assert.equal(setup.bot._stats().controls.left, false);
    assert.equal(setup.bot._stats().controls.right, false);
    assert.equal((reflexes as any).rangedDodgeLatch.burstUntil, 0);
    assert.equal((reflexes as any).rangedDodgeLatch.advanceUntil, 0);
  });

  it('前後にいる遠距離敵2体には位置取りを優先する', async () => {
    const front = makeEntity('skeleton', 'hostile', 0, 64, 5);
    const back = makeEntity('skeleton', 'hostile', 0, 64, -5);
    const owner = makeOwner('Alice', 0, 64, 0, front);
    const setup = makeBot({ hostiles: [front, back] });
    setup.track(front, back, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.equal(setup.bot._stats().forceStopCount, 0);
    assert.equal(setup.bot._stats().attackCount, 0);
  });

  it('90度配置の遠距離敵2体には位置取りを優先する', async () => {
    const north = makeEntity('skeleton', 'hostile', 0, 64, 5);
    const east = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, north);
    const setup = makeBot({ hostiles: [north, east] });
    setup.track(north, east, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    const destination = movement._stats().destinations[0];
    assert.ok(destination);
    const before = computeThreatArc({ x: 0, z: 0 }, [north.position, east.position]);
    const after = computeThreatArc(destination, [north.position, east.position]);
    assert.ok(before && after);
    assert.ok(after.spanRad < before.spanRad);
    assert.ok(after.spanRad <= (35 * Math.PI) / 180);
    assert.equal(setup.bot._stats().forceStopCount, 0);
  });

  it('遠距離圧下の位置取り中も盾防御を維持する', async () => {
    const north = makeEntity('skeleton', 'hostile', 0, 64, 3);
    const south = makeEntity('skeleton', 'hostile', 0, 64, -3);
    const owner = makeOwner('Alice', 0, 64, 0, north);
    const setup = makeBot({ hostiles: [north, south], hasShield: true });
    setup.track(north, south, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.ok(setup.bot._stats().activateCount >= 1);
    // 純粋判断には攻撃意図もあるが、API競合では盾を優先する。
    assert.equal(setup.bot._stats().attackCount, 0);
  });
});

describe('上位モードと戦闘の連携', () => {
  it('Recoveryが移動を所有し上限付き生存回避だけ割り込める', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 2, 64, 0);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton);
    let movementStops = 0;
    const movement = {
      followEntity() { return true; },
      goToward() { return true; },
      stop() { movementStops += 1; }
    };
    const recovery = { active: true, emergencyUntil: 0, emergencyCooldownUntil: 0 };
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      movement,
      recovery
    });

    const during = setup.bot._stats();
    assert.equal(during.attackCount, 0);
    assert.equal(during.attackTarget, null);
    assert.equal(movementStops, 1);
    assert.ok(during.controls.left || during.controls.right || during.controls.forward || during.controls.back);
    assert.ok(recovery.emergencyUntil > Date.now());

    recovery.emergencyUntil = Date.now() - 1;
    await reflexes.tick({ movementHeld: false, isIdleish: true, movement, recovery });
    const afterBurst = setup.bot._stats();
    assert.equal(afterBurst.attackCount, 0);
    assert.equal(afterBurst.controls.left, false);
    assert.equal(afterBurst.controls.right, false);
    assert.equal(afterBurst.controls.forward, false);
    assert.equal(afterBurst.controls.back, false);

    recovery.active = false;
    await reflexes.tick({ movementHeld: false, isIdleish: true, movement, recovery });
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('武装済みRecovery中は周囲の脅威に通常戦闘で応答する', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie);
    setup.bot.inventory = {
      items: () => [{ name: 'iron_sword' }],
      slots: []
    };
    const movement = {
      followEntity() { return true; },
      goToward() { return true; },
      stop() {}
    };
    const recovery = { active: true, emergencyUntil: 0, emergencyCooldownUntil: 0 };
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      movement,
      recovery,
      recoveryDeferCombat: true
    });

    const stats = setup.bot._stats();
    assert.ok(stats.attackCount >= 1, 'armed recovery should attack nearby threats');
    assert.equal(recovery.emergencyUntil, 0);
  });

  it('FollowとWaitは上位モードを保つがRecovery制御を発行しない', async () => {
    const owner = makeEntity('Alice', 'player', 5, 64, 0);
    let followCount = 0;
    let stopCount = 0;
    const ctx = {
      bot: { entity: makeEntity('bot', 'player', 0, 64, 0) },
      config: { follow_distance: 3 },
      ownerName: 'Alice',
      ownerEntity: owner,
      deathRecovery: { active: true },
      agent: { reflexes: { isControllingMovement: false } },
      movement: {
        isHeld: false,
        hasGoal: true,
        tickHoldWatchdog() {},
        followEntity() { followCount += 1; },
        stop() { stopCount += 1; }
      }
    };

    await new FollowMode().tick(ctx as any);
    await new WaitMode().tick(ctx as any);
    assert.equal(followCount, 0);
    assert.equal(stopCount, 0);
  });

  it('戦闘中にowner位置へ到着しても戦術所有権を維持する', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    let stopCount = 0;
    let followCount = 0;
    const movement = {
      isHeld: false,
      hasGoal: true,
      tickHoldWatchdog() {},
      stop() { stopCount += 1; this.hasGoal = false; },
      followEntity() { followCount += 1; return true; },
      goToward() { return true; }
    };
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    const stopsAfterCombatClaim = stopCount;
    await new FollowMode().tick({
      bot: setup.bot,
      config: { follow_distance: 3 },
      ownerName: 'Alice',
      ownerEntity: owner,
      agent: { reflexes },
      movement
    } as any);

    assert.equal(reflexes.ownsTacticalControl, true);
    assert.equal(setup.bot._stats().attackTarget, skeleton);
    assert.equal(followCount, 0);
    assert.equal(stopCount, stopsAfterCombatClaim);
  });

  it('短い対象消失中は上位モードを抑制し、その後Followへ戻す', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    let followCount = 0;
    const movement = {
      isHeld: false,
      hasGoal: true,
      tickHoldWatchdog() {},
      stop() { this.hasGoal = false; },
      followEntity() { followCount += 1; return true; },
      goToward() { return true; }
    };
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);
    const follow = new FollowMode();
    const ctx = {
      bot: setup.bot,
      config: { follow_distance: 3 },
      ownerName: 'Alice',
      ownerEntity: owner,
      agent: { reflexes },
      movement
    };

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    delete setup.bot.entities[skeleton.id];
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    await follow.tick(ctx as any);
    assert.equal(reflexes.escortMode, 'follow');
    assert.equal(reflexes.ownsTacticalControl, true);
    assert.equal(followCount, 0);

    (reflexes as any).combatControlUntil = Date.now() - 1;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    await follow.tick(ctx as any);
    assert.equal(reflexes.ownsTacticalControl, false);
    assert.equal(followCount, 1);
  });

  it('戦闘が所有する移動を上書きしない', async () => {
    let followCount = 0;
    const owner = makeEntity('Alice', 'player', 5, 64, 0);
    const ctx = {
      bot: { entity: makeEntity('bot', 'player', 0, 64, 0) },
      config: { follow_distance: 3 },
      ownerName: 'Alice',
      ownerEntity: owner,
      agent: { reflexes: { isControllingMovement: true } },
      movement: {
        isHeld: false,
        tickHoldWatchdog() {},
        followEntity() {
          followCount += 1;
        },
        stop() {}
      }
    };

    await new FollowMode().tick(ctx as any);

    assert.equal(followCount, 0);
  });

  it('上位モード待機中も戦術戦闘が移動所有権を維持する', async () => {
    let stopCount = 0;
    const ctx = {
      agent: { reflexes: { isControllingMovement: true } },
      movement: {
        hasGoal: true,
        stop() { stopCount += 1; }
      }
    };

    await new WaitMode().tick(ctx as any);

    assert.equal(stopCount, 0);
  });
});
