/**
 * 水平方向の複数脅威に対する純粋なルールベース位置取り。
 *
 * 方位は atan2(dx, dz) を使い、0が+Z、+PI/2が+Xを向く。
 * Mineflayerのyawは前方の定義が逆なので、移動キーへ変換する呼び出し側は
 * movementControlsTowardBearing() を使うこと。
 */

import { classifyEnemy } from './CombatProfiles.js';
import {
  chooseAttackFanSafePoint,
  type AttackFanDebug,
  type AttackFanThreat
} from './attackFanSafeZone.js';

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

/** 理想とする脅威扇形の最大角（デフォルト。実運用はプリセットの arcNarrow* を使う）。 */
export const TARGET_THREAT_SPAN_RAD = (35 * Math.PI) / 180;
/** 通常の横移動より位置取りを優先する広い挟撃角。 */
export const WIDE_THREAT_SPAN_RAD = (90 * Math.PI) / 180;
/** 開始・終了閾値のデフォルト（プリセット未指定時）。 */
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

export type ArcNarrowThresholds = {
  /** これ以上でラッチ開始（rad）。 */
  enterSpanRad?: number;
  /** これ未満でラッチ解除（rad）。 */
  exitSpanRad?: number;
};

export function shouldEnterArcNarrowing(opts: {
  threatCount: number;
  spanRad: number;
  enterSpanRad?: number;
}): boolean {
  const enter = opts.enterSpanRad ?? ENTER_ARC_NARROW_SPAN_RAD;
  return opts.threatCount >= 2 && opts.spanRad >= enter;
}

export function shouldExitArcNarrowing(
  spanRad: number,
  exitSpanRad: number = EXIT_ARC_NARROW_SPAN_RAD
): boolean {
  return spanRad < exitSpanRad;
}

/**
 * 扇狭窄のヒステリシス。一度入ったら exit まで位置取りを継続する。
 * enter/exit はプリセット学習で調整する（Reflexes / 旧経路用）。
 * 箱庭の主経路は updateArcNarrowLatchByImprovement を使う。
 */
export function updateArcNarrowLatch(opts: {
  latched: boolean;
  threatCount: number;
  spanRad: number | null | undefined;
  enterSpanRad?: number;
  exitSpanRad?: number;
}): boolean {
  if (opts.threatCount < 2 || opts.spanRad == null || !Number.isFinite(opts.spanRad)) {
    return false;
  }
  if (opts.latched) {
    return !shouldExitArcNarrowing(
      opts.spanRad,
      opts.exitSpanRad ?? EXIT_ARC_NARROW_SPAN_RAD
    );
  }
  return shouldEnterArcNarrowing({
    threatCount: opts.threatCount,
    spanRad: opts.spanRad,
    enterSpanRad: opts.enterSpanRad
  });
}

/**
 * 決定論ラッチ: 候補で扇をまだ狭められる間、または目標へ移動中だけ続ける。
 * 学習用の enter/exit 角度には依存しない。
 */
export function updateArcNarrowLatchByImprovement(opts: {
  latched: boolean;
  threatCount: number;
  selectionMoved: boolean;
  /** 位置取り目標へまだ到着していない */
  pursuingGoal?: boolean;
}): boolean {
  if (opts.threatCount < 2) return false;
  if (opts.selectionMoved || opts.pursuingGoal) return true;
  // 局所最小かつ目標なし／到着 → 解除（種別問わず扇を重ね切った）
  return false;
}

/**
 * 最寄り脅威を sticky に選ぶ。わずかな距離差では切り替えない。
 */
export function pickStickyNearestThreatIndex(
  botPos: XZ,
  threats: XZ[],
  stickyIndex: number | null | undefined,
  switchMargin = 1.75
): number {
  if (threats.length === 0) return -1;
  let bestIndex = 0;
  let bestDist = distance2(botPos, threats[0]);
  for (let index = 1; index < threats.length; index += 1) {
    const dist = distance2(botPos, threats[index]);
    if (dist + 1e-6 < bestDist) {
      bestDist = dist;
      bestIndex = index;
    }
  }
  if (
    stickyIndex != null
    && stickyIndex >= 0
    && stickyIndex < threats.length
  ) {
    const stickyDist = distance2(botPos, threats[stickyIndex]);
    if (stickyDist <= bestDist + switchMargin) return stickyIndex;
  }
  return bestIndex;
}

/**
 * 最寄り敵の周囲を回り、他敵方位を重ねるための候補。
 * （近接を壁にする／遠距離を壁にする、の両方を扇最小化で兼ねる）
 */
