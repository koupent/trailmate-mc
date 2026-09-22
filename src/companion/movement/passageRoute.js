import Vec3 from 'vec3';
import { isDoorPassableName } from '../blockProtection.js';

/** A route point must be clearly off the passage plane to establish a side. */
const SIDE_CLEARANCE = 0.3;
/** Doorways are one block wide, with a little tolerance for path centering. */
export const CORRIDOR_HALF_WIDTH = 1.1;
/** Close enough to a doorway to stand in front of it, or to have arrived at it. */
export const APPROACH_DISTANCE = 2.25;
/** Clear of a doorway: far enough that the bot is no longer standing in it. */
export const CLEAR_DISTANCE = 1.35;
/** A route point only describes a passage while it stays this near the doorway. */
const NEIGHBOR_DISTANCE = 2.5;
/** Same walkable level, with room for the two blocks of a door. */
const VERTICAL_TOLERANCE = 2.5;

/** @param {{ name?: string }|null|undefined} block */
export function isRoutePassage(block) {
    return isDoorPassableName(block?.name);
}

/**
 * Always address the lower half of a two-block door.
 * @param {{ position: { x: number, y: number, z: number }, _properties?: { half?: string } }} block
 */
export function normalizePassagePosition(block) {
    const pos = block.position;
    return block._properties?.half === 'upper'
        ? { x: pos.x, y: pos.y - 1, z: pos.z }
        : { x: pos.x, y: pos.y, z: pos.z };
}

/** @param {{ x: number, y: number, z: number }} pos */
export function passagePositionKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Signed distance from the passage plane. Positive/negative identify its sides.
 * @param {{ x: number, z: number }} pos
 * @param {{ x: number, z: number }} passagePos
 * @param {string|undefined} facing
 */
export function passagePlaneDistance(pos, passagePos, facing) {
    const cx = passagePos.x + 0.5;
    const cz = passagePos.z + 0.5;
    return facing === 'east' || facing === 'west'
        ? pos.x - cx
        : pos.z - cz;
}

/**
 * @param {{ x: number, z: number }} pos
 * @param {{ x: number, z: number }} passagePos
 * @param {string|undefined} facing
 * @returns {-1|0|1}
 */
export function passageSide(pos, passagePos, facing) {
    return /** @type {-1|0|1} */ (Math.sign(passagePlaneDistance(pos, passagePos, facing)));
}

/**
 * @typedef {{
 *   key: string,
 *   passagePos: { x:number, y:number, z:number },
 *   facing?: string,
 *   approachSide: -1|1|null,
 *   approachPoint: { x:number, y:number, z:number }|null,
 *   onPath: boolean
 * }} RoutePassagePlan
 */

/**
 * Every passage the pathfinder plans to operate on this route.
 *
 * A `useOne` action is the pathfinder saying "this route only works if that
 * door opens", which is all the evidence needed to take the passage over. The
 * geometry around it is read for one thing only: where to stand while
 * activating. Failing to read it never rejects the passage, because a passage
 * nobody handles is a wall — the pathfinder's own action is stripped either way.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {Array<any>} path
 * @param {{ x:number, y:number, z:number }} [start]
 * @returns {Map<string, RoutePassagePlan>}
 */
export function analyzePassageRoute(bot, path, start = bot?.entity?.position) {
    /** @type {Map<string, RoutePassagePlan>} */
    const passages = new Map();
    if (!Array.isArray(path)) return passages;

    const hasStart = isFinitePoint(start);
    const points = hasStart ? [start, ...path] : [...path];
    const nodeOffset = hasStart ? 1 : 0;

    for (let nodeIndex = 0; nodeIndex < path.length; nodeIndex++) {
        for (const action of path[nodeIndex]?.toPlace || []) {
            if (action?.useOne !== true) continue;
            const block = blockAt(bot, action);
            // A door action on anything else is not a passage to take over.
            if (!isRoutePassage(block)) continue;

            const passagePos = normalizePassagePosition(block);
            const key = passagePositionKey(passagePos);
            if (passages.has(key)) continue;
            const facing = block._properties?.facing;
            passages.set(key, {
                key,
                passagePos,
                facing,
                // A door action sits on the very node that steps into the
                // doorway, so the route normally reports its own progress past
                // it. Path shortcuts can drop that node; then nothing can, and
                // the passage stays needed for as long as this route lives.
                onPath: routeEntersPassage(path, passagePos),
                ...approachFromRoute(points, passagePos, facing, nodeIndex + nodeOffset)
            });
        }
    }

    return passages;
}

