/**
 * Pure combat policy: enemy classification, count buckets, and safe presets.
 * No bot I/O — Reflexes / CombatOptimizer consume these helpers.
 */

export type EnemyClass = 'melee' | 'agile' | 'ranged' | 'explosive';
export type CountBucket = 'solo' | 'duo' | 'swarm';

export type CombatContext = {
  enemyClass: EnemyClass;
  countBucket: CountBucket;
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
  /** Keep the current target this long before allowing a switch. */
  focusStickyMs: number;
  /** 0..1 bias to step away from the crowd centroid while kiting. */
  crowdAvoidBias: number;
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

/** Hard safety bounds — optimizer must never leave this box. */
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
  crowdAvoidBias: { min: 0, max: 1 }
};

const SOLO_MELEE_BASELINE: CombatPresetParams = {
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
  crowdAvoidBias: 0.15
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
 * Built-in presets keyed by id. Each context maps to a small candidate set.
 */
const PRESETS: Record<CombatPresetId, CombatPresetParams> = {
  'melee-solo-baseline': SOLO_MELEE_BASELINE,
  'melee-solo-aggressive': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.0,
    kiteFollowRange: 2.8,
    backstepRange: 1.4,
    strafeRange: 2.4,
    focusStickyMs: 1200,
    crowdAvoidBias: 0.05
  }),
  'melee-solo-defensive': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.8,
    kiteFollowRange: 4.0,
    backstepRange: 2.0,
    strafeRange: 3.2,
    strafeSwitchMs: 500,
    focusStickyMs: 700,
    crowdAvoidBias: 0.35
  }),

  'melee-duo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.6,
    kiteFollowRange: 3.8,
    backstepRange: 1.9,
    strafeRange: 3.2,
    focusStickyMs: 1600,
    crowdAvoidBias: 0.45
  }),
  'melee-duo-focus': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.4,
    kiteFollowRange: 3.5,
    backstepRange: 1.8,
    strafeRange: 3.0,
    focusStickyMs: 2400,
    crowdAvoidBias: 0.35
  }),
  'melee-duo-kiting': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.9,
    kiteFollowRange: 4.2,
    backstepRange: 2.1,
    strafeRange: 3.5,
    strafeSwitchMs: 480,
    focusStickyMs: 1100,
    crowdAvoidBias: 0.6
  }),

  'melee-swarm-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.9,
    kiteFollowRange: 4.4,
    backstepRange: 2.2,
    strafeRange: 3.6,
    strafeSwitchMs: 450,
    focusStickyMs: 1800,
    crowdAvoidBias: 0.75
  }),
  'melee-swarm-escape': adjust(SOLO_MELEE_BASELINE, {
    followRange: 3.1,
    kiteFollowRange: 4.8,
    backstepRange: 2.4,
    strafeRange: 4.0,
    strafeSwitchMs: 400,
    focusStickyMs: 900,
    crowdAvoidBias: 0.95
  }),

  'agile-solo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.2,
    kiteFollowRange: 3.2,
    backstepRange: 1.6,
    strafeRange: 3.0,
    strafeSwitchMs: 500,
    focusStickyMs: 800,
    crowdAvoidBias: 0.25
  }),
  'agile-duo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.5,
    kiteFollowRange: 3.7,
    backstepRange: 1.9,
    strafeRange: 3.3,
    focusStickyMs: 1500,
    crowdAvoidBias: 0.5
  }),
  'agile-swarm-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 2.8,
    kiteFollowRange: 4.2,
    backstepRange: 2.1,
    strafeRange: 3.6,
    focusStickyMs: 1200,
    crowdAvoidBias: 0.8
  }),

  'ranged-solo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 1.4,
    kiteFollowRange: 2.6,
    backstepRange: 1.5,
    strafeRange: 3.2,
    rangedBackRange: 2.4,
    strafeSwitchMs: 550,
    focusStickyMs: 1000,
    crowdAvoidBias: 0.2
  }),
  'ranged-solo-shield-push': adjust(SOLO_MELEE_BASELINE, {
    followRange: 1.2,
    kiteFollowRange: 2.4,
    backstepRange: 1.4,
    strafeRange: 2.8,
    rangedBackRange: 2.0,
    focusStickyMs: 1400,
    crowdAvoidBias: 0.1
  }),
  'ranged-duo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 1.5,
    kiteFollowRange: 3.0,
    backstepRange: 1.7,
    strafeRange: 3.4,
    rangedBackRange: 2.6,
    focusStickyMs: 1700,
    crowdAvoidBias: 0.45
  }),
  'ranged-swarm-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 1.7,
    kiteFollowRange: 3.4,
    backstepRange: 1.9,
    strafeRange: 3.8,
    rangedBackRange: 2.8,
    focusStickyMs: 1300,
    crowdAvoidBias: 0.7
  }),

  'explosive-solo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 4.5,
    kiteFollowRange: 5.0,
    backstepRange: 2.4,
    strafeRange: 3.5,
    creeperSoftEvadeRange: 3.2,
    creeperFollowRange: 4.5,
    focusStickyMs: 700,
    crowdAvoidBias: 0.4
  }),
  'explosive-solo-wide': adjust(SOLO_MELEE_BASELINE, {
    followRange: 5.0,
    kiteFollowRange: 5.0,
    backstepRange: 2.5,
    strafeRange: 4.0,
    creeperSoftEvadeRange: 4.0,
    creeperFollowRange: 5.5,
    focusStickyMs: 600,
    crowdAvoidBias: 0.55
  }),
  'explosive-duo-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 4.8,
    kiteFollowRange: 5.0,
    backstepRange: 2.5,
    strafeRange: 3.8,
    creeperSoftEvadeRange: 3.6,
    creeperFollowRange: 5.0,
    focusStickyMs: 900,
    crowdAvoidBias: 0.7
  }),
  'explosive-swarm-baseline': adjust(SOLO_MELEE_BASELINE, {
    followRange: 5.0,
    kiteFollowRange: 5.0,
    backstepRange: 2.5,
    strafeRange: 4.2,
    creeperSoftEvadeRange: 4.2,
    creeperFollowRange: 5.8,
    focusStickyMs: 800,
    crowdAvoidBias: 0.9
  })
};

