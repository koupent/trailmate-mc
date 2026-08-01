import { Vec3 } from 'vec3';
import { isGroundItem } from './entities.js';
import {
  findGraveBlockNearHologram,
  isGraveCandidateBlock,
  readEntityDisplayText
} from './graves.js';

type Pos = { x: number; y: number; z: number; distanceTo?: (p: any) => number };

type BotLike = {
  entity?: { position: Pos };
  entities?: Record<string | number, any>;
  blockAt?: (pos: Vec3) => { name?: string; position: Pos } | null;
  registry?: { entitiesByName?: Record<string, { metadataKeys?: string[] }> };
};

export type AwareBlock = {
  position: { x: number; y: number; z: number };
  name: string;
  block: any;
  source: 'hologram' | 'scan';
};

export type CompanionAwarenessSnapshot = {
  scannedAt: number;
  origin: { x: number; y: number; z: number };
  radius: number;
  dropItems: any[];
  displayEntities: any[];
  blocks: AwareBlock[];
  entities: any[];
};

/**
 * Scan entities (and grave-related blocks) within `radius` of the companion.
 * Perception only — no pickup / dig policy.
 */
export function scanCompanionAwareness(
  bot: BotLike,
  radius: number,
  origin?: Pos
): CompanionAwarenessSnapshot {
  const scannedAt = Date.now();
  const center = origin || bot.entity?.position;
  if (!bot || !center || !(radius > 0)) {
    return emptySnapshot(scannedAt, center || { x: 0, y: 0, z: 0 }, radius);
  }

  const originPos = { x: center.x, y: center.y, z: center.z };
  const entities: any[] = [];
  const dropItems: any[] = [];
  const displayEntities: any[] = [];
  const registry = bot.registry;

  for (const entity of Object.values(bot.entities || {})) {
    if (!entity?.position) continue;
    if (!isWithinPickupRange(originPos, entity.position, radius)) continue;
    entities.push(entity);
    if (isGroundItem(entity)) {
      dropItems.push(entity);
    }
    if (isHologramEntity(entity, registry)) {
      displayEntities.push(entity);
    }
  }

  const blocks = resolveBlocksNearDisplays(bot, displayEntities);

  return {
    scannedAt,
    origin: originPos,
    radius,
    dropItems,
    displayEntities,
    blocks,
    entities
  };
}

/**
 * Nearest drop in the snapshot relative to `around` (defaults to snapshot.origin).
 * Uses horizontal distance so nearby items on slopes are preferred over farther flats.
 */
export function findNearestDrop(
  snapshot: CompanionAwarenessSnapshot | null | undefined,
  around?: Pos,
  pool?: any[]
): any | null {
  if (!snapshot) return null;
  const origin = around || snapshot.origin;
  if (!origin) return null;
  const items = pool || snapshot.dropItems || [];
  let best: any = null;
  let bestDist = Infinity;
  for (const item of items) {
    if (!item?.position) continue;
    const dist = dropDistanceFrom(origin, item.position);
    if (dist < bestDist) {
      best = item;
      bestDist = dist;
    }
  }
  return best;
}

/** Horizontal distance used for pickup ordering (matches scan radius). */
export function dropDistanceFrom(origin: Pos, itemPos: Pos): number {
  if (Math.abs(origin.y - itemPos.y) > MAX_PICKUP_DY) return Infinity;
  return Math.hypot(origin.x - itemPos.x, origin.z - itemPos.z);
}

function resolveBlocksNearDisplays(bot: BotLike, displayEntities: any[]): AwareBlock[] {
  const blocks: AwareBlock[] = [];
  const seen = new Set<string>();

  for (const entity of displayEntities) {
    const found = findGraveBlockNearHologram(bot as any, entity.position);
    if (!found) continue;
    const key = blockKey(found.position);
    if (seen.has(key)) continue;
    seen.add(key);
    const live = bot.blockAt
      ? bot.blockAt(new Vec3(
        Math.floor(found.position.x),
        Math.floor(found.position.y),
        Math.floor(found.position.z)
      ))
      : null;
    if (live?.name && !isGraveCandidateBlock(live.name)) continue;
    blocks.push({
      position: {
        x: found.position.x,
        y: found.position.y,
        z: found.position.z
      },
      name: found.name,
      block: live || found,
      source: 'hologram'
    });
  }

  return blocks;
}

function isHologramEntity(entity: any, registry?: any): boolean {
  if (!entity?.position) return false;
  const name = String(entity.name || '').toLowerCase();
  if (name === 'armor_stand' || name === 'text_display' || name === 'interaction') return true;
  return readEntityDisplayText(entity, registry) != null
    && (entity.type === 'object' || entity.type === 'other');
}

function emptySnapshot(
  scannedAt: number,
  origin: Pos,
  radius: number
): CompanionAwarenessSnapshot {
  return {
    scannedAt,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    radius,
    dropItems: [],
    displayEntities: [],
    blocks: [],
    entities: []
  };
}

function blockKey(pos: Pos): string {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

const MAX_PICKUP_DY = 4;

/** Horizontal range for drops — avoids missing items on slopes due to 3D distance. */
function isWithinPickupRange(origin: Pos, target: Pos, radius: number): boolean {
  if (Math.abs(origin.y - target.y) > MAX_PICKUP_DY) return false;
  return Math.hypot(origin.x - target.x, origin.z - target.z) <= radius;
}
