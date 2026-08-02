/**
 * クリーパー着火判定と退避距離の定数。
 *
 * プロトコル metadata（現行 JE）:
 * - 16: fuse state（idle = -1, fuse = 1）
 * - 17: charged
 * - 18: ignited boolean
 *
 * 方針: 未着火は近接を維持。着火中だけ短く飛び退き、着火が消えたらすぐ攻撃に戻る。
 */

/** 着火中の短い飛び退き距離。短いほど早く攻撃に戻れる。 */
export const CREEPER_FLEE_DISTANCE = 4;

/**
 * この距離以上なら着火中でも追加の飛び退きはしない
 * （すでに安全距離にいる）。
 */
export const CREEPER_SAFE_DISTANCE = 3.5;

/** クリーパーへの近接補助の最大距離（閉じながら振る）。 */
export const CREEPER_MELEE_ASSIST_RANGE = 4.5;

/** クリーパー近接補助の最短間隔（ms）。 */
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
