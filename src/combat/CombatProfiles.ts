/**
 * 敵分類と安全なプリセットを定める純粋な戦闘方針。
 * コンテキストは敵クラス×盾の有無のみ（敵数バケットは使わない）。
 */

export type EnemyClass = 'melee' | 'agile' | 'ranged' | 'explosive';

export type CombatContext = {
  enemyClass: EnemyClass;
  hasShield: boolean;
};

export type CombatPresetParams = {
  followRange: number;
  kiteFollowRange: number;
  backstepRange: number;
  strafeRange: number;
  strafeFacingThreshold: number;
  rangedBackFacingThreshold: number;
  rangedBackRange: number;
  strafeSwitchMs: number;
  creeperSoftEvadeRange: number;
  creeperFollowRange: number;
  /** 対象切り替えを許可するまで、現在の対象を維持する時間。 */
  focusStickyMs: number;
  /** 引き撃ち時に敵集団の重心から離れる度合い（0～1）。 */
  crowdAvoidBias: number;
  /** ワールド座標上で行う1回の遠距離回避バーストの最大時間。 */
  rangedDodgeBurstMs: number;
  /** 各回避バースト後に確保する明示的な攻撃・前進時間。 */
  rangedDodgeReassessMs: number;
  /** 盾を構える遠距離脅威数の閾値。 */
  guardRangedThreatThreshold: number;
  /** 位置取りを開始するために必要な候補評価の最小改善量。 */
  positioningImprovementMarginDeg: number;
};

export type CombatPresetId = string;

export type SpacingDecision = {
  followRange: number;
  needStrafe: boolean;
  needBackstep: boolean;
};

const RANGED_NAMES = new Set([
  'skeleton',
  'stray',
  'bogged',
  'pillager',
  'witch',
  'blaze'
]);

const AGILE_NAMES = new Set([
  'spider',
  'cave_spider',
  'enderman',
  'vex'
]);

const EXPLOSIVE_NAMES = new Set([
  'creeper',
  'ghast'
]);

/** 最適化器が絶対に越えてはならない安全範囲。 */
export const PRESET_BOUNDS: {
  [K in keyof CombatPresetParams]: { min: number; max: number };
} = {
  followRange: { min: 1.0, max: 3.2 },
  kiteFollowRange: { min: 2.2, max: 5.0 },
  backstepRange: { min: 1.2, max: 2.6 },
  strafeRange: { min: 2.0, max: 4.5 },
  strafeFacingThreshold: { min: 0.4, max: 0.95 },
  rangedBackFacingThreshold: { min: 0.5, max: 0.95 },
  rangedBackRange: { min: 1.6, max: 3.5 },
  strafeSwitchMs: { min: 350, max: 1200 },
  creeperSoftEvadeRange: { min: 2.5, max: 5.5 },
  creeperFollowRange: { min: 3.5, max: 6.5 },
  focusStickyMs: { min: 400, max: 5000 },
  crowdAvoidBias: { min: 0, max: 1 },
  rangedDodgeBurstMs: { min: 250, max: 1000 },
  rangedDodgeReassessMs: { min: 750, max: 3000 },
  guardRangedThreatThreshold: { min: 1, max: 3 },
  positioningImprovementMarginDeg: { min: 1, max: 15 }
};

const MELEE_BASELINE: CombatPresetParams = {
  followRange: 2.4,
  kiteFollowRange: 3.4,
  backstepRange: 1.7,
  strafeRange: 2.8,
  strafeFacingThreshold: 0.7,
  rangedBackFacingThreshold: 0.85,
  rangedBackRange: 2.2,
  strafeSwitchMs: 650,
  creeperSoftEvadeRange: 3.2,
  creeperFollowRange: 4.5,
  focusStickyMs: 900,
  crowdAvoidBias: 0.15,
  rangedDodgeBurstMs: 650,
  rangedDodgeReassessMs: 1500,
  guardRangedThreatThreshold: 1,
  positioningImprovementMarginDeg: 4
};

function cloneParams(params: CombatPresetParams): CombatPresetParams {
  return { ...params };
}

function adjust(
  base: CombatPresetParams,
  patch: Partial<CombatPresetParams>
): CombatPresetParams {
  return clampPreset({ ...base, ...patch });
}

/**
 * IDをキーとする組み込みプリセット。各コンテキストは少数の候補に対応する。
 */
