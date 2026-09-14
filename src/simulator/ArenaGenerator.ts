import { createDeathRecoveryState } from '../companion/deathRecovery.js';
import { idleRangedDodgeLatch } from '../combat/CombatIntent.js';
import {
  createBlockSet,
  createFlatFloor,
  standingY,
  type Voxel,
  ARENA_HALF,
  PIT_FLOOR_Y
} from './voxel.js';
import { normalizeState, type SimulationState, type SimEnemy } from './SimulationCore.js';

export type ArenaKind =
  | 'flat-melee'
  | 'flat-ranged'
  | 'elevated-ranged'
  | 'wall-los'
  | 'pincer'
  | 'mixed'
  | 'pit-melee';

export const ARENA_KINDS: ArenaKind[] = [
  'flat-melee',
  'flat-ranged',
  'elevated-ranged',
  'wall-los',
  'pincer',
  'mixed',
  'pit-melee'
];

export type SeededRng = {
  next: () => number;
  int: (min: number, maxExclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
};

export function createSeededRng(seed: number): SeededRng {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    next,
    int: (min, maxExclusive) => min + Math.floor(next() * (maxExclusive - min)),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (probability) => next() < probability
  };
}

export function generateArena(seed: number, kind?: ArenaKind): SimulationState {
  const rng = createSeededRng(seed);
  const arenaKind = kind || rng.pick(ARENA_KINDS);
  let blocks = createFlatFloor();
  const enemies: SimEnemy[] = [];
  let nextId = 1;

  const placeEnemy = (enemyKind: string, x: number, z: number, y?: number): void => {
    const blockSet = createBlockSet(blocks);
    const feetY = y ?? standingY(blockSet, x, z);
    if (feetY < 0) return; // 虚空には出さない
    enemies.push({
      id: nextId++,
      kind: enemyKind,
      x: x + (rng.next() - 0.5) * 0.4,
      y: feetY,
      z: z + (rng.next() - 0.5) * 0.4,
      hp: enemyKind === 'zombie' ? 24 : 20
    });
  };

  if (arenaKind === 'flat-melee') {
    const count = rng.int(1, 4);
    for (let index = 0; index < count; index += 1) {
      placeEnemy(rng.pick(['zombie', 'spider']), rng.int(-8, 9), rng.int(-8, 9));
    }
  } else if (arenaKind === 'flat-ranged') {
    const count = rng.int(1, 3);
    for (let index = 0; index < count; index += 1) {
      placeEnemy('skeleton', rng.int(-9, 10), rng.int(-9, 10));
    }
  } else if (arenaKind === 'elevated-ranged') {
    const platform: Voxel[] = [];
    const px = rng.int(4, 9) * (rng.chance(0.5) ? 1 : -1);
    const pz = rng.int(-3, 4);
    for (let x = px - 1; x <= px + 1; x += 1) {
      for (let z = pz - 1; z <= pz + 1; z += 1) {
        platform.push({ x, y: 1, z });
      }
    }
    blocks = [...blocks, ...platform];
    placeEnemy('skeleton', px, pz, 2);
    if (rng.chance(0.5)) placeEnemy('zombie', rng.int(-6, 7), rng.int(-6, 7));
  } else if (arenaKind === 'wall-los') {
    const wallX = rng.int(2, 5);
    const wall: Voxel[] = [];
    for (let y = 1; y <= 3; y += 1) {
      for (let z = -3; z <= 3; z += 1) {
        if (z === 0 && rng.chance(0.35)) continue; // たまに隙間
        wall.push({ x: wallX, y, z });
      }
    }
    blocks = [...blocks, ...wall];
    placeEnemy(rng.pick(['zombie', 'skeleton']), wallX + 4, rng.int(-2, 3));
  } else if (arenaKind === 'pincer') {
    placeEnemy('zombie', -7, rng.int(-2, 3));
    placeEnemy(rng.pick(['zombie', 'spider']), 7, rng.int(-2, 3));
  } else if (arenaKind === 'mixed') {
    placeEnemy('zombie', rng.int(-8, -3), rng.int(-4, 5));
    placeEnemy('skeleton', rng.int(4, 10), rng.int(-6, 7));
    if (rng.chance(0.4)) placeEnemy('creeper', rng.int(-3, 4), rng.int(5, 10));
  } else if (arenaKind === 'pit-melee') {
    // 表面に穴を開けるが、底に必ず床を残す（虚空落下の無限ループ防止）
    const holeX = rng.int(-2, 3);
    const holeZ = rng.int(-2, 3);
    const pitBottom: Voxel[] = [];
    blocks = blocks.filter((block) => {
      const inHole = block.y === 0
        && Math.abs(block.x - holeX) <= 1
        && Math.abs(block.z - holeZ) <= 1;
      if (inHole) {
        pitBottom.push({ x: block.x, y: PIT_FLOOR_Y, z: block.z });
      }
      return !inHole;
    });
    blocks = [...blocks, ...pitBottom];
    placeEnemy('zombie', rng.int(4, 9), rng.int(-4, 5));
    placeEnemy('spider', rng.int(-9, -3), rng.int(-4, 5));
  }

  // 相棒とオーナーは中央付近の固体上（穴の中・虚空には出さない）
  const blockSet = createBlockSet(blocks);
  const botSpawn = pickSolidSpawn(blockSet, rng, rng.next() * 2 - 1, rng.next() * 2 - 1);
  const ownerSpawn = pickSolidSpawn(
    blockSet,
    rng,
    botSpawn.x - 3 + rng.next(),
    botSpawn.z + (rng.next() - 0.5) * 2
  );

  const state: SimulationState = {
    name: `gym:${arenaKind}`,
    now: 0,
    tickMs: 250,
    tick: 0,
    bot: {
      x: botSpawn.x,
      y: botSpawn.y,
      z: botSpawn.z,
      yaw: 0,
      hp: 20
    },
    owner: {
      x: ownerSpawn.x,
      y: ownerSpawn.y,
      z: ownerSpawn.z
    },
    enemies,
    blocks,
    obstacles: [],
    grave: null,
    drops: [],
    inventory: (() => {
      // 混成（スケルトン込み）は盾持ち率を上げ、遠距離チップで即死しにくくする
      const shieldChance = arenaKind === 'mixed' ? 0.55 : 0.35;
      return rng.chance(shieldChance) ? ['stone_sword', 'shield'] : ['stone_sword'];
    })(),
    equipped: 'stone_sword',
    recovery: createDeathRecoveryState(),
    dodgeLatch: idleRangedDodgeLatch(),
    nextId: Math.max(100, nextId + 10),
    attacks: 0,
    shots: 0,
    projectiles: [],
    damageTaken: 0,
    botDead: false,
    ended: false,
    outcome: 'ongoing',
    enemyAi: { enabled: true, speedScale: 0.85 + rng.next() * 0.4 },
    transitions: [],
    lastOwner: 'follow',
    seed,
    arenaKind
  };
  return normalizeState(state);
}

function pickSolidSpawn(
  blockSet: ReturnType<typeof createBlockSet>,
  rng: SeededRng,
  preferX: number,
  preferZ: number
): { x: number; y: number; z: number } {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const x = clampCoord(preferX + (attempt === 0 ? 0 : (rng.next() - 0.5) * 8));
    const z = clampCoord(preferZ + (attempt === 0 ? 0 : (rng.next() - 0.5) * 8));
    const y = standingY(blockSet, x, z);
    // 通常床(y=1)を優先。穴底(y=0)は避ける。
    if (y >= 1) return { x, y, z };
  }
  return { x: 0, y: Math.max(1, standingY(blockSet, 0, 0)), z: 0 };
}

function clampCoord(value: number): number {
  return Math.max(-ARENA_HALF + 1, Math.min(ARENA_HALF - 1, value));
}
