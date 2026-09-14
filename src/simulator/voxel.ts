/**
 * 箱庭用の有限ボクセル格子。本番 Mineflayer の world とは独立。
 */

export type Voxel = { x: number; y: number; z: number };
export type Vec3 = { x: number; y: number; z: number };

export const ARENA_HALF = 12;
export const ARENA_HEIGHT = 8;
export const EYE_HEIGHT = 1.62;
export const BODY_HEIGHT = 1.8;
/** この高さ未満は虚空落下死（穴の底より下）。 */
export const VOID_DEATH_Y = -0.25;
/** 穴の底として敷く床の y（表面の y=0 より一段下）。 */
export const PIT_FLOOR_Y = -1;

export function voxelKey(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

export function parseVoxelKey(key: string): Voxel {
  const [x, y, z] = key.split(',').map(Number);
  return { x, y, z };
}

export function createBlockSet(blocks: Voxel[] = []): Set<string> {
  return new Set(blocks.map((block) => voxelKey(block.x, block.y, block.z)));
}

export function hasBlock(blocks: Set<string>, x: number, y: number, z: number): boolean {
  return blocks.has(voxelKey(x, y, z));
}

export function inArenaBounds(x: number, y: number, z: number): boolean {
  return (
    Math.abs(x) <= ARENA_HALF
    && Math.abs(z) <= ARENA_HALF
    && y >= -1
    && y < ARENA_HEIGHT
  );
}

/** y=0 の床を全面に敷く。穴は後で除去する。 */
export function createFlatFloor(half = ARENA_HALF): Voxel[] {
  const blocks: Voxel[] = [];
  for (let x = -half; x <= half; x += 1) {
    for (let z = -half; z <= half; z += 1) {
      blocks.push({ x, y: 0, z });
    }
  }
  return blocks;
}

export function standingY(blocks: Set<string>, x: number, z: number, startY = ARENA_HEIGHT - 1): number {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  for (let y = Math.min(startY, ARENA_HEIGHT - 1); y >= -2; y -= 1) {
    if (hasBlock(blocks, fx, y, fz)) return y + 1;
  }
  return -2;
}

/** 足元に固体が無く、落下し続ける座標か。 */
export function isOverVoid(blocks: Set<string>, x: number, z: number, startY = ARENA_HEIGHT - 1): boolean {
  return standingY(blocks, x, z, startY) < -1;
}

export function canOccupy(blocks: Set<string>, x: number, y: number, z: number): boolean {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  if (!inArenaBounds(fx, fy, fz)) return false;
  if (hasBlock(blocks, fx, fy, fz)) return false;
  if (hasBlock(blocks, fx, fy + 1, fz)) return false;
  return true;
}

/**
 * 水平へ maxStep だけ進む。1段なら登り、足元が無ければ落ちる。
 */
export function stepEntity(
  blocks: Set<string>,
  from: Vec3,
  toXZ: { x: number; z: number },
  maxStep: number
): Vec3 {
  const dx = toXZ.x - from.x;
  const dz = toXZ.z - from.z;
  const length = Math.hypot(dx, dz);
  let nextX = from.x;
  let nextZ = from.z;
  if (length > 1e-6) {
    const ratio = Math.min(1, maxStep / length);
    nextX = from.x + dx * ratio;
    nextZ = from.z + dz * ratio;
  }

  const candidates = [
    { x: nextX, y: from.y, z: nextZ },
    { x: nextX, y: from.y + 1, z: nextZ }
  ];
  for (const candidate of candidates) {
    if (!canOccupy(blocks, candidate.x, candidate.y, candidate.z)) continue;
    const floorY = standingY(blocks, candidate.x, candidate.z, candidate.y);
    if (floorY < -1) continue;
    if (candidate.y - floorY > 1.05) {
      // 落下（最大1ブロック/tick）
      return { x: candidate.x, y: Math.max(floorY, candidate.y - 1), z: candidate.z };
    }
    if (floorY - candidate.y > 1.01) continue;
    return { x: candidate.x, y: floorY, z: candidate.z };
  }
  // 進めない場合も足元を合わせる。虚空なら1ブロック落下（上位で虚空死判定）。
  const floorY = standingY(blocks, from.x, from.z, from.y + 1);
  if (floorY < -1) {
    return { x: from.x, y: from.y - 1, z: from.z };
  }
  return { x: from.x, y: floorY, z: from.z };
}

export function horizontalDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 頭部付近の直線に固体があれば false。ほぼ同座標は近接接触として通す。 */
export function hasVoxelLineOfSight(blocks: Set<string>, from: Vec3, to: Vec3): boolean {
  const ax = from.x;
  const ay = from.y + EYE_HEIGHT;
  const az = from.z;
  const bx = to.x;
  const by = to.y + EYE_HEIGHT;
  const bz = to.z;
  const horizontal = Math.hypot(bx - ax, bz - az);
  // めり込み・同一マスは視線判定しない（近接殴り合いを止めない）
  if (horizontal < 0.35) return true;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.1) return true;
  const steps = Math.max(2, Math.ceil(dist / 0.25));
  for (let index = 1; index < steps; index += 1) {
    const t = index / steps;
    const x = ax + dx * t;
    const y = ay + dy * t;
    const z = az + dz * t;
    if (hasBlock(blocks, Math.floor(x), Math.floor(y), Math.floor(z))) return false;
  }
  return true;
}

export function isPathBlocked3D(blocks: Set<string>, from: Vec3, to: { x: number; z: number }): boolean {
  const pathLength = horizontalDistance(from, to);
  const samples = Math.max(1, Math.ceil(pathLength / 0.25));
  for (let index = 1; index <= samples; index += 1) {
    const ratio = index / samples;
    const x = from.x + (to.x - from.x) * ratio;
    const z = from.z + (to.z - from.z) * ratio;
    const y = standingY(blocks, x, z, from.y + 2);
    if (y < -1) return true;
    if (!canOccupy(blocks, x, y, z)) return true;
    if (Math.abs(y - from.y) > 1.05 && index < samples) return true;
  }
  return false;
}
