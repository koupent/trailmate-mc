import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflexes } from '../src/reflexes/Reflexes.js';
import { FollowMode } from '../src/companion/modes/FollowMode.js';
import { hasLineOfSight } from '../src/world/lineOfSight.js';
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
      deactivateCount
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
  hostile_range: 8,
  combat_lost_grace_ms: 2500,
  retreat_health: 8,
  resume_health: 14,
  retreat_distance: 6,
  combat_learning: {
    enabled: false,
    explore_rate: 0,
    swarm_explore_rate: 0,
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
    const owner = makeEntity('Alice', 'player', 4, 64, 0);
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
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeEntity('Alice', 'player', 1, 64, 0);
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
    const owner = makeEntity('Alice', 'player', 1, 64, 0);
    const { bot, track } = makeBot({ hostiles: [zombie] });
    track(owner, zombie);
    const reflexes = new Reflexes(bot as any, CONFIG, 7);

    await reflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });

    const stats = bot._stats();
    assert.equal(stats.attackCount, 1);
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
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true });
    setup.setBlocked('zombie', true);
    await reflexes.tick({ movementHeld: false, isIdleish: true });

    assert.equal(setup.bot._stats().attackTarget, zombie);
    assert.equal(setup.bot._stats().stopCount, 0);
  });

  it('stops after the line-of-sight grace period expires', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const setup = makeBot({ hostiles: [zombie] });
    setup.track(zombie);
    const reflexes = new Reflexes(
      setup.bot as any,
      { ...CONFIG, combat_lost_grace_ms: -1 },
      7
    );

    await reflexes.tick({ movementHeld: false, isIdleish: true });
    setup.setBlocked('zombie', true);
    await reflexes.tick({ movementHeld: false, isIdleish: true });

    assert.equal(setup.bot._stats().attackTarget, null);
    assert.ok(setup.bot._stats().stopCount >= 1);
  });

  it('keeps a sticky immediate threat instead of switching targets', async () => {
    const immediate = makeEntity('zombie', 'hostile', 2, 64, 0);
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const owner = makeEntity('Alice', 'player', 6, 64, 0);
    const setup = makeBot({ hostiles: [immediate, ownerThreat] });
    setup.track(immediate, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, immediate);
    assert.equal(setup.bot._stats().attackCount, 2);
  });

  it('prioritizes a threat near the owner when none is immediately adjacent', async () => {
    const ownerThreat = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const other = makeEntity('zombie', 'hostile', 7, 64, 0);
    const owner = makeEntity('Alice', 'player', 6, 64, 0);
    const setup = makeBot({ hostiles: [other, ownerThreat] });
    setup.track(other, ownerThreat, owner);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner });

    assert.equal(setup.bot._stats().attackTarget, ownerThreat);
  });

  it('retreats to the owner at low health and waits to recover', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeEntity('Alice', 'player', 8, 64, 0);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    assert.deepEqual(movement._stats().followed, [owner]);
    assert.equal(setup.bot._stats().attackCount, 0);

    setup.bot.health = 10;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    assert.equal(setup.bot._stats().attackCount, 0);

    setup.bot.health = 14;
    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });
    assert.equal(setup.bot._stats().attackTarget, zombie);
  });

  it('retreats away when the owner is standing next to the threat', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeEntity('Alice', 'player', 3.5, 64, 0);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie, owner);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, owner, movement });

    assert.equal(movement._stats().followed.length, 0);
    assert.equal(movement._stats().destinations.length, 1);
    assert.ok(movement._stats().destinations[0].x < 0);
    assert.equal(movement._stats().sprintAllowed, true);
    assert.equal(setup.bot._stats().sprint, true);
    assert.ok(setup.bot._stats().deactivateCount >= 1);
  });

  it('keeps the same retreat destination across nearby ticks', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });
    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    const destinations = movement._stats().destinations;
    assert.equal(destinations.length, 2);
    assert.deepEqual(destinations[0], destinations[1]);
  });

  it('keeps the sticky target after the entity object is replaced', async () => {
    const first = makeEntity('zombie', 'hostile', 2, 64, 0);
    const second = makeEntity('skeleton', 'hostile', 5.5, 64, 0);
    const owner = makeEntity('Alice', 'player', 8, 64, 0);
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
    assert.equal(setup.bot._stats().attackCount, 2);
  });

  it('retreats away from the enemy when no owner is available', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const setup = makeBot({ hostiles: [zombie], health: 6 });
    setup.track(zombie);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.equal(movement._stats().destinations.length, 1);
    assert.ok(movement._stats().destinations[0].x < 0);
  });

  it('uses a closer pursuit range for ranged enemies', async () => {
    const skeleton = makeEntity('skeleton', 'hostile', 5, 64, 0);
    const setup = makeBot({ hostiles: [skeleton] });
    setup.track(skeleton);
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true });

    assert.equal(setup.bot._stats().followRange, 1.4);
  });

  it('soft-evades a nearby creeper before ignition', async () => {
    const creeper = makeEntity('creeper', 'hostile', 2.5, 64, 0);
    const setup = makeBot({ hostiles: [creeper] });
    setup.track(creeper);
    const movement = makeMovement();
    const reflexes = new Reflexes(setup.bot as any, CONFIG, 7);

    await reflexes.tick({ movementHeld: false, isIdleish: true, movement });

    assert.equal(setup.bot._stats().attackCount, 0);
    assert.equal(setup.bot._stats().forceStopCount, 1);
    assert.equal(movement._stats().destinations.length, 1);
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
});

describe('FollowMode combat coordination', () => {
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
});
