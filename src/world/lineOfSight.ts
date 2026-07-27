/**
 * True when nothing solid sits between the bot head and the target head.
 * Used to tell "same room" from "on the other side of a door or wall".
 */
export function hasLineOfSight(
  bot: {
    entity: {
      position: { offset: (x: number, y: number, z: number) => any };
      height: number;
    };
    world: { raycast: (from: any, dir: any, maxDist: number) => unknown };
  },
  target: {
    position: { offset: (x: number, y: number, z: number) => any };
    height?: number;
  }
): boolean {
  const eye = bot.entity.position.offset(0, bot.entity.height * 0.9, 0);
  const aim = target.position.offset(0, (target.height ?? 1.8) * 0.9, 0);
  const delta = aim.minus(eye);
  const dist = delta.norm();
  if (dist < 0.1) return true;
  return bot.world.raycast(eye, delta.scaled(1 / dist), dist) === null;
}
