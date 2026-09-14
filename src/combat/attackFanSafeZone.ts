/**
 * 敵ごとの攻撃扇と3D遮蔽に基づく安全／接近地点。
 *
 * 重要: 扇の aim を「いまの相棒」にすると、相棒は常に扇の中央にいる。
 * そのため純遠距離では「扇の外」は存在しない。
 * - 硬安全: 肉壁／地形で射線を切る点（umbra）
 * - 軟安全（接近点）: 射線に対して斜めに進む点（真正面突撃を禁止）
 */

import { classifyEnemy, type EnemyClass } from './CombatProfiles.js';

export type XZ = { x: number; z: number };

export type AttackFanThreat = XZ & {
  y?: number;
  kind?: string;
  id?: number;
};

export type AttackFanDebug = {
  apex: XZ & { y?: number };
  midRad: number;
  halfAngle: number;
  radius: number;
  leftRad: number;
  rightRad: number;
  kind: string;
  enemyClass: EnemyClass;
  blocked: boolean;
  exposed: boolean;
  coverPoint?: XZ & { y?: number } | null;
};

export type AttackFanSafeSelection = {
  safePoint: XZ;
  moved: boolean;
  nearestIndex: number;
  fans: AttackFanDebug[];
  rangedExposedCount: number;
  meleeExposedCount: number;
  coverPoint: (XZ & { y?: number }) | null;
  /** umbra=肉壁影 / skirt=斜め接近 / hold=その場 */
  mode: 'umbra' | 'skirt' | 'hold';
};

const RANGED_FAN_RADIUS = 12;
const MELEE_FAN_RADIUS = 3.2;
const AGILE_FAN_RADIUS = 3.6;
const EXPLOSIVE_FAN_RADIUS = 4.5;
const RANGED_HALF_ANGLE = (28 * Math.PI) / 180;
const MELEE_HALF_ANGLE = (55 * Math.PI) / 180;
const ENTITY_COVER_RADIUS = 1.05;
/** 遮蔽の直後（射手から見て向こう側）に置く距離。 */
const UMBRA_OFFSETS = [1.55, 2.15];
const MELEE_STRIKE_RANGE = 2.6;
const SKIRT_STEP_DODGE = 2.35;
const SKIRT_STEP_ADVANCE = 2.15;

export function normalizeAngleRad(angle: number): number {
  let value = angle;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}

export function threatBearingRad(from: XZ, to: XZ): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function attackFanRadius(kind: string | null | undefined): number {
  const cls = classifyEnemy(kind);
  if (cls === 'ranged') return RANGED_FAN_RADIUS;
  if (cls === 'explosive') return EXPLOSIVE_FAN_RADIUS;
  if (cls === 'agile') return AGILE_FAN_RADIUS;
  return MELEE_FAN_RADIUS;
}

export function attackFanHalfAngle(kind: string | null | undefined): number {
  return classifyEnemy(kind) === 'ranged' ? RANGED_HALF_ANGLE : MELEE_HALF_ANGLE;
}