const PRESETS: Record<CombatPresetId, CombatPresetParams> = {
  'melee-baseline': MELEE_BASELINE,
  'melee-aggressive': adjust(MELEE_BASELINE, {
    followRange: 2.0,
    kiteFollowRange: 2.8,
    backstepRange: 1.4,
    strafeRange: 2.4,
    focusStickyMs: 1200,
    crowdAvoidBias: 0.05
  }),
  'melee-defensive': adjust(MELEE_BASELINE, {
    followRange: 2.8,
    kiteFollowRange: 4.0,
    backstepRange: 2.0,
    strafeRange: 3.2,
    strafeSwitchMs: 500,
    focusStickyMs: 700,
    crowdAvoidBias: 0.35
  }),

  'agile-baseline': adjust(MELEE_BASELINE, {
    followRange: 2.2,
    kiteFollowRange: 3.2,
    backstepRange: 1.6,
    strafeRange: 3.0,
    strafeSwitchMs: 500,
    focusStickyMs: 800,
    crowdAvoidBias: 0.25
  }),

  'ranged-baseline': adjust(MELEE_BASELINE, {
    followRange: 2.2,
    kiteFollowRange: 3.6,
    backstepRange: 1.5,
    strafeRange: 3.2,
    rangedBackRange: 2.8,
    strafeSwitchMs: 550,
    focusStickyMs: 1000,
    crowdAvoidBias: 0.2
  }),
  'ranged-shield-push': adjust(MELEE_BASELINE, {
    followRange: 1.2,
    kiteFollowRange: 2.4,
    backstepRange: 1.4,
    strafeRange: 2.8,
    rangedBackRange: 2.0,
    focusStickyMs: 1400,
    crowdAvoidBias: 0.1,
    rangedDodgeBurstMs: 400,
    rangedDodgeReassessMs: 1800,
    guardRangedThreatThreshold: 2,
    positioningImprovementMarginDeg: 5
  }),

  'explosive-baseline': adjust(MELEE_BASELINE, {
    followRange: 4.5,
    kiteFollowRange: 5.0,
    backstepRange: 2.4,
    strafeRange: 3.5,
    creeperSoftEvadeRange: 3.2,
    creeperFollowRange: 4.5,
    focusStickyMs: 700,
    crowdAvoidBias: 0.4
  }),
  'explosive-wide': adjust(MELEE_BASELINE, {
    followRange: 5.0,
    kiteFollowRange: 5.0,
    backstepRange: 2.5,
    strafeRange: 4.0,
    creeperSoftEvadeRange: 4.0,
    creeperFollowRange: 5.5,
    focusStickyMs: 600,
    crowdAvoidBias: 0.55
  })
};

const CONTEXT_PRESETS: Record<string, CombatPresetId[]> = {
  'melee|0': ['melee-baseline', 'melee-aggressive', 'melee-defensive'],
  'melee|1': ['melee-baseline', 'melee-aggressive', 'melee-defensive'],
  'agile|0': ['agile-baseline', 'melee-defensive'],
  'agile|1': ['agile-baseline', 'melee-defensive'],
  'ranged|0': ['ranged-baseline', 'melee-defensive'],
  'ranged|1': ['ranged-baseline', 'ranged-shield-push'],
  'explosive|0': ['explosive-baseline', 'explosive-wide'],
  'explosive|1': ['explosive-baseline', 'explosive-wide']
};

export function classifyEnemy(name: string | null | undefined): EnemyClass {
  if (!name) return 'melee';
  const raw = name.includes(':') ? name.split(':').pop()! : name;
  const base = raw.toLowerCase();
  if (EXPLOSIVE_NAMES.has(base)) return 'explosive';
  if (RANGED_NAMES.has(base)) return 'ranged';
  if (AGILE_NAMES.has(base)) return 'agile';
  return 'melee';
}

export function isRangedEntity(
  entity: { name?: string; displayName?: string } | null | undefined
): boolean {
  if (!entity) return false;
  return classifyEnemy(entity.name) === 'ranged'
    || classifyEnemy(entity.displayName) === 'ranged';
}

export function contextKey(ctx: CombatContext): string {
  return `${ctx.enemyClass}|${ctx.hasShield ? 1 : 0}`;
}

export function baselinePresetId(ctx: CombatContext): CombatPresetId {
  const ids = listPresetsForContext(ctx);
  return ids[0];
}

export function listPresetsForContext(ctx: CombatContext): CombatPresetId[] {
  const key = contextKey(ctx);
  return CONTEXT_PRESETS[key] || ['melee-baseline'];
}

export function getPresetParams(presetId: CombatPresetId): CombatPresetParams {
  const found = PRESETS[presetId];
  if (!found) return clampPreset(cloneParams(MELEE_BASELINE));
  return clampPreset(cloneParams(found));
}

