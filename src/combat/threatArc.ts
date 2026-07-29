/**
 * Pure rule-based positioning for multiple horizontal threats.
 *
 * Bearings use atan2(dx, dz): 0 points toward +Z and +PI/2 toward +X.
 * Mineflayer yaw uses the opposite forward convention, so callers that need
 * keyboard controls must use movementControlsTowardBearing().
 */

export type XZ = { x: number; z: number };

export type ThreatArc = {
  /** Smallest circular arc covering all usable threat bearings. */
  spanRad: number;
  /** Mid-bearing of the covering arc, toward the threat cluster. */
  midRad: number;
  /** Bearing opposite the cluster midpoint, toward open space. */
  openRad: number;
};

export type ThreatPositionEvaluation = {
  position: XZ;
  spanRad: number;
  minEnemyDistance: number;
  moveDistance: number;
  dangerPenalty: number;
  ownerPenalty: number;
  movementPenalty: number;
  score: number;
};

export type ThreatPositionOptions = {
  /** Candidate step used when explicit candidates are not supplied. */
  step?: number;
  /** Avoid candidates closer than this to any enemy. */
  minEnemyDistance?: number;
  /** Radians of score penalty per block inside minEnemyDistance. */
  dangerWeight?: number;
  /** Small tie-break cost per block moved. */
  movementWeight?: number;
  ownerPos?: XZ | null;
  /** Soft leash; candidates beyond this radius are penalized. */
  maxOwnerDistance?: number;
  /** Radians of score penalty per block outside maxOwnerDistance. */
  ownerWeight?: number;
  /** Do not move for tiny/noisy score improvements. */
  minimumImprovement?: number;
  /** Optional pre-filtered world positions (stay is always added). */
  candidates?: XZ[];
};

export type ThreatPositionSelection = {
  current: ThreatPositionEvaluation;
  chosen: ThreatPositionEvaluation;
  moved: boolean;
  improvement: number;
};

export type BearingMovementControls = {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
};

/** Ideal maximum threat wedge. */
export const TARGET_THREAT_SPAN_RAD = (35 * Math.PI) / 180;
/** A wide flank where positioning should take priority over ordinary strafe. */
export const WIDE_THREAT_SPAN_RAD = (90 * Math.PI) / 180;
/** Enter/exit thresholds provide hysteresis around arc repositioning. */
export const ENTER_ARC_NARROW_SPAN_RAD = TARGET_THREAT_SPAN_RAD;
export const EXIT_ARC_NARROW_SPAN_RAD = (25 * Math.PI) / 180;

const DEFAULT_STEP = 2.25;
const DEFAULT_MIN_ENEMY_DISTANCE = 1.8;
const DEFAULT_DANGER_WEIGHT = Math.PI;
const DEFAULT_MOVEMENT_WEIGHT = (1.5 * Math.PI) / 180;
const DEFAULT_OWNER_WEIGHT = Math.PI / 2;
const DEFAULT_MINIMUM_IMPROVEMENT = (4 * Math.PI) / 180;
const POSITION_EPSILON = 1e-6;

export function normalizeAngleRad(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized <= -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

/** Bearing from from to to in the XZ plane. */
export function threatBearingRad(from: XZ, to: XZ): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Smallest circular arc that covers every usable threat bearing.
 * Returns null only when fewer than two non-colocated threats are present.
 * Two threats on the same bearing correctly produce a zero-width arc.
 */
export function computeThreatArc(botPos: XZ, threats: XZ[]): ThreatArc | null {
  const angles: number[] = [];
  for (const threat of threats) {
    const dx = threat.x - botPos.x;
    const dz = threat.z - botPos.z;
    if (Math.hypot(dx, dz) < 0.05) continue;
    angles.push(Math.atan2(dx, dz));
  }
  if (angles.length < 2) return null;

  angles.sort((a, b) => a - b);
  let maxGap = -1;
  let gapAfterIndex = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const current = angles[index];
    const next = index + 1 < angles.length
      ? angles[index + 1]
      : angles[0] + Math.PI * 2;
    const gap = next - current;
    if (gap > maxGap) {
      maxGap = gap;
      gapAfterIndex = index;
    }
  }

  const spanRad = Math.max(0, Math.PI * 2 - maxGap);
  const start = angles[(gapAfterIndex + 1) % angles.length];
  const midRad = normalizeAngleRad(start + spanRad / 2);
  const openRad = normalizeAngleRad(midRad + Math.PI);
  return { spanRad, midRad, openRad };
}

