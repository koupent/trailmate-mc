import Vec3 from 'vec3';
import { isDoorPassableName } from '../blockProtection.js';

/** A route point must be clearly off the passage plane to establish a side. */
const SIDE_CLEARANCE = 0.3;
/** Doorways are one block wide, with a little tolerance for path centering. */
const CORRIDOR_HALF_WIDTH = 1.1;
/** Route points around a passage must remain close enough to describe that crossing. */
const CROSSING_NEIGHBOR_DISTANCE = 2.5;
const CROSSING_VERTICAL_TOLERANCE = 2.5;

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
 * Validate every pathfinder `useOne` action as a real passage crossing.
 * @param {import('mineflayer').Bot} bot
 * @param {Array<any>} path
 * @param {{ x:number,y:number,z:number }} [start]
 * @returns {{ valid: boolean, passages: Map<string, RoutePassagePlan>, invalidKey: string|null }}
 */
export function analyzePassageRoute(bot, path, start = bot?.entity?.position) {
    /** @type {Map<string, RoutePassagePlan>} */
    const passages = new Map();
    if (!Array.isArray(path) || !start) {
        return { valid: false, passages, invalidKey: null };
    }

    for (let nodeIndex = 0; nodeIndex < path.length; nodeIndex++) {
        const node = path[nodeIndex];
        for (const action of node?.toPlace || []) {
            if (action?.useOne !== true) continue;
            const block = blockAt(bot, action);
            if (!isRoutePassage(block)) {
                return { valid: false, passages, invalidKey: passagePositionKey(action) };
            }

            const passagePos = normalizePassagePosition(block);
            const key = passagePositionKey(passagePos);
            const crossing = findPassageCrossing(
                path,
                start,
                passagePos,
                block._properties?.facing,
                nodeIndex
            );
            if (!crossing) return { valid: false, passages, invalidKey: key };

            // A passage is relevant only when the route finishes on the side it
            // exited. A* can otherwise leave through a nearby gate, climb or
            // detour elsewhere, and return to the original side near an
            // unreachable target. Opening that gate does not advance the bot
            // into the target's region.
            const endpointSide = clearSide(path.at(-1), passagePos, block._properties?.facing);
            if (endpointSide !== crossing.exitSide) {
                return { valid: false, passages, invalidKey: key };
            }

            passages.set(key, {
                key,
                passagePos,
                facing: block._properties?.facing,
                approachSide: crossing.approachSide,
                exitSide: crossing.exitSide
            });
        }
    }

    return { valid: true, passages, invalidKey: null };
}

/**
 * Determine whether a route actually crosses a specific passage. When an action
 * index is supplied, the crossing must surround that action node.
 * @param {Array<any>} path
 * @param {{ x:number,y:number,z:number }} start
 * @param {{ x:number,y:number,z:number }} passagePos
 * @param {string|undefined} facing
 * @param {number|null} [actionNodeIndex]
 * @returns {{ approachSide:-1|1, exitSide:-1|1 }|null}
 */
function findPassageCrossing(
    path,
    start,
    passagePos,
    facing,
    actionNodeIndex = null
) {
    if (!Array.isArray(path) || !start) return null;
    const points = [start, ...path];
    if (actionNodeIndex != null) {
        const actionPointIndex = actionNodeIndex + 1;
        const before = findSidePoint(points, passagePos, facing, actionPointIndex - 1, -1);
        const after = findSidePoint(points, passagePos, facing, actionPointIndex + 1, 1);
        return crossingFromPoints(before, after, passagePos, facing);
    }

    for (let split = 0; split < points.length - 1; split++) {
        const before = findSidePoint(points, passagePos, facing, split, -1);
        const after = findSidePoint(points, passagePos, facing, split + 1, 1);
        const crossing = crossingFromPoints(before, after, passagePos, facing);
        if (crossing) return crossing;
    }
    return null;
}

/**
 * @typedef {{
 *   key:string,
 *   passagePos:{x:number,y:number,z:number},
 *   facing?:string,
 *   approachSide:-1|1,
 *   exitSide:-1|1
 * }} RoutePassagePlan
 */

function blockAt(bot, pos) {
    if (typeof bot?.blockAt !== 'function') return null;
    return bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
}

function findSidePoint(points, passagePos, facing, startIndex, step) {
    for (let i = startIndex; i >= 0 && i < points.length; i += step) {
        const point = points[i];
        if (!isFinitePoint(point)) continue;
        const planeDistance = passagePlaneDistance(point, passagePos, facing);
        if (Math.abs(planeDistance) < SIDE_CLEARANCE) continue;
        return { point, side: /** @type {-1|1} */ (Math.sign(planeDistance)) };
    }
    return null;
}

function crossingFromPoints(before, after, passagePos, facing) {
    if (!before || !after || before.side === after.side) return null;
    if (!isNearPassage(before.point, passagePos, facing)
        || !isNearPassage(after.point, passagePos, facing)) {
        return null;
    }
    return { approachSide: before.side, exitSide: after.side };
}

function isNearPassage(point, passagePos, facing) {
    const cx = passagePos.x + 0.5;
    const cz = passagePos.z + 0.5;
    const normalDistance = Math.abs(passagePlaneDistance(point, passagePos, facing));
    const lateralDistance = facing === 'east' || facing === 'west'
        ? Math.abs(point.z - cz)
        : Math.abs(point.x - cx);
    return normalDistance <= CROSSING_NEIGHBOR_DISTANCE
        && lateralDistance <= CORRIDOR_HALF_WIDTH
        && Math.abs(point.y - passagePos.y) <= CROSSING_VERTICAL_TOLERANCE;
}

function isFinitePoint(point) {
    return Number.isFinite(point?.x)
        && Number.isFinite(point?.y)
        && Number.isFinite(point?.z);
}

function clearSide(point, passagePos, facing) {
    if (!isFinitePoint(point)) return 0;
    const planeDistance = passagePlaneDistance(point, passagePos, facing);
    if (Math.abs(planeDistance) < SIDE_CLEARANCE) return 0;
    return /** @type {-1|1} */ (Math.sign(planeDistance));
}
