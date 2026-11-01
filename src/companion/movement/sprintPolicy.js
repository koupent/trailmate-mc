import { DEFAULT_FOLLOW_DISTANCE } from './followConstants.js';

/**
 * バニラは満腹度が 6 以下だと走り始められない。
 * それより上なら、既存の自動食事（満腹 14 以下で食べる）には触らない。
 */
export const SPRINT_MIN_FOOD = 7;

/**
 * 設定された追従距離よりこのぶん遠いと、歩きでは遅れが残る。
 * 既定の追従距離 3 なら、水平 8 ブロックから走る。
 */
export const FOLLOW_SPRINT_MARGIN = 5;

/**
 * 歩き約 4.3、走り約 5.6 ブロック/秒。この速さを超えた相手には歩きで付いていけない。
 */
export const OWNER_SPRINT_SPEED = 5;

/**
 * 固定の目的地まで、歩きでは明らかに遅い水平距離。
 * 植栽や扉の直前など、これより近い移動は歩く。
 */
export const TRAVEL_SPRINT_DISTANCE = 12;

/**
 * 満腹度が不明なテストやスポーン直後は走ってよい。数値があるときだけ止める。
 * @param {number|null|undefined} food
 */
export function hasSprintFood(food) {
    if (typeof food !== 'number' || !Number.isFinite(food)) return true;
    return food >= SPRINT_MIN_FOOD;
}

/**
 * pathfinder にダッシュを許すか。戦闘・消火の固定許可が優先される。
 * 登りは唇を飛び越すので、固定許可が無い限り走らない。
 *
 * @param {{
 *   sprintLocked?: boolean,
 *   role?: string,
 *   distance?: number,
 *   ownerSpeed?: number,
 *   followDistance?: number,
 *   food?: number|null
 * }} spec
 */
export function shouldSprintForMove(spec = {}) {
    if (!hasSprintFood(spec.food)) return false;
    if (spec.sprintLocked === true) return true;

    const distance = Number.isFinite(spec.distance) ? spec.distance : 0;
    if (spec.role === 'climb') return false;

    if (spec.role === 'follow' || spec.role === 'follow-fallback') {
        const followDistance = Number.isFinite(spec.followDistance)
            ? spec.followDistance
            : DEFAULT_FOLLOW_DISTANCE;
        if (distance >= followDistance + FOLLOW_SPRINT_MARGIN) return true;
        const ownerSpeed = Number.isFinite(spec.ownerSpeed) ? spec.ownerSpeed : 0;
        return distance > followDistance && ownerSpeed >= OWNER_SPRINT_SPEED;
    }

    if (spec.role === 'seek') {
        return distance >= TRAVEL_SPRINT_DISTANCE;
    }

    return false;
}