function dist2(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function withY(point: XZ & { y?: number }, fallback = 1): XZ & { y: number } {
  return { x: point.x, y: point.y ?? fallback, z: point.z };
}

function pointFrom(origin: XZ, bearing: number, amount: number): XZ {
  return {
    x: origin.x + Math.sin(bearing) * amount,
    z: origin.z + Math.cos(bearing) * amount
  };
}

/**
 * 射手が point を攻撃できるか（硬判定）。
 * 遠距離: 距離内かつ他敵／地形が先なら影で非露出。
 * 近接: 距離内なら露出。
 */
export function isPointExposedToEnemy(opts: {
  enemy: AttackFanThreat;
  point: AttackFanThreat;
  others: AttackFanThreat[];
  terrainBlocked?: boolean;
}): { exposed: boolean; blocked: boolean; coverPoint: (XZ & { y?: number }) | null } {
  const enemy = opts.enemy;
  const point = opts.point;
  const radius = attackFanRadius(enemy.kind);
  const distance = dist2(enemy, point);
  if (distance > radius + 1e-6 || distance < 0.05) {
    return { exposed: false, blocked: false, coverPoint: null };
  }

  const enemyClass = classifyEnemy(enemy.kind);
  if (enemyClass !== 'ranged') {
    return { exposed: true, blocked: false, coverPoint: null };
  }

  if (opts.terrainBlocked) {
    return { exposed: false, blocked: true, coverPoint: null };
  }
  const cover = findEntityCoverOnSegment(enemy, point, opts.others);
  if (cover) {
    return { exposed: false, blocked: true, coverPoint: cover };
  }
  return { exposed: true, blocked: false, coverPoint: null };
}

export function isPointInAttackFan(opts: {
  enemy: AttackFanThreat;
  aim: XZ;
  point: XZ;
}): boolean {
  const radius = attackFanRadius(opts.enemy.kind);
  const half = attackFanHalfAngle(opts.enemy.kind);
  const distance = dist2(opts.enemy, opts.point);
  if (distance > radius + 1e-6) return false;
  const aimBearing = threatBearingRad(opts.enemy, opts.aim);
  const pointBearing = threatBearingRad(opts.enemy, opts.point);
  return Math.abs(normalizeAngleRad(pointBearing - aimBearing)) <= half + 1e-6;
}

function findEntityCoverOnSegment(
  from: AttackFanThreat,
  to: AttackFanThreat,
  others: AttackFanThreat[]
): (XZ & { y?: number }) | null {
  const from3 = withY(from);
  const to3 = withY(to);
  const dx = to3.x - from3.x;
  const dy = to3.y - from3.y;
  const dz = to3.z - from3.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.4) return null;
  let bestT = Infinity;
  let best: (XZ & { y?: number }) | null = null;
  for (const other of others) {
    if (other.id != null && from.id != null && other.id === from.id) continue;
    const body = { x: other.x, y: (other.y ?? 1) + 0.9, z: other.z };
    const t = projectT(from3, to3, body);
    if (t < 0.08 || t > 0.92) continue;
    const closest = {
      x: from3.x + dx * t,
      y: from3.y + dy * t,
      z: from3.z + dz * t
    };
    if (Math.hypot(closest.x - body.x, closest.z - body.z) > ENTITY_COVER_RADIUS) {
      continue;
    }
    if (t < bestT) {
      bestT = t;
      best = { x: other.x, y: other.y, z: other.z };
    }
  }
  return best;
}

function projectT(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  point: { x: number; y: number; z: number }
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-8) return 0;
  return ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / lenSq;
}

/** 射手→遮蔽の延長上、遮蔽の向こう側（肉壁の影）。 */
export function umbraAnchor(
  shooter: XZ,
  blocker: XZ,
  offset: number
): XZ {
  const bearing = threatBearingRad(shooter, blocker);
  return {
    x: blocker.x + Math.sin(bearing) * offset,
    z: blocker.z + Math.cos(bearing) * offset
  };
}

export function describeAttackFan(
  enemy: AttackFanThreat,
  aim: XZ,
  opts: {
    others: AttackFanThreat[];
    point?: XZ;
    terrainBlocked?: boolean;
  }
): AttackFanDebug {
  const midRad = threatBearingRad(enemy, aim);
  const halfAngle = attackFanHalfAngle(enemy.kind);
  const radius = attackFanRadius(enemy.kind);
  const point = opts.point ?? aim;
  const exposure = isPointExposedToEnemy({
    enemy,
    point: { ...point, y: (point as AttackFanThreat).y ?? enemy.y },
    others: opts.others,
    terrainBlocked: opts.terrainBlocked
  });
  const inFan = isPointInAttackFan({ enemy, aim, point });
  const enemyClass = classifyEnemy(enemy.kind);
  const blocked = Boolean(exposure.blocked || opts.terrainBlocked);
  return {
    apex: { x: enemy.x, y: enemy.y, z: enemy.z },
    midRad,
    halfAngle,
    radius,
    leftRad: normalizeAngleRad(midRad - halfAngle),
    rightRad: normalizeAngleRad(midRad + halfAngle),
    kind: enemy.kind || 'unknown',
    enemyClass,
    blocked,
    exposed: enemyClass === 'ranged'
      ? exposure.exposed
      : (inFan && exposure.exposed),
    coverPoint: exposure.coverPoint
  };
}

