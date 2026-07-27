import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflexes } from '../src/reflexes/Reflexes.js';
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
  name: string;
  type: string;
  height: number;
  position: Vec;
};

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
};

function makeBot(opts: BotOpts = {}) {
  const hostiles = opts.hostiles || [];
  const blocked = new Set(opts.blockedNames || []);
  const botEntity = makeEntity('bot', 'player', 0, 64, 0);
  let attackTarget: EntityStub | null = null;
  let stopCount = 0;
  let attackCount = 0;

  const bot = {
    entity: botEntity,
    world: {
      raycast(_from: Vec, _dir: unknown, _maxDist: number): { name: string } | null {
        return null;
      }
    },
    nearestEntity(pred: (e: EntityStub) => boolean) {
      return hostiles.find((e) => pred(e)) || null;
    },
    inventory: { items: () => [] as { name: string }[] },
    blockAt: () => ({ name: 'air' }),
    time: { timeOfDay: 1000 },
    pvp: {
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
      }
    },
    _stats: () => ({ attackCount, stopCount, attackTarget })
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
    }
  };
}

const CONFIG: ReflexConfig = {
  self_defense: true,
  self_preservation: false,
  torch_placing: false,
  hostile_range: 8
};

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

describe('Reflexes.defend line-of-sight gates', () => {
  it('stops combat when the owner moves behind a closed door', async () => {
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
    assert.equal(stats.attackTarget, null);
    assert.ok(stats.stopCount >= 1);
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

  it('attacks again after the owner becomes visible outdoors', async () => {
    const zombie = makeEntity('zombie', 'hostile', 3, 64, 0);
    const owner = makeEntity('Alice', 'player', 1, 64, 0);

    const blocked = makeBot({
      blockedNames: ['Alice'],
      hostiles: [zombie]
    });
    blocked.track(owner, zombie);
    const blockedReflexes = new Reflexes(blocked.bot as any, CONFIG, 7);
    await blocked.bot.pvp.attack(zombie);
    await blockedReflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });
    assert.equal(blocked.bot._stats().attackTarget, null);

    const open = makeBot({ hostiles: [zombie] });
    open.track(owner, zombie);
    const openReflexes = new Reflexes(open.bot as any, CONFIG, 7);
    await openReflexes.tick({
      movementHeld: false,
      isIdleish: true,
      owner
    });
    assert.equal(open.bot._stats().attackTarget, zombie);
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
});