/** Stay plus eight equally spaced candidates around the bot. */
export function generateThreatPositionCandidates(botPos: XZ, step = DEFAULT_STEP): XZ[] {
  const candidates: XZ[] = [{ ...botPos }];
  for (let index = 0; index < 8; index += 1) {
    const bearing = (index * Math.PI) / 4;
    candidates.push({
      x: botPos.x + Math.sin(bearing) * step,
      z: botPos.z + Math.cos(bearing) * step
    });
  }
  return candidates;
}

export function evaluateThreatPosition(opts: {
  origin: XZ;
  candidate: XZ;
  threats: XZ[];
  minEnemyDistance?: number;
  dangerWeight?: number;
  movementWeight?: number;
  ownerPos?: XZ | null;
  maxOwnerDistance?: number;
  ownerWeight?: number;
}): ThreatPositionEvaluation {
  const arc = computeThreatArc(opts.candidate, opts.threats);
  const spanRad = arc?.spanRad ?? 0;
  const minEnemyDistance = opts.threats.reduce((minimum, threat) => (
    Math.min(minimum, distance2(opts.candidate, threat))
  ), Infinity);
  const moveDistance = distance2(opts.origin, opts.candidate);
  const safeDistance = opts.minEnemyDistance ?? DEFAULT_MIN_ENEMY_DISTANCE;
  const dangerPenalty = Number.isFinite(minEnemyDistance)
    ? Math.max(0, safeDistance - minEnemyDistance)
      * (opts.dangerWeight ?? DEFAULT_DANGER_WEIGHT)
    : 0;
  const movementPenalty = moveDistance
    * (opts.movementWeight ?? DEFAULT_MOVEMENT_WEIGHT);

  let ownerPenalty = 0;
  if (opts.ownerPos && Number.isFinite(opts.maxOwnerDistance)) {
    const ownerDistance = distance2(opts.candidate, opts.ownerPos);
    ownerPenalty = Math.max(0, ownerDistance - (opts.maxOwnerDistance as number))
      * (opts.ownerWeight ?? DEFAULT_OWNER_WEIGHT);
  }

  return {
    position: { ...opts.candidate },
    spanRad,
    minEnemyDistance,
    moveDistance,
    dangerPenalty,
    ownerPenalty,
    movementPenalty,
    score: spanRad + dangerPenalty + ownerPenalty + movementPenalty
  };
}

/**
 * Select a nearby position with a narrower threat wedge. Angle is the primary
 * objective; danger, owner leash, movement cost, and a minimum improvement
 * prevent unsafe or jittery choices.
 */
export function chooseBestThreatPosition(
  botPos: XZ,
  threats: XZ[],
  options: ThreatPositionOptions = {}
): ThreatPositionSelection {
  const candidates = dedupePositions([
    { ...botPos },
    ...(options.candidates
      ?? generateThreatPositionCandidates(botPos, options.step).slice(1))
  ]);
  const evaluate = (candidate: XZ) => evaluateThreatPosition({
    origin: botPos,
    candidate,
    threats,
    minEnemyDistance: options.minEnemyDistance,
    dangerWeight: options.dangerWeight,
    movementWeight: options.movementWeight,
    ownerPos: options.ownerPos,
    maxOwnerDistance: options.maxOwnerDistance,
    ownerWeight: options.ownerWeight
  });
  const current = evaluate(botPos);

  // Single-target behavior remains under the existing combat spacing policy.
  if (usableThreatCount(botPos, threats) < 2) {
    return { current, chosen: current, moved: false, improvement: 0 };
  }

  let best = current;
  for (const candidate of candidates) {
    const evaluated = evaluate(candidate);
    if (evaluated.score < best.score - POSITION_EPSILON) best = evaluated;
  }

  const improvement = current.score - best.score;
  const minimumImprovement = options.minimumImprovement
    ?? DEFAULT_MINIMUM_IMPROVEMENT;
  if (improvement < minimumImprovement) {
    return { current, chosen: current, moved: false, improvement: 0 };
  }
  return { current, chosen: best, moved: best.moveDistance > POSITION_EPSILON, improvement };
}