function countFanExposure(
  point: XZ & { y?: number },
  threats: AttackFanThreat[],
  terrainBlockedBetween: (from: AttackFanThreat, to: XZ) => boolean
): {
  rangedExposed: number;
  meleeExposed: number;
  meleeNear: number;
  coverPoint: (XZ & { y?: number }) | null;
  fans: AttackFanDebug[];
} {
  let rangedExposed = 0;
  let meleeExposed = 0;
  let meleeNear = 0;
  let coverPoint: (XZ & { y?: number }) | null = null;
  const fans: AttackFanDebug[] = [];
  for (const enemy of threats) {
    const others = threats.filter((item) => item !== enemy);
    const terrainBlocked = terrainBlockedBetween(enemy, point);
    const fan = describeAttackFan(enemy, point, {
      others,
      point,
      terrainBlocked
    });
    fans.push(fan);
    if (fan.enemyClass === 'ranged') {
      if (fan.exposed) rangedExposed += 1;
      if (!coverPoint && fan.coverPoint) coverPoint = fan.coverPoint;
    } else {
      if (fan.exposed) meleeExposed += 1;
      if (dist2(point, enemy) <= MELEE_STRIKE_RANGE) meleeNear += 1;
    }
  }
  return { rangedExposed, meleeExposed, meleeNear, coverPoint, fans };
}

/** 射手→近接遮蔽の影（表示・保持用）。 */
export function primaryMeatWallUmbra(threats: AttackFanThreat[], offset = 1.55): XZ | null {
  const ranged = threats.find((threat) => classifyEnemy(threat.kind) === 'ranged');
  const blocker = threats.find((threat) => {
    const cls = classifyEnemy(threat.kind);
    return cls !== 'ranged' && cls !== 'explosive';
  });
  if (!ranged || !blocker) return null;
  return umbraAnchor(ranged, blocker, offset);
}

function generateUmbraCandidates(threats: AttackFanThreat[]): XZ[] {
  const ranged = threats.filter((threat) => classifyEnemy(threat.kind) === 'ranged');
  const blockers = threats.filter((threat) => classifyEnemy(threat.kind) !== 'ranged');
  const out: XZ[] = [];
  for (const shooter of ranged) {
    for (const blocker of blockers) {
      for (const offset of UMBRA_OFFSETS) {
        out.push(umbraAnchor(shooter, blocker, offset));
      }
    }
  }
  return dedupe(out);
}

function dedupe(positions: XZ[]): XZ[] {
  const unique: XZ[] = [];
  for (const position of positions) {
    if (unique.some((other) => dist2(other, position) < 0.4)) continue;
    unique.push({ ...position });
  }
  return unique;
}

/**
 * 射線に対して斜めに進む点。真正面（destVsEnemy≈0）を禁止する。
 * dodge: 横移動強め / advance: 前進しつつ斜めを残す。
 */
export function chooseRangedSkirtPoint(
  botPos: XZ,
  focus: XZ,
  options: {
    side?: 1 | -1;
    mode?: 'dodge' | 'advance';
  } = {}
): XZ {
  const side = options.side ?? 1;
  const mode = options.mode ?? 'advance';
  const toFocus = threatBearingRad(botPos, focus);
  const perp = toFocus + side * Math.PI / 2;
  const dist = dist2(botPos, focus);
  const strafeWeight = mode === 'dodge'
    ? 0.82
    : (dist > MELEE_STRIKE_RANGE * 2.2 ? 0.38 : 0.48);
  const closeWeight = 1 - strafeWeight;
  const blended = Math.atan2(
    Math.sin(perp) * strafeWeight + Math.sin(toFocus) * closeWeight,
    Math.cos(perp) * strafeWeight + Math.cos(toFocus) * closeWeight
  );
  const step = mode === 'dodge' ? SKIRT_STEP_DODGE : SKIRT_STEP_ADVANCE;
  return pointFrom(botPos, blended, step);
}

/**
 * 攻撃扇ベースの安全／接近点。
 * 肉壁があれば影へ。なければ斜め接近点（緑箱＝移動目標）。
 */
