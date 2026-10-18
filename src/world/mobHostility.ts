/**
 * どのモブを攻撃するかの方針。
 *
 * minecraft-data の分類は「攻撃してくるか」を表していない（type 'mob' は未分類の入れ物）うえ、
 * ViaBackwards 経由の新モブは旧バージョンの類似モブに置き換わって届く。
 * そこで、判断のつかないモブは「未設定＝攻撃しない」とし、遭遇したものを記録して
 * ダッシュボードからユーザーが決められるようにする。
 */

export type MobDecision = 'attack' | 'ignore';
export type MobHostilityConfig = Record<string, MobDecision>;

/** type 'mob'（未分類）に入っている既知モブの既定。 */
const BUILTIN: MobHostilityConfig = {
  slime: 'attack',
  magma_cube: 'attack',
  ghast: 'attack',
  phantom: 'attack',
  shulker: 'attack',
  ender_dragon: 'attack',
  iron_golem: 'ignore',
  snow_golem: 'ignore',
  allay: 'ignore',
  copper_golem: 'ignore'
};

const MOB_KEY = /^[a-z0-9_]+$/;

let overrides: MobHostilityConfig = {};
/** 遭遇した未設定モブ（キー → 表示名）。再起動で消えても次の遭遇で戻る。 */
const unsetEncounters = new Map<string, string>();

export function normalizeMobHostility(input: unknown): MobHostilityConfig {
  const result: MobHostilityConfig = {};
  if (!input || typeof input !== 'object') return result;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (MOB_KEY.test(key) && (value === 'attack' || value === 'ignore')) result[key] = value;
  }
  return result;
}

export function setMobHostility(input: unknown): MobHostilityConfig {
  overrides = normalizeMobHostility(input);
  for (const key of Object.keys(overrides)) unsetEncounters.delete(key);
  return overrides;
}

type MobLike = { name?: string; type?: string; displayName?: string; metadata?: any; customName?: unknown };

/**
 * ViaBackwards は置き換えたモブに `vb.entity.<id>`（フォールバック "26.2 Sulfur Cube"）
 * という名前を付ける。それがあれば本来のモブとして扱う。
 */
export function resolveMobKey(mob: MobLike): { key: string; label: string; mapped: boolean } {
  const raw = mob.metadata?.[2] ?? mob.customName;
  if (raw != null) {
    const text = JSON.stringify(raw);
    const translate = text.match(/vb\.entity\.([a-z0-9_]+)/);
    const fallback = text.match(/\b\d+\.\d+(?:\.\d+)? ([A-Z][A-Za-z' ]*[A-Za-z])/);
    if (translate) return { key: translate[1], label: fallback?.[1] ?? translate[1], mapped: true };
    if (fallback) {
      return { key: fallback[1].toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: fallback[1], mapped: true };
    }
  }
  const name = String(mob.name);
  return { key: name, label: mob.displayName || name, mapped: false };
}

/** 保存設定を除いた既定。null は「未設定」。 */
export function defaultMobDecision(key: string, type: string | undefined, mapped = false): MobDecision | null {
  if (BUILTIN[key]) return BUILTIN[key];
  if (mapped) return null;
  if (type === 'hostile') return 'attack';
  if (type === 'mob') return null;
  return 'ignore';
}

/** 置き換え名を探すのは生き物だけ（ホログラム等の名前を拾わないため）。 */
const NON_LIVING_TYPES = new Set(['other', 'object', 'player', 'projectile', 'orb', 'global']);

export function isAttackableMob(mob: MobLike): boolean {
  if (!mob.type || NON_LIVING_TYPES.has(mob.type)) return false;
  const { key, label, mapped } = resolveMobKey(mob);
  if (!mapped && mob.type !== 'mob' && mob.type !== 'hostile') return false;
  const decision = overrides[key] ?? defaultMobDecision(key, mob.type, mapped);
  if (decision == null) unsetEncounters.set(key, label);
  return decision === 'attack';
}

export function listUnsetEncounters(): Array<{ id: string; label: string }> {
  return [...unsetEncounters].map(([id, label]) => ({ id, label }));
}

/**
 * ダッシュボードに出す候補: レジストリの敵対・未分類モブと、遭遇した未設定モブ。
 */
export function buildMobCatalog(
  registry: { entitiesArray?: Array<{ name: string; type?: string; displayName?: string }> } | null
): Array<{ id: string; label: string; default: MobDecision | null }> {
  const mobs = new Map<string, { id: string; label: string; default: MobDecision | null }>();
  for (const entity of registry?.entitiesArray ?? []) {
    if (entity.type !== 'hostile' && entity.type !== 'mob') continue;
    mobs.set(entity.name, {
      id: entity.name,
      label: entity.displayName || entity.name,
      default: defaultMobDecision(entity.name, entity.type)
    });
  }
  for (const { id, label } of listUnsetEncounters()) {
    if (!mobs.has(id)) mobs.set(id, { id, label, default: null });
  }
  return [...mobs.values()];
}