/**
 * Convert a world bearing to movement keys for Mineflayer yaw.
 * Mineflayer yaw 0 faces -Z, while threat bearings use 0 = +Z.
 */
export function movementControlsTowardBearing(
  bearingRad: number,
  mineflayerYaw: number,
  threshold = 0.2
): BearingMovementControls {
  const facingBearing = normalizeAngleRad(mineflayerYaw + Math.PI);
  const delta = normalizeAngleRad(bearingRad - facingBearing);
  const forwardComponent = Math.cos(delta);
  const rightComponent = -Math.sin(delta);
  return {
    forward: forwardComponent > threshold,
    back: forwardComponent < -threshold,
    left: rightComponent < -threshold,
    right: rightComponent > threshold
  };
}

/** Pick one of the two world-space directions perpendicular to an incoming line. */
export function perpendicularDodgeBearing(
  threatBearing: number,
  side: 1 | -1
): number {
  return normalizeAngleRad(threatBearing + side * Math.PI / 2);
}

export function strafeSignForOpenArc(opts: {
  botPos: XZ;
  primaryPos: XZ;
  arc: ThreatArc;
  ownerPos?: XZ | null;
  ignoreOwnerLeash?: boolean;
}): 1 | -1 {
  const faceX = opts.primaryPos.x - opts.botPos.x;
  const faceZ = opts.primaryPos.z - opts.botPos.z;
  const faceLength = Math.hypot(faceX, faceZ);
  const forwardX = faceLength < POSITION_EPSILON ? 0 : faceX / faceLength;
  const forwardZ = faceLength < POSITION_EPSILON ? 1 : faceZ / faceLength;
  const leftX = -forwardZ;
  const leftZ = forwardX;
  const openX = Math.sin(opts.arc.openRad);
  const openZ = Math.cos(opts.arc.openRad);
  const arcSign: 1 | -1 = openX * leftX + openZ * leftZ >= 0 ? 1 : -1;

  if (!opts.ownerPos || opts.ignoreOwnerLeash) return arcSign;
  const step = 1.2;
  const leftPos = { x: opts.botPos.x + leftX * step, z: opts.botPos.z + leftZ * step };
  const rightPos = { x: opts.botPos.x - leftX * step, z: opts.botPos.z - leftZ * step };
  const currentDistance = distance2(opts.botPos, opts.ownerPos);
  const leftDistance = distance2(leftPos, opts.ownerPos);
  const rightDistance = distance2(rightPos, opts.ownerPos);
  const preferredDistance = arcSign === 1 ? leftDistance : rightDistance;
  const otherDistance = arcSign === 1 ? rightDistance : leftDistance;
  if (preferredDistance > currentDistance + 1.5 && otherDistance < preferredDistance - 0.4) {
    return arcSign === 1 ? -1 : 1;
  }
  return arcSign;
}

export function shouldEnterArcNarrowing(opts: {
  threatCount: number;
  spanRad: number;
}): boolean {
  return opts.threatCount >= 2 && opts.spanRad >= ENTER_ARC_NARROW_SPAN_RAD;
}

export function shouldExitArcNarrowing(spanRad: number): boolean {
  return spanRad < EXIT_ARC_NARROW_SPAN_RAD;
}

export function spanDegrees(spanRad: number): number {
  return (spanRad * 180) / Math.PI;
}

function usableThreatCount(botPos: XZ, threats: XZ[]): number {
  return threats.filter((threat) => distance2(botPos, threat) >= 0.05).length;
}

function distance2(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function dedupePositions(positions: XZ[]): XZ[] {
  const unique: XZ[] = [];
  for (const position of positions) {
    if (unique.some((other) => distance2(position, other) < POSITION_EPSILON)) continue;
    unique.push({ ...position });
  }
  return unique;
}