export function clampPreset(params: CombatPresetParams): CombatPresetParams {
  const out = { ...params };
  for (const key of Object.keys(PRESET_BOUNDS) as (keyof CombatPresetParams)[]) {
    const { min, max } = PRESET_BOUNDS[key];
    const value = Number(out[key]);
    out[key] = Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : min;
  }
  return out;
}

export function isRangedClass(enemyClass: EnemyClass): boolean {
  return enemyClass === 'ranged';
}

export function isExplosiveClass(enemyClass: EnemyClass): boolean {
  return enemyClass === 'explosive';
}

/**
 * 有効なプリセットからPVP経路探索の followRange を選ぶ。
 */
export function resolveFollowRange(
  params: CombatPresetParams,
  enemyClass: EnemyClass,
  distance: number
): number {
  if (enemyClass === 'ranged') return params.kiteFollowRange;
  return distance <= params.backstepRange
    ? params.kiteFollowRange
    : params.followRange;
}

/**
 * 配置とプリセットから横移動・後退の要否を決める。
 */
export function decideSpacing(opts: {
  params: CombatPresetParams;
  enemyClass: EnemyClass;
  distance: number;
  enemyFacingBot: number | null;
}): SpacingDecision {
  const { params, enemyClass, distance, enemyFacingBot } = opts;
  const facing = enemyFacingBot;
  const exposed = distance <= params.strafeRange
    && (facing == null || facing >= params.strafeFacingThreshold);
  const needStrafe = enemyClass === 'ranged'
    || exposed
    || distance <= params.backstepRange;
  const needBackstep = distance <= params.backstepRange
    || (
      enemyClass === 'ranged'
      && distance <= params.rangedBackRange
      && (facing == null || facing >= params.rangedBackFacingThreshold)
    );

  return {
    followRange: resolveFollowRange(params, enemyClass, distance),
    needStrafe,
    needBackstep
  };
}

/**
 * 後退方向へ、近傍敵の重心から離れる方向を混ぜる。
 * bias=0 は対象から真っすぐ離れ、bias=1 は空いている方向だけを使う。
 */
export function blendCrowdAvoidDirection(opts: {
  awayFromTarget: { x: number; z: number };
  awayFromCrowd: { x: number; z: number } | null;
  bias: number;
}): { x: number; z: number } {
  const bias = Math.min(1, Math.max(0, opts.bias));
  if (!opts.awayFromCrowd || bias <= 0) return normalize2(opts.awayFromTarget);
  const a = normalize2(opts.awayFromTarget);
  const b = normalize2(opts.awayFromCrowd);
  return normalize2({
    x: a.x * (1 - bias) + b.x * bias,
    z: a.z * (1 - bias) + b.z * bias
  });
}

function normalize2(v: { x: number; z: number }): { x: number; z: number } {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return { x: 0, z: -1 };
  return { x: v.x / len, z: v.z / len };
}

export function countNearbyHostiles(
  entities: Record<string | number, any> | null | undefined,
  botPos: { x: number; y: number; z: number },
  maxDistance: number,
  isHostileFn: (entity: any) => boolean
): number {
  let count = 0;
  for (const entity of Object.values(entities || {})) {
    if (!entity?.position || !isHostileFn(entity)) continue;
    const dist = Math.hypot(
      entity.position.x - botPos.x,
      entity.position.y - botPos.y,
      entity.position.z - botPos.z
    );
    if (dist <= maxDistance) count += 1;
  }
  return count;
}

/**
 * 近傍敵の平均位置から離れる方向（空間の空き方向への補正）。
 */
export function crowdAwayDirection(
  entities: Record<string | number, any> | null | undefined,
  botPos: { x: number; y: number; z: number },
  maxDistance: number,
  isHostileFn: (entity: any) => boolean
): { x: number; z: number } | null {
  let sumX = 0;
  let sumZ = 0;
  let n = 0;
  for (const entity of Object.values(entities || {})) {
    if (!entity?.position || !isHostileFn(entity)) continue;
    const dx = entity.position.x - botPos.x;
    const dz = entity.position.z - botPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= 0.01 || dist > maxDistance) continue;
    sumX += dx;
    sumZ += dz;
    n += 1;
  }
  if (n === 0) return null;
  return normalize2({ x: -(sumX / n), z: -(sumZ / n) });
}

export function defensivePresetId(ctx: CombatContext): CombatPresetId {
  const ids = listPresetsForContext(ctx);
  return ids[ids.length - 1] || ids[0];
}
