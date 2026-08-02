/**
 * 水平方向の複数脅威に対する純粋なルールベース位置取り。
 *
 * 方位は atan2(dx, dz) を使い、0が+Z、+PI/2が+Xを向く。
 * Mineflayerのyawは前方の定義が逆なので、移動キーへ変換する呼び出し側は
 * movementControlsTowardBearing() を使うこと。
 */

export type XZ = { x: number; z: number };

export type ThreatArc = {
  /** 有効な全脅威方位を含む最小円弧。 */
  spanRad: number;
  /** 脅威集団を向く包含円弧の中央方位。 */
  midRad: number;
  /** 集団中央と反対側、空いている方向の方位。 */
  openRad: number;
};

export type ThreatPositionEvaluation = {
  position: XZ;
  spanRad: number;
  minEnemyDistance: number;
  pathMinEnemyDistance: number;
  moveDistance: number;
  dangerPenalty: number;
  pathDangerPenalty: number;
  ownerPenalty: number;
  movementPenalty: number;
  score: number;
};

export type ThreatPositionOptions = {
  /** 明示候補がない場合に使う候補間隔。 */
  step?: number;
  /** いずれかの敵からこの距離未満の候補を避ける。 */
  minEnemyDistance?: number;
  /** 最小敵距離を下回った1ブロック当たりの評価減点（rad）。 */
  dangerWeight?: number;
  /** 同点を解消するための、移動1ブロック当たりの小さなコスト。 */
  movementWeight?: number;
  ownerPos?: XZ | null;
  /** 緩いowner leash。この半径を超える候補を減点する。 */
  maxOwnerDistance?: number;
  /** owner最大距離を超えた1ブロック当たりの評価減点（rad）。 */
  ownerWeight?: number;
  /** 小さすぎる、またはノイズ相当の改善では移動しない。 */
  minimumImprovement?: number;
  /** 任意の事前選別済みワールド座標（現在地は常に追加する）。 */
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

/** 理想とする脅威扇形の最大角。 */
export const TARGET_THREAT_SPAN_RAD = (35 * Math.PI) / 180;
/** 通常の横移動より位置取りを優先する広い挟撃角。 */
export const WIDE_THREAT_SPAN_RAD = (90 * Math.PI) / 180;
/** 開始・終了閾値で円弧位置取りにヒステリシスを持たせる。 */
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

/** XZ平面上で from から to へ向かう方位。 */
export function threatBearingRad(from: XZ, to: XZ): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * 有効な全脅威方位を含む最小円弧。
 * 同一点でない脅威が2体未満の場合だけ null を返す。
 * 同じ方位にいる2脅威は、正しく幅0の円弧になる。
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

/** 現在地と、Bot周囲に等間隔で置いた8候補。 */
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

/**
 * 広域戦術候補。同心円と、脅威集団の外端を越えた地点を生成する。
 * 後者により、小さな横移動のspan改善で妥協せず、敵列の片端より
 * 外側へ回り込める。
 */
export function generateStrategicThreatPositionCandidates(
  botPos: XZ,
  threats: XZ[],
  step = DEFAULT_STEP,
  minEnemyDistance = DEFAULT_MIN_ENEMY_DISTANCE
): XZ[] {
  const rings = [1, 2, 3].flatMap((multiplier) => (
    generateThreatPositionCandidates(botPos, step * multiplier).slice(1)
  ));
  const centroid = threats.reduce((sum, threat) => ({
    x: sum.x + threat.x / threats.length,
    z: sum.z + threat.z / threats.length
  }), { x: 0, z: 0 });
  const extensionDistance = minEnemyDistance + 0.5;
  const extensions: XZ[] = [];
  for (const threat of threats) {
    const dx = threat.x - centroid.x;
    const dz = threat.z - centroid.z;
    const length = Math.hypot(dx, dz);
    if (length < POSITION_EPSILON) continue;
    extensions.push({
      x: threat.x + (dx / length) * extensionDistance,
      z: threat.z + (dz / length) * extensionDistance
    });
  }
  return dedupePositions([{ ...botPos }, ...rings, ...extensions]);
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
  const pathMinEnemyDistance = opts.threats.reduce((minimum, threat) => (
    Math.min(minimum, distanceToSegment(threat, opts.origin, opts.candidate))
  ), Infinity);
  const moveDistance = distance2(opts.origin, opts.candidate);
  const safeDistance = opts.minEnemyDistance ?? DEFAULT_MIN_ENEMY_DISTANCE;
  const dangerPenalty = Number.isFinite(minEnemyDistance)
    ? Math.max(0, safeDistance - minEnemyDistance)
      * (opts.dangerWeight ?? DEFAULT_DANGER_WEIGHT)
    : 0;
  const pathDangerPenalty = Number.isFinite(pathMinEnemyDistance)
    ? Math.max(0, safeDistance - pathMinEnemyDistance)
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
    pathMinEnemyDistance,
    moveDistance,
    dangerPenalty,
    pathDangerPenalty,
    ownerPenalty,
    movementPenalty,
    score: spanRad + dangerPenalty + pathDangerPenalty + ownerPenalty + movementPenalty
  };
}

/**
 * 脅威扇形が狭くなる位置を選ぶ。角度を主評価とし、危険度、owner leash、
 * 移動コスト、最小改善量によって危険な選択や細かな揺れを防ぐ。
 */
export function chooseBestThreatPosition(
  botPos: XZ,
  threats: XZ[],
  options: ThreatPositionOptions = {}
): ThreatPositionSelection {
  const candidates = dedupePositions([
    { ...botPos },
    ...(options.candidates
      ?? generateStrategicThreatPositionCandidates(
        botPos,
        threats,
        options.step,
        options.minEnemyDistance
      ).slice(1))
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

  // 単一対象の挙動は既存の戦闘間合い方針に任せる。
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

function distanceToSegment(point: XZ, start: XZ, end: XZ): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < POSITION_EPSILON) return distance2(point, start);
  const projection = Math.max(0, Math.min(1, (
    (point.x - start.x) * dx + (point.z - start.z) * dz
  ) / lengthSquared));
  return Math.hypot(
    point.x - (start.x + projection * dx),
    point.z - (start.z + projection * dz)
  );
}

/**
 * ワールド方位をMineflayer yaw基準の移動キーへ変換する。
 * Mineflayerのyaw 0は-Zを向くが、脅威方位の0は+Zを向く。
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

/** 入射方向と直交するワールド座標上の2方向から一方を選ぶ。 */
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

/**
 * 扇形が既に狭くても chooseBestThreatPosition が改善位置を返したら移動する。
 */
export function shouldApplyTacticalReposition(
  threatCount: number,
  selection: ThreatPositionSelection | null | undefined
): boolean {
  return threatCount >= 2 && Boolean(selection?.moved && selection.chosen?.position);
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