const CONTEXT_PRESETS: Record<string, CombatPresetId[]> = {
  'melee|solo|0': ['melee-solo-baseline', 'melee-solo-aggressive', 'melee-solo-defensive'],
  'melee|solo|1': ['melee-solo-baseline', 'melee-solo-aggressive', 'melee-solo-defensive'],
  'melee|duo|0': ['melee-duo-baseline', 'melee-duo-focus', 'melee-duo-kiting'],
  'melee|duo|1': ['melee-duo-baseline', 'melee-duo-focus', 'melee-duo-kiting'],
  'melee|swarm|0': ['melee-swarm-baseline', 'melee-swarm-escape'],
  'melee|swarm|1': ['melee-swarm-baseline', 'melee-swarm-escape'],

  'agile|solo|0': ['agile-solo-baseline', 'melee-solo-defensive'],
  'agile|solo|1': ['agile-solo-baseline', 'melee-solo-defensive'],
  'agile|duo|0': ['agile-duo-baseline', 'melee-duo-kiting'],
  'agile|duo|1': ['agile-duo-baseline', 'melee-duo-kiting'],
  'agile|swarm|0': ['agile-swarm-baseline', 'melee-swarm-escape'],
  'agile|swarm|1': ['agile-swarm-baseline', 'melee-swarm-escape'],

  'ranged|solo|0': ['ranged-solo-baseline', 'melee-solo-defensive'],
  'ranged|solo|1': ['ranged-solo-baseline', 'ranged-solo-shield-push'],
  'ranged|duo|0': ['ranged-duo-baseline', 'melee-duo-kiting'],
  'ranged|duo|1': ['ranged-duo-baseline', 'ranged-solo-shield-push'],
  'ranged|swarm|0': ['ranged-swarm-baseline', 'melee-swarm-escape'],
  'ranged|swarm|1': ['ranged-swarm-baseline', 'melee-swarm-escape'],

  'explosive|solo|0': ['explosive-solo-baseline', 'explosive-solo-wide'],
  'explosive|solo|1': ['explosive-solo-baseline', 'explosive-solo-wide'],
  'explosive|duo|0': ['explosive-duo-baseline', 'explosive-solo-wide'],
  'explosive|duo|1': ['explosive-duo-baseline', 'explosive-solo-wide'],
  'explosive|swarm|0': ['explosive-swarm-baseline', 'explosive-solo-wide'],
  'explosive|swarm|1': ['explosive-swarm-baseline', 'explosive-solo-wide']
};

export function classifyEnemy(name: string | null | undefined): EnemyClass {
  if (!name) return 'melee';
  if (EXPLOSIVE_NAMES.has(name)) return 'explosive';
  if (RANGED_NAMES.has(name)) return 'ranged';
  if (AGILE_NAMES.has(name)) return 'agile';
  return 'melee';
}

export function countBucket(enemyCount: number): CountBucket {
  if (enemyCount <= 1) return 'solo';
  if (enemyCount === 2) return 'duo';
  return 'swarm';
}

export function contextKey(ctx: CombatContext): string {
  return `${ctx.enemyClass}|${ctx.countBucket}|${ctx.hasShield ? 1 : 0}`;
}

export function baselinePresetId(ctx: CombatContext): CombatPresetId {
  const ids = listPresetsForContext(ctx);
  return ids[0];
}

export function listPresetsForContext(ctx: CombatContext): CombatPresetId[] {
  const key = contextKey(ctx);
  return CONTEXT_PRESETS[key] || ['melee-solo-baseline'];
}

export function getPresetParams(presetId: CombatPresetId): CombatPresetParams {
  const found = PRESETS[presetId];
  if (!found) return clampPreset(cloneParams(SOLO_MELEE_BASELINE));
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
 * Choose followRange for pvp pathing from the active preset.
 */
export function resolveFollowRange(
  params: CombatPresetParams,
  enemyClass: EnemyClass,
  distance: number
): number {
  if (enemyClass === 'explosive') return params.creeperFollowRange;
  if (enemyClass === 'ranged') return params.followRange;
  return distance <= params.backstepRange
    ? params.kiteFollowRange
    : params.followRange;
}

/**
 * Decide whether to strafe / backstep given geometry and preset.
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
  const needStrafe = enemyClass === 'explosive'
    || enemyClass === 'ranged'
    || exposed
    || distance <= params.backstepRange;
  const needBackstep = enemyClass === 'explosive'
    || distance <= params.backstepRange
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
 * Blend backstep direction away from nearby hostile centroid.
 * bias=0 keeps pure target-away vector; bias=1 fully uses clear-space vector.
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
 * Direction away from the average position of nearby hostiles (clear-space bias).
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
  // Away from centroid = opposite of average offset.
  return normalize2({ x: -(sumX / n), z: -(sumZ / n) });
}

export function defensivePresetId(ctx: CombatContext): CombatPresetId {
  const ids = listPresetsForContext(ctx);
  // Prefer the last (usually more defensive / escape) when HP is low.
  return ids[ids.length - 1] || ids[0];
}
