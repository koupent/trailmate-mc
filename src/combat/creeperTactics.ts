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

/** 着火中で殴って止められないときだけ強制退避。 */
export function creeperMustFlee(opts: {
  ignited: boolean;
  canMeleeStrike: boolean;
  distance: number;
  fleeDistance: number;
}): boolean {
  if (!opts.ignited) return false;
  if (opts.canMeleeStrike) return false;
  return opts.distance < opts.fleeDistance;
}
