/** Shared horizontal FOV helpers (Mineflayer yaw convention). */

type Pos = { x: number; y: number; z: number };

/**
 * True when `targetPos` lies inside the horizontal FOV cone around `yaw`.
 * Uses atan2(-dx, -dz) so yaw 0 faces -Z (Mineflayer).
 */
export function isInHorizontalFov(
  origin: Pos,
  yaw: number,
  targetPos: Pos,
  fovDegrees: number
): boolean {
  if (fovDegrees <= 0) return false;
  if (fovDegrees >= 360) return true;
  const dx = targetPos.x - origin.x;
  const dz = targetPos.z - origin.z;
  const angleTo = Math.atan2(-dx, -dz);
  let diff = angleTo - yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= (fovDegrees * Math.PI) / 180 / 2;
}

/**
 * True when `targetPos` is inside the owner's horizontal look FOV.
 */
export function isInOwnerFov(
  owner: { position: Pos; yaw?: number } | null | undefined,
  targetPos: Pos,
  fovDegrees: number
): boolean {
  if (!owner?.position) return false;
  return isInHorizontalFov(owner.position, owner.yaw || 0, targetPos, fovDegrees);
}
