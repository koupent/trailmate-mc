/** Minimum delay between torch placements. */
export const TORCH_PLACE_COOLDOWN_MS = 3000;

/** Block light a torch emits at its own position (Minecraft 1.21). */
export const TORCH_LIGHT_LEVEL = 14;

const TORCH_BLOCK_NAMES = new Set(['torch', 'wall_torch']);

export type LightSample = {
  skyLight?: number;
};

export type BlockProbe = { name?: string } | null;

export type Position = { x: number; y: number; z: number };

export function isTorchBlockName(name: string | undefined | null): boolean {
  return typeof name === 'string' && TORCH_BLOCK_NAMES.has(name);
}

/**
 * Distance to the closest torch block within `radius`, or null when there is none.
 */
export function nearestTorchDistance(
  blockAt: (x: number, y: number, z: number) => BlockProbe,
  origin: Position,
  radius: number
): number | null {
  const ox = Math.floor(origin.x);
  const oy = Math.floor(origin.y);
  const oz = Math.floor(origin.z);
  const r = Math.max(0, Math.floor(radius));
  let best: number | null = null;

  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const distance = Math.hypot(dx, dy, dz);
        if (distance > r || (best !== null && distance >= best)) continue;
        if (isTorchBlockName(blockAt(ox + dx, oy + dy, oz + dz)?.name)) {
          best = distance;
        }
      }
    }
  }
  return best;
}

/**
 * Brightness of a spot, estimated from nearby torch blocks and sky light.
 *
 * The server's block-light data lags behind torches the bot just placed, so
 * light emitted by torches is derived from their block positions instead.
 */
export function estimateBrightness(opts: {
  skyLight: number | null;
  isNight: boolean;
  torchDistance: number | null;
}): number {
  const daylight = opts.isNight ? 0 : opts.skyLight ?? 0;
  const torchLight = opts.torchDistance === null
    ? 0
    : Math.max(0, TORCH_LIGHT_LEVEL - opts.torchDistance);
  return Math.max(daylight, torchLight);
}

/**
 * Torches beyond this range cannot raise brightness above the threshold.
 */
export function torchScanRadius(threshold: number): number {
  return Math.max(1, Math.ceil(TORCH_LIGHT_LEVEL - threshold));
}
