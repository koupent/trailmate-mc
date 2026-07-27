/** Minimal world helpers used by companion (no Mindcraft library). */

export function isHostile(mob: { type?: string; name?: string } | null | undefined): boolean {
  if (!mob || !mob.name) return false;
  return (mob.type === 'mob' || mob.type === 'hostile')
    && mob.name !== 'iron_golem'
    && mob.name !== 'snow_golem';
}

export function getNearestEntityWhere(
  bot: { nearestEntity: (pred: (e: any) => boolean) => any; entity: { position: { distanceTo: (p: any) => number } } },
  predicate: (entity: any) => boolean,
  maxDistance = 16
) {
  return bot.nearestEntity(
    (entity) => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance
  );
}
