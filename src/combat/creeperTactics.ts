/**
 * クリーパー着火判定と退避距離の定数。
 *
 * プロトコル metadata（現行 JE）:
 * - 16: fuse state（idle = -1, fuse = 1）
 * - 17: charged
 * - 18: ignited boolean
 *
 * 方針: 着火直後は間合いを取り直して攻撃し、爆発が迫ったら退避する。
 */

/** 着火中の短い飛び退き距離。短いほど早く攻撃に戻れる。 */
export const CREEPER_FLEE_DISTANCE = 4;
export const CREEPER_DEFUSE_RANGE = 7;
export const CREEPER_FUSE_MS = 1500;
const CREEPER_RETREAT_WINDOW_MS = 700;
const CREEPER_RETREAT_HEALTH = 8;

/** クリーパーを殴る最短間隔（ms）。着火を止めるため剣の間隔より短い。 */
export const CREEPER_STRIKE_GAP_MS = 300;

/**
 * @param {{ name?: string, metadata?: unknown } | null | undefined} enemy
 */
export function isCreeperIgnited(
    enemy: { name?: string; metadata?: unknown } | null | undefined
): boolean {
    if (enemy?.name !== 'creeper') return false;
    const md = enemy.metadata;
    if (!Array.isArray(md) && (md == null || typeof md !== 'object')) return false;
    const get = (i: number) => (
        Array.isArray(md) ? md[i] : (md as Record<number, unknown>)[i]
    );

    const fuseState = get(16);
    if (fuseState === 1 || fuseState === true) return true;
    if (typeof fuseState === 'number' && fuseState > 0) return true;

    const ignited = get(18);
    if (ignited === true || ignited === 1) return true;

    return false;
}

/** 次の判断までに退避の時間帯に入る場合も、今の判断で先に離れる。 */
export function creeperMustFlee(remainingMs: number | undefined, health: number, tickMs: number): boolean {
  return remainingMs === undefined || health <= CREEPER_RETREAT_HEALTH
    || remainingMs <= CREEPER_RETREAT_WINDOW_MS + tickMs;
}