/**
 * The last place on the route before the doorway that is squarely on one side
 * of it. A route the bot is already standing in the middle of can fail to
 * provide one, so the side alone is reported when no point is close enough to
 * stand on, and the caller derives a stand point from the passage itself.
 *
 * @param {Array<any>} points
 * @param {{ x:number, y:number, z:number }} passagePos
 * @param {string|undefined} facing
 * @param {number} actionIndex Index of the node carrying the door action
 * @returns {{ approachSide: -1|1|null, approachPoint: {x:number,y:number,z:number}|null }}
 */
function approachFromRoute(points, passagePos, facing, actionIndex) {
    for (let i = Math.min(actionIndex - 1, points.length - 1); i >= 0; i--) {
        if (!isFinitePoint(points[i])) continue;
        const point = routeStandPoint(points[i]);
        const planeDistance = passagePlaneDistance(point, passagePos, facing);
        if (Math.abs(planeDistance) < SIDE_CLEARANCE) continue;

        const approachSide = /** @type {-1|1} */ (Math.sign(planeDistance));
        return isNearPassage(point, passagePos, facing)
            // A* already proved this point reachable, so prefer it over anything
            // derived from the doorway.
            ? { approachSide, approachPoint: point }
            : { approachSide, approachPoint: null };
    }
    return { approachSide: null, approachPoint: null };
}

/**
 * Pathfinder nodes address block corners; standing targets address centers.
 * @param {{ x:number, y:number, z:number }} point
 */
export function routeStandPoint(point) {
    return {
        x: Number.isInteger(point.x) ? point.x + 0.5 : point.x,
        y: point.y,
        z: Number.isInteger(point.z) ? point.z + 0.5 : point.z
    };
}

/**
 * @param {{ x:number, y:number, z:number }} passagePos
 */
export function passageCenter(passagePos) {
    return { x: passagePos.x + 0.5, y: passagePos.y, z: passagePos.z + 0.5 };
}

/**
 * Where to stand to reach a passage from one of its sides.
 * @param {{ x:number, y:number, z:number }} passagePos
 * @param {string|undefined} facing
 * @param {-1|1} side
 * @param {number} distance
 */
export function passageStandPoint(passagePos, facing, side, distance) {
    const center = passageCenter(passagePos);
    const step = side * distance;
    return facing === 'east' || facing === 'west'
        ? { x: center.x + step, y: center.y, z: center.z }
        : { x: center.x, y: center.y, z: center.z + step };
}

/**
 * Whether a route still walks through a specific passage.
 *
 * mineflayer-pathfinder shifts each node off the emitted path array as the bot
 * reaches it, so the array a `path_update` handed over keeps describing what is
 * still ahead. An open passage carries no door action at all, which makes this
 * the only evidence that the bot has yet to go through one.
 *
 * @param {Array<any>} path
 * @param {{ x:number, y:number, z:number }} passagePos
 */
export function routeEntersPassage(path, passagePos) {
    if (!Array.isArray(path) || !passagePos) return false;
    for (const node of path) {
        if (!isFinitePoint(node)) continue;
        if (Math.floor(node.x) !== passagePos.x || Math.floor(node.z) !== passagePos.z) continue;
        // Either half of a two-block door puts the bot in the same doorway.
        if (Math.abs(Math.floor(node.y) - passagePos.y) <= 1) return true;
    }
    return false;
}

function blockAt(bot, pos) {
    if (typeof bot?.blockAt !== 'function') return null;
    return bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
}

function isNearPassage(point, passagePos, facing) {
    const cx = passagePos.x + 0.5;
    const cz = passagePos.z + 0.5;
    const normalDistance = Math.abs(passagePlaneDistance(point, passagePos, facing));
    const lateralDistance = facing === 'east' || facing === 'west'
        ? Math.abs(point.z - cz)
        : Math.abs(point.x - cx);
    return normalDistance <= NEIGHBOR_DISTANCE
        && lateralDistance <= CORRIDOR_HALF_WIDTH
        && Math.abs(point.y - passagePos.y) <= VERTICAL_TOLERANCE;
}

function isFinitePoint(point) {
    return Number.isFinite(point?.x)
        && Number.isFinite(point?.y)
        && Number.isFinite(point?.z);
}