export function generateNearestOrbitCandidates(
  botPos: XZ,
  threats: XZ[],
  nearestIndex: number,
  minEnemyDistance = DEFAULT_MIN_ENEMY_DISTANCE
): XZ[] {
  if (nearestIndex < 0 || nearestIndex >= threats.length) return [];
  const nearest = threats[nearestIndex];
  const others = threats.filter((_, index) => index !== nearestIndex);
  const out: XZ[] = [];
  // 学習ホットパス用に候補を抑える（旧: 5半径×16方位）
  const radii = [
    Math.max(1.5, minEnemyDistance),
    Math.max(2.2, minEnemyDistance + 0.6),
    Math.max(2.9, minEnemyDistance + 1.2)
  ];
  for (const radius of radii) {
    for (let index = 0; index < 8; index += 1) {
      const bearing = (index * Math.PI) / 4;
      out.push({
        x: nearest.x + Math.sin(bearing) * radius,
        z: nearest.z + Math.cos(bearing) * radius
      });
    }
  }
  if (others.length > 0) {
    const centroid = others.reduce((sum, threat) => ({
      x: sum.x + threat.x / others.length,
      z: sum.z + threat.z / others.length
    }), { x: 0, z: 0 });
    const dx = nearest.x - centroid.x;
    const dz = nearest.z - centroid.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    for (const radius of radii) {
      out.push({ x: nearest.x + ux * radius, z: nearest.z + uz * radius });
      out.push({ x: nearest.x + ux * radius + px * 1.1, z: nearest.z + uz * radius + pz * 1.1 });
      out.push({ x: nearest.x + ux * radius - px * 1.1, z: nearest.z + uz * radius - pz * 1.1 });
    }
  }
  const toNearestX = nearest.x - botPos.x;
  const toNearestZ = nearest.z - botPos.z;
  const toLen = Math.hypot(toNearestX, toNearestZ) || 1;
  const tx = -toNearestZ / toLen;
  const tz = toNearestX / toLen;
  out.push({ x: botPos.x + tx * 2.2, z: botPos.z + tz * 2.2 });
  out.push({ x: botPos.x - tx * 2.2, z: botPos.z - tz * 2.2 });
  return dedupePositions(out);
}

export type StackThreatPositionSelection = ThreatPositionSelection & {
  nearestIndex: number;
  /** 攻撃扇ベースの安全点（遠距離非露出を優先）。 */
  safePoint?: XZ | null;
  /** 各敵の攻撃扇デバッグ（相棒／評価点向け）。 */
  attackFans?: AttackFanDebug[];
  coverPoint?: XZ & { y?: number } | null;
  rangedExposedCount: number;
  /** 近接／爆発／敏捷の攻撃扇に晒されている数 */
  meleeExposedCount: number;
};

