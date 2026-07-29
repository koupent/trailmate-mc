/** Minimal world helpers used by companion (no Mindcraft library). */

type Pos = { x: number; y: number; z: number; distanceTo?: (p: any) => number };

type BotLike = {
  nearestEntity: (pred: (e: any) => boolean) => any;
  entities?: Record<string | number, any>;
  entity: { position: Pos };
};

export const IMMEDIATE_THREAT_RANGE = 3.5;
/** Enemies within this distance of the owner are escort threats (FOV-independent). */
export const OWNER_PROTECT_RANGE = 8;

export function isHostile(mob: { type?: string; name?: string } | null | undefined): boolean {
  if (!mob || !mob.name) return false;
  return (mob.type === 'mob' || mob.type === 'hostile')
    && mob.name !== 'iron_golem'
    && mob.name !== 'snow_golem';
}

export function isGroundItem(entity: { name?: string; type?: string; objectType?: string; displayName?: string } | null | undefined): boolean {
  if (!entity) return false;
  const name = String(entity.name || '').toLowerCase();
  if (name === 'item' || name === 'item_entity' || name === 'item entity') return true;
  if (entity.type === 'object' && (entity.objectType === 'Item' || entity.objectType === 'item')) return true;
  // Some proxies only expose displayName / generic object type.
  const display = String(entity.displayName || '').toLowerCase();
  if (display === 'item' || display === 'item entity') return true;
  return false;
}

export function getNearestEntityWhere(
  bot: BotLike,
  predicate: (entity: any) => boolean,
  maxDistance = 16
) {
  return bot.nearestEntity(
    (entity) => predicate(entity) && bot.entity.position.distanceTo!(entity.position) < maxDistance
  );
}

/**
 * Choose a visible hostile without relying on object iteration order.
 * Immediate threats to the bot come first, then threats near the owner.
 */
export function chooseCombatTarget(
  bot: BotLike,
  owner: { position: Pos } | null | undefined,
  maxDistance: number,
  isVisible: (entity: any) => boolean
): any | null {
  const candidates = Object.values(bot.entities || {}).filter((entity) => {
    if (!isHostile(entity) || !entity.position || !isVisible(entity)) return false;
    return distanceBetween(bot.entity.position, entity.position) < maxDistance;
  });

  // Small test stubs and old protocol adapters may only expose nearestEntity.
  if (candidates.length === 0) {
    return getNearestEntityWhere(
      bot,
      (entity) => isHostile(entity) && isVisible(entity),
      maxDistance
    );
  }

  candidates.sort((a, b) => {
    const aRank = threatRank(bot.entity.position, owner?.position, a.position);
    const bRank = threatRank(bot.entity.position, owner?.position, b.position);
    return aRank - bRank;
  });
  return candidates[0];
}

function threatRank(botPos: Pos, ownerPos: Pos | undefined, enemyPos: Pos): number {
  const botDistance = distanceBetween(botPos, enemyPos);
  if (botDistance <= IMMEDIATE_THREAT_RANGE) {
    return botDistance;
  }

  const ownerDistance = ownerPos ? distanceBetween(ownerPos, enemyPos) : Infinity;
  if (ownerDistance <= OWNER_PROTECT_RANGE) {
    return 100 + ownerDistance;
  }
  return 200 + botDistance;
}

function distanceBetween(a: Pos, b: Pos): number {
  if (typeof a.distanceTo === 'function') return a.distanceTo(b);
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Nearest dropped item entity within radius of `around` (defaults to bot).
 * Optional `exclude` skips entities (e.g. drops still near the owner).
 */
export function getNearestGroundItem(
  bot: BotLike,
  maxDistance = 16,
  around?: Pos,
  exclude?: (entity: any) => boolean
): any | null {
  const origin = around || bot.entity?.position;
  if (!origin) return null;

  const distanceTo = (pos: Pos) => {
    if (typeof (origin as any).distanceTo === 'function') {
      return (origin as any).distanceTo(pos);
    }
    const dx = pos.x - origin.x;
    const dy = pos.y - origin.y;
    const dz = pos.z - origin.z;
    return Math.hypot(dx, dy, dz);
  };

  if (typeof bot.nearestEntity === 'function' && !around && !exclude) {
    return bot.nearestEntity(
      (entity) => isGroundItem(entity) && bot.entity.position.distanceTo!(entity.position) < maxDistance
    );
  }

  let best: any = null;
  let bestDist = maxDistance;
  for (const entity of Object.values(bot.entities || {})) {
    if (!isGroundItem(entity) || !entity.position) continue;
    if (exclude?.(entity)) continue;
    const dist = distanceTo(entity.position);
    if (dist < bestDist) {
      best = entity;
      bestDist = dist;
    }
  }
  return best;
}
