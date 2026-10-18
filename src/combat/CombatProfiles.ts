/**
 * 敵分類と安全なプリセットを定める純粋な戦闘方針。
 * コンテキストは敵クラス×盾の有無のみ（敵数バケットは使わない）。
 */

export type EnemyClass = 'melee' | 'agile' | 'ranged' | 'explosive';

export type CombatContext = {
  enemyClass: EnemyClass;
  hasShield: boolean;
};

/**
 * 敵クラス×盾ごとに切り替える数値。箱庭と本番で感触がずれる値だけを持ち、
 * 学習・箱庭チューニングの対象になる（CombatTuneCatalog）。
 * それ以外の判断の固定値は CombatParams にある。
 */
export type CombatPresetParams = {
  /** クリーパーの警戒距離。着火退避・危険帯の目安。 */
  creeperSoftEvadeRange: number;
  /** ワールド座標上で行う1回の遠距離回避バーストの最大時間。 */
  rangedDodgeBurstMs: number;
  /** 各回避バースト後に確保する明示的な攻撃・前進時間。 */
  rangedDodgeReassessMs: number;
};

export type CombatPresetId = string;

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
  creeperSoftEvadeRange: { min: 2.5, max: 5.5 },
  rangedDodgeBurstMs: { min: 250, max: 1000 },
  rangedDodgeReassessMs: { min: 750, max: 3000 }
};

const MELEE_BASELINE: CombatPresetParams = {
  creeperSoftEvadeRange: 3.2,
  rangedDodgeBurstMs: 650,
  rangedDodgeReassessMs: 1500
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
  'ranged-baseline': adjust(MELEE_BASELINE, {
    rangedDodgeBurstMs: 450,
    rangedDodgeReassessMs: 1800
  }),
  'ranged-shield-push': adjust(MELEE_BASELINE, {
    rangedDodgeBurstMs: 300,
    rangedDodgeReassessMs: 2400
  }),
  'explosive-baseline': adjust(MELEE_BASELINE, { creeperSoftEvadeRange: 3.4 }),
  'explosive-wide': adjust(MELEE_BASELINE, { creeperSoftEvadeRange: 3.8 }),
  'explosive-aggressive': adjust(MELEE_BASELINE, { creeperSoftEvadeRange: 3.0 })
};

/** 先頭が既定、末尾が低HP時の守りのプリセット。 */
const CONTEXT_PRESETS: Record<string, CombatPresetId[]> = {
  // 近接・敏捷は原則駆動。数値で比べる候補はない。
  'melee|0': ['melee-baseline'],
  'melee|1': ['melee-baseline'],
  'agile|0': ['melee-baseline'],
  'agile|1': ['melee-baseline'],
  'ranged|0': ['ranged-baseline', 'melee-baseline'],
  'ranged|1': ['ranged-baseline', 'ranged-shield-push'],
  // 混成（矢+クリーパー）では過接近プリセットより間合い広めを既定にする
  'explosive|0': ['explosive-wide', 'explosive-baseline', 'explosive-aggressive'],
  'explosive|1': ['explosive-wide', 'explosive-baseline', 'explosive-aggressive']
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

const ENCOUNTER_CLASS_PRIORITY: Record<EnemyClass, number> = {
  explosive: 3,
  ranged: 2,
  agile: 1,
  melee: 0
};

/**
 * 複数敵の遭遇クラス。最も危険な種別を採用する。
 * （混成で先頭がゾンビでも、スケルトンがいれば ranged プリセットにする）
 */
export function classifyEncounterEnemyClass(
  enemies: Array<{ kind?: string; name?: string; hp?: number } | null | undefined>
): EnemyClass {
  let best: EnemyClass = 'melee';
  let bestRank = -1;
  for (const enemy of enemies) {
    if (!enemy) continue;
    if (typeof enemy.hp === 'number' && enemy.hp <= 0) continue;
    const cls = classifyEnemy(enemy.kind || enemy.name);
    const rank = ENCOUNTER_CLASS_PRIORITY[cls] ?? 0;
    if (rank > bestRank) {
      best = cls;
      bestRank = rank;
    }
  }
  return best;
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

export function defensivePresetId(ctx: CombatContext): CombatPresetId {
  const ids = listPresetsForContext(ctx);
  return ids[ids.length - 1] || ids[0];
}