export function chooseStackThreatPosition(
  botPos: XZ & { y?: number },
  threats: AttackFanThreat[],
  options: ThreatPositionOptions & {
    stickyNearestIndex?: number | null;
    stickySafePoint?: XZ | null;
    /** 3D地形LOS。true なら射手→点は地形で遮られる。 */
    isTerrainBlocked?: (from: AttackFanThreat, to: XZ & { y?: number }) => boolean;
    skirtSide?: 1 | -1;
    skirtMode?: 'dodge' | 'advance';
  } = {}
): StackThreatPositionSelection {
  const minEnemyDistance = options.minEnemyDistance ?? DEFAULT_MIN_ENEMY_DISTANCE;
  const evaluate = (candidate: XZ) => evaluateThreatPosition({
    origin: botPos,
    candidate,
    threats,
    minEnemyDistance,
    dangerWeight: options.dangerWeight,
    movementWeight: options.movementWeight ?? DEFAULT_MOVEMENT_WEIGHT,
    ownerPos: options.ownerPos,
    maxOwnerDistance: options.maxOwnerDistance,
    ownerWeight: options.ownerWeight
  });
  const current = evaluate(botPos);
  const nearestIndex = pickStickyNearestThreatIndex(
    botPos,
    threats,
    options.stickyNearestIndex
  );
  const empty = (): StackThreatPositionSelection => ({
    current,
    chosen: current,
    moved: false,
    improvement: 0,
    nearestIndex,
    safePoint: null,
    attackFans: [],
    coverPoint: null,
    rangedExposedCount: 0,
    meleeExposedCount: 0
  });
  if (nearestIndex < 0) {
    return empty();
  }

  const fanSafe = chooseAttackFanSafePoint(botPos, threats, {
    stickyNearestIndex: options.stickyNearestIndex,
    stickySafePoint: options.stickySafePoint,
    ownerPos: options.ownerPos,
    maxOwnerDistance: options.maxOwnerDistance,
    isTerrainBlocked: options.isTerrainBlocked,
    minEnemyDistance,
    skirtSide: options.skirtSide,
    skirtMode: options.skirtMode
  });

  const hasRanged = threats.some((threat) => classifyEnemy(threat.kind) === 'ranged');
  const rangedExposed = fanSafe?.rangedExposedCount ?? 0;
  const meleeExposed = fanSafe?.meleeExposedCount ?? 0;
  const attackFans = fanSafe?.fans ?? [];
  const coverPoint = fanSafe?.coverPoint ?? null;

  // 単体遠距離でも斜め接近点を返す（従来は count<2 で null になり真正面突撃していた）
  if (usableThreatCount(botPos, threats) < 2) {
    if (!fanSafe) return empty();
    const chosen = fanSafe.moved ? evaluate(fanSafe.safePoint) : current;
    return {
      current,
      chosen,
      moved: fanSafe.moved,
      improvement: Math.max(0, current.spanRad - chosen.spanRad),
      nearestIndex: fanSafe.nearestIndex,
      safePoint: fanSafe.safePoint,
      attackFans,
      coverPoint,
      rangedExposedCount: rangedExposed,
      meleeExposedCount: meleeExposed
    };
  }

  // 遠距離あり＋すでに非露出（肉壁）: 扇狭窄で引きずり出さない
  if (hasRanged && fanSafe && rangedExposed === 0 && fanSafe.mode === 'umbra' && !fanSafe.moved) {
    return {
      current,
      chosen: current,
      moved: false,
      improvement: 0,
      nearestIndex: fanSafe.nearestIndex,
      safePoint: fanSafe.safePoint,
      attackFans,
      coverPoint,
      rangedExposedCount: 0,
      meleeExposedCount: meleeExposed
    };
  }

  const preferAttackFanSafe = Boolean(
    fanSafe
    && hasRanged
    && (rangedExposed > 0 || fanSafe.moved || fanSafe.mode === 'skirt')
  );

  // 斜め接近は扇狭窄ラッチの対象外（毎tick moved で位置取り固定化しない）
  if (preferAttackFanSafe && fanSafe && fanSafe.mode === 'skirt') {
    return {
      current,
      chosen: current,
      moved: false,
      improvement: 0,
      nearestIndex: fanSafe.nearestIndex,
      safePoint: fanSafe.safePoint,
      attackFans,
      coverPoint,
      rangedExposedCount: rangedExposed,
      meleeExposedCount: meleeExposed
    };
  }

  let targetPoint: XZ | null = null;
  // CORE: 扇が広いときは遠／近を問わず「最寄りへ回り込み」で狭窄。
  // umbra へ一直線／遠距離側への広域探索は挟まれ180°で原則を壊す。
  const spanWideForOrbit = current.spanRad > (55 * Math.PI) / 180;
  if (preferAttackFanSafe && fanSafe && !spanWideForOrbit) {
    targetPoint = fanSafe.safePoint;
  } else if (spanWideForOrbit) {
    const orbitCandidates = generateNearestOrbitCandidates(
      botPos,
      threats,
      nearestIndex,
      minEnemyDistance
    );
    const spanSelection = chooseBestThreatPosition(botPos, threats, {
      ...options,
      candidates: orbitCandidates
    });
    if (spanSelection.moved) {
      targetPoint = spanSelection.chosen.position;
    } else if (preferAttackFanSafe && fanSafe) {
      targetPoint = fanSafe.safePoint;
    }
  } else {
    const spanSelection = chooseBestThreatPosition(botPos, threats, options);
    if (spanSelection.moved) {
      targetPoint = spanSelection.chosen.position;
    } else if (preferAttackFanSafe && fanSafe) {
      targetPoint = fanSafe.safePoint;
    }
  }

  const safePoint = fanSafe?.safePoint
    ?? (targetPoint ? { ...targetPoint } : null);

  if (!targetPoint) {
    return {
      current,
      chosen: current,
      moved: false,
      improvement: 0,
      nearestIndex: fanSafe?.nearestIndex ?? nearestIndex,
      safePoint,
      attackFans,
      coverPoint,
      rangedExposedCount: rangedExposed,
      meleeExposedCount: meleeExposed
    };
  }

  const chosen = evaluate(targetPoint);
  const improvement = current.spanRad - chosen.spanRad;
  return {
    current,
    chosen,
    moved: chosen.moveDistance > POSITION_EPSILON,
    improvement: Math.max(0, improvement),
    nearestIndex: fanSafe?.nearestIndex ?? nearestIndex,
    safePoint: safePoint ?? { ...targetPoint },
    attackFans,
    coverPoint,
    rangedExposedCount: rangedExposed,
    meleeExposedCount: meleeExposed
  };
}

/**
 * 最寄り敵を中心に円弧を描きながら半径を縮めて目標へ寄る1ステップ。
 * 直線接近で射線に乗り続けるのを避ける。
 */
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
