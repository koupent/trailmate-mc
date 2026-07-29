/**
 * 2つのエンティティの頭部間に固体ブロックがなければ true。
 * 「同じ部屋」と「扉や壁の向こう側」を区別するために使う。
 */

type PosOffset = {
  offset: (x: number, y: number, z: number) => any;
};

type SightEntity = {
  position: PosOffset;
  height?: number;
};

type WorldRay = {
  raycast: (from: any, dir: any, maxDist: number) => unknown;
};

export function hasLineOfSightFrom(
  world: WorldRay,
  observer: SightEntity & { height: number } | SightEntity,
  target: SightEntity
): boolean {
  const observerHeight = observer.height ?? 1.8;
  const eye = observer.position.offset(0, observerHeight * 0.9, 0);
  const aim = target.position.offset(0, (target.height ?? 1.8) * 0.9, 0);
  const delta = aim.minus(eye);
  const dist = delta.norm();
  if (dist < 0.1) return true;
  return world.raycast(eye, delta.scaled(1 / dist), dist) === null;
}

/**
 * Botから対象への視線判定。
 */
export function hasLineOfSight(
  bot: {
    entity: {
      position: PosOffset;
      height: number;
    };
    world: WorldRay;
  },
  target: SightEntity
): boolean {
  return hasLineOfSightFrom(bot.world, bot.entity, target);
}
