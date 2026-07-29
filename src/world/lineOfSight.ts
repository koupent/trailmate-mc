/**
 * True when nothing solid sits between two entity heads.
 * Used to tell "same room" from "on the other side of a door or wall".
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
 * Bot → target line of sight.
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
