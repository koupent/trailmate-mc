/** Shared horizontal FOV helpers (Mineflayer yaw convention). */

export type FovPos = { x: number; y?: number; z: number };

/**
 * True when `targetPos` lies inside the horizontal FOV cone around `yaw`.
 * Uses atan2(-dx, -dz) so yaw 0 faces -Z (Mineflayer).
 */
export function isInHorizontalFov(
  origin: FovPos,
  yaw: number,
  targetPos: FovPos,
  fovDegrees: number
): boolean {
  if (!Number.isFinite(yaw) || !Number.isFinite(fovDegrees) || fovDegrees <= 0) return false;
  if (fovDegrees >= 360) return true;
  const dx = targetPos.x - origin.x;
  const dz = targetPos.z - origin.z;
  const angleTo = Math.atan2(-dx, -dz);
  let diff = angleTo - yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return Math.abs(diff) <= (fovDegrees * Math.PI) / 180 / 2;
}

/** Issue 14以前の呼び出しとの互換名。 */
export const isInFov = isInHorizontalFov;

/**
 * True when `targetPos` is inside the owner's horizontal look FOV.
 */
export function isInOwnerFov(
  owner: { position: FovPos; yaw?: number } | null | undefined,
  targetPos: FovPos,
  fovDegrees: number
): boolean {
  if (!owner?.position) return false;
  return isInHorizontalFov(owner.position, owner.yaw || 0, targetPos, fovDegrees);
}
