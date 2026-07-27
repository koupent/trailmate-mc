/** Minimal world helpers used by companion (no Mindcraft library). */

type Pos = { x: number; y: number; z: number; distanceTo?: (p: any) => number };

type BotLike = {
  nearestEntity: (pred: (e: any) => boolean) => any;
  entities?: Record<string | number, any>;
  entity: { position: Pos };
};

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
 * Nearest dropped item entity within radius of `around` (defaults to bot).
 */
export function getNearestGroundItem(
  bot: BotLike,
  maxDistance = 16,
  around?: Pos
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

  if (typeof bot.nearestEntity === 'function' && !around) {
    return bot.nearestEntity(
      (entity) => isGroundItem(entity) && bot.entity.position.distanceTo!(entity.position) < maxDistance
    );
  }

  let best: any = null;
  let bestDist = maxDistance;
  for (const entity of Object.values(bot.entities || {})) {
    if (!isGroundItem(entity) || !entity.position) continue;
    const dist = distanceTo(entity.position);
    if (dist < bestDist) {
      best = entity;
      bestDist = dist;
    }
  }
  return best;
}
