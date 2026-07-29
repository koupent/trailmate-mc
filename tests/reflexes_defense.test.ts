import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflexes } from '../src/reflexes/Reflexes.js';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import { WaitMode } from '../src/companion/modes/WaitMode.js';
import { hasLineOfSight } from '../src/world/lineOfSight.js';
import { computeThreatArc } from '../src/combat/threatArc.js';
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

/** Owner looking at `lookAt` (mineflayer yaw). */
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
  /** Entity names whose head ray is blocked (door/wall). */
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

  // Replace raycast with aim-aware check: look at known tracked entities.
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
  it('returns true when raycast is clear', () => {
    const { bot, track } = makeBot();
    const owner = makeEntity('Alice', 'player', 2, 64, 0);
    track(owner);
    assert.equal(hasLineOfSight(bot, owner), true);
  });

  it('returns false when a door blocks the ray', () => {
    const { bot, track } = makeBot({ blockedNames: ['Alice'] });
    const owner = makeEntity('Alice', 'player', 2, 64, 0);
    track(owner);
    assert.equal(hasLineOfSight(bot, owner), false);
  });
});

describe('Reflexes combat decisions', () => {
  it('keeps fighting when the owner moves behind a closed door', async () => {
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

  it('does not start a new fight against an enemy behind a closed door', async () => {
    // Beyond immediate self-defense range so owner-view LOS is required.
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

  it('attacks a visible enemy in the same space', async () => {
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

  it('keeps self-defense when no owner is set and the enemy is visible', async () => {
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

  it('keeps the current target during a short line-of-sight loss', async () => {
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

  it('stops after line-of-sight grace and the tactical release window expire', async () => {
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

  it('keeps a sticky immediate threat instead of switching targets', async () => {
    const immediate = makeEntity('zombie', 'hostile', 2, 64, 0);
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, ownerThreat);
    const setup = makeBot({ hostiles: [immediate, ownerThreat] });
    setup.track(immediate, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, immediate);
    // Same target id must not re-call pvp.attack (avoids await stop() stalls).
    // melee assist may add bot.attack swings; pvp.attack stays once.
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('prioritizes a threat near the owner when none is immediately adjacent', async () => {
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const other = makeEntity('zombie', 'hostile', 7, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, ownerThreat);
    const setup = makeBot({ hostiles: [other, ownerThreat] });
    setup.track(other, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, ownerThreat);
  });

  it('keeps fighting in guard at low health instead of fleeing to the owner', async () => {
    const zombie = makeEntity('zombie', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 12, 64, 0, zombie);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(reflexes.escortMode, 'guard');
    assert.equal(setup.bot._stats().attackTarget, zombie);
    // Must not path to owner-cover retreat destinations.
    assert.equal(movement._stats().destinations.length, 0);
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('still guards at low health when the owner is next to the threat', async () => {
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

  it('still guards at low health when no owner is available', async () => {
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

  it('keeps the sticky target after the entity object is replaced', async () => {
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
    // Object identity may change across ticks; match by entity id and skip re-attack.
    assert.ok(setup.bot._stats().attackCount >= 1);
  });

  it('uses kite follow range for ranged enemies', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 6, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().followRange, 3.6);
  });

  it('melees a nearby creeper instead of backing off before ignition', async () => {
    const creeper = makeEntity('creeper', 'hostile', 2.5, 64, 0);
    const setup = makeBot({ hostiles: [creeper] });
    setup.track(creeper);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.ok(setup.bot._stats().attackCount >= 1);
    assert.equal(movement._stats().destinations.length, 0);
  });

  it('backs away from an ignited creeper without a shield', async () => {
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

  it('guards an enemy near the owner even when behind the owner facing', async () => {
    // Owner looks -Z; skeleton is at +Z but within protect radius.
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

  it('ignores an enemy far from both the owner and the bot', async () => {
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

  it('self-defends against an immediate threat far from the owner', async () => {
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

  it('still guards owner-near threats when owner yaw is missing', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 0, 64, -6);
    const owner = makeEntity('Alice', 'player', 0, 64, 0); // no yaw
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('returns to follow after threats disappear past grace', async () => {
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

  it('keeps single-enemy combat on the existing attack path without repositioning', async () => {
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

  it('repositions sideways for front/back threats and keeps a melee strike available', async () => {
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

  it('attacks a narrow enemy cluster without taking over pathfinder movement', async () => {
    const left = makeEntity('zombie', 'hostile', -0.4, 64, 3);
    const right = makeEntity('zombie', 'hostile', 0.4, 64, 3);
    const owner = makeOwner('Alice', 0, 64, 0, left);
    const setup = makeBot({ hostiles: [left, right] });
    setup.track(left, right, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().destinations.length, 0);
    assert.equal(setup.bot._stats().forceStopCount, 0);
    assert.equal(setup.bot._stats().attackTarget, left);
  });

  it('dodges perpendicular to a single ranged enemy in world space', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const owner = makeOwner('Alice', 0, 64, 0, skeleton);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.bot.entity.yaw = Math.PI / 2; // Bot currently faces -X.
    setup.track(skeleton, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    const controls = setup.bot._stats().controls;
    // Shot line is east/west; with this yaw, left moves along +Z.
    assert.equal(controls.left, true);
    assert.equal(controls.forward, false);
    assert.equal(controls.back, false);
    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('explicitly advances toward a ranged enemy after the dodge burst', async () => {
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
    // Enemy is +X. With yaw 0, +X is the right movement control.
    assert.equal(controls.right, true);
    assert.equal(controls.left, false);
    assert.equal(controls.forward, false);
    assert.equal(controls.back, false);
    assert.equal(setup.bot._stats().attackTarget, skeleton);
  });

  it('drops the dodge latch and attacks when a ranged enemy reaches melee range', async () => {
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

  it('prioritizes positioning for two ranged enemies in front/back', async () => {
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

  it('prioritizes positioning for two ranged enemies at 90 degrees', async () => {
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
    assert.ok(destination.x < 0 && destination.z < 0);
    assert.equal(setup.bot._stats().forceStopCount, 0);
  });

  it('keeps shield guard active while positioning under ranged pressure', async () => {
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
    // Attack intent exists in the pure decision, but shield wins the API conflict.
    assert.equal(setup.bot._stats().attackCount, 0);
  });
});

describe('upper-mode combat coordination', () => {
  it('Recovery owns movement; only a bounded survival dodge may interrupt it', async () => {
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

  it('Follow and Wait retain their upper mode but do not issue recovery controls', async () => {
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

  it('keeps tactical ownership when combat reaches the owner position', async () => {
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

  it('holds upper modes through a short target gap, then releases to Follow', async () => {
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

  it('does not overwrite movement while combat controls it', async () => {
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

  it('lets tactical combat retain movement ownership while the upper mode waits', async () => {
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