export function chooseAttackFanSafePoint(
  botPos: XZ & { y?: number },
  threats: AttackFanThreat[],
  options: {
    stickyNearestIndex?: number | null;
    stickySafePoint?: XZ | null;
    ownerPos?: XZ | null;
    maxOwnerDistance?: number;
    isTerrainBlocked?: (from: AttackFanThreat, to: XZ & { y?: number }) => boolean;
    minEnemyDistance?: number;
    skirtSide?: 1 | -1;
    skirtMode?: 'dodge' | 'advance';
  } = {}
): AttackFanSafeSelection | null {
  if (threats.length < 1) return null;
  const terrainBlockedBetween = (from: AttackFanThreat, to: XZ) => (
    options.isTerrainBlocked
      ? Boolean(options.isTerrainBlocked(from, { ...to, y: botPos.y ?? from.y ?? 1 }))
      : false
  );

  let nearestIndex = 0;
  let nearestDist = Infinity;
  for (let index = 0; index < threats.length; index += 1) {
    const d = dist2(botPos, threats[index]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIndex = index;
    }
  }
  if (
    options.stickyNearestIndex != null
    && options.stickyNearestIndex >= 0
    && options.stickyNearestIndex < threats.length
  ) {
    const stickyDist = dist2(botPos, threats[options.stickyNearestIndex]);
    if (stickyDist <= nearestDist + 0.85) nearestIndex = options.stickyNearestIndex;
  }

  const currentEval = countFanExposure(botPos, threats, terrainBlockedBetween);
  const hasRanged = threats.some((threat) => classifyEnemy(threat.kind) === 'ranged');
  const rangedFocus = threats.find((threat) => classifyEnemy(threat.kind) === 'ranged')
    ?? threats[nearestIndex];

  // 純近接でも攻撃扇露出は数える（狭窄の入力）。umbra/skirt は遠距離専用。
  if (!hasRanged) {
    return {
      safePoint: { x: botPos.x, z: botPos.z },
      moved: false,
      nearestIndex,
      fans: currentEval.fans,
      rangedExposedCount: 0,
      meleeExposedCount: currentEval.meleeExposed,
      coverPoint: null,
      mode: 'hold'
    };
  }

  const umbraHold = primaryMeatWallUmbra(threats);
  const umbraCandidates = generateUmbraCandidates(threats);
  if (options.stickySafePoint) umbraCandidates.push({ ...options.stickySafePoint });
  if (umbraHold) umbraCandidates.unshift(umbraHold);

  let bestUmbra: XZ | null = null;
  let bestUmbraCost = Infinity;
  let bestUmbraEval = currentEval;
  for (const candidate of umbraCandidates) {
    const evaluated = countFanExposure(
      { ...candidate, y: botPos.y },
      threats,
      terrainBlockedBetween
    );
    if (evaluated.rangedExposed > 0) continue;
    const melee = threats.find((threat) => classifyEnemy(threat.kind) !== 'ranged') || candidate;
    const cost = dist2(botPos, candidate) * 0.3
      + Math.max(0, dist2(candidate, melee) - MELEE_STRIKE_RANGE) * 3;
    if (cost + 1e-6 < bestUmbraCost) {
      bestUmbraCost = cost;
      bestUmbra = { ...candidate };
      bestUmbraEval = evaluated;
    }
  }

  if (bestUmbra && currentEval.rangedExposed > 0) {
    return {
      safePoint: bestUmbra,
      moved: dist2(botPos, bestUmbra) > 0.4,
      nearestIndex,
      fans: currentEval.fans,
      rangedExposedCount: currentEval.rangedExposed,
      meleeExposedCount: currentEval.meleeExposed,
      coverPoint: bestUmbraEval.coverPoint ?? currentEval.coverPoint,
      mode: 'umbra'
    };
  }

  if (currentEval.rangedExposed === 0 && umbraHold) {
    return {
      safePoint: umbraHold,
      moved: false,
      nearestIndex,
      fans: currentEval.fans,
      rangedExposedCount: 0,
      meleeExposedCount: currentEval.meleeExposed,
      coverPoint: currentEval.coverPoint,
      mode: 'umbra'
    };
  }

  const side = options.skirtSide ?? 1;
  let skirt = chooseRangedSkirtPoint(botPos, rangedFocus, {
    side,
    mode: options.skirtMode ?? 'advance'
  });
  if (options.ownerPos && Number.isFinite(options.maxOwnerDistance)) {
    if (dist2(skirt, options.ownerPos) > (options.maxOwnerDistance as number) + 2) {
      const away = threatBearingRad(options.ownerPos, skirt);
      skirt = pointFrom(options.ownerPos, away, (options.maxOwnerDistance as number) * 0.85);
    }
  }

  return {
    safePoint: skirt,
    moved: dist2(botPos, skirt) > 0.35,
    nearestIndex,
    fans: currentEval.fans,
    rangedExposedCount: currentEval.rangedExposed,
    meleeExposedCount: currentEval.meleeExposed,
    coverPoint: currentEval.coverPoint,
    mode: 'skirt'
  };
}
