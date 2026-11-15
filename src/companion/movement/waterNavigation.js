import { Vec3 } from 'vec3';
import { blockAt, isPassableBlock, isPassableLiquid, isDamageBlock } from './hazardBlocks.js';
import { movementControlsTowardBearing, threatBearingRad } from '../../combat/threatArc.js';
import { jumpBlockedByFarmland } from './farmland.js';

export const AIR_SECONDS_PER_POINT = 0.75;
export const AIR_RESERVE_SECONDS = 4;
// Deliberately below measured prismarine swim speeds; include turns and tick latency.
export const WATER_SPEED = { horizontal: 1.6, up: 2, down: 0.4 };
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
const key = p => `${p.x},${p.y},${p.z}`;
const center = p => new Vec3(p.x + 0.5, p.y, p.z + 0.5);

export function headInWater(bot, position = bot.entity?.position) {
    if (!position || typeof bot.blockAt !== 'function') return false;
    const eye = bot.entity?.eyeHeight ?? 1.62;
    return isPassableLiquid(blockAt(bot, position.x, position.y + eye, position.z));
}

export function bodyInWater(bot, position = bot.entity?.position) {
    return Boolean(position && typeof bot.blockAt === 'function' && (
        isPassableLiquid(blockAt(bot, position.x, position.y + 0.1, position.z))
        || headInWater(bot, position)
    ));
}

/** Full standing body clearance, including corners. Unknown cells are walls. */
export function waterNodeOpen(bot, p) {
    for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) {
        for (const dy of [0.05, 0.9, 1.79]) {
            if (!isPassableBlock(blockAt(bot, p.x + dx, p.y + dy, p.z + dz))) return false;
        }
        if (isDamageBlock(blockAt(bot, p.x + dx, p.y - 0.05, p.z + dz))) return false;
    }
    return true;
}

function supported(bot, p) {
    return blockAt(bot, p.x, p.y - 0.05, p.z)?.boundingBox === 'block';
}

export function waterTravelSeconds(a, b) {
    return Math.max(Math.hypot(a.x - b.x, a.z - b.z) / WATER_SPEED.horizontal,
        Math.max(0, b.y - a.y) / WATER_SPEED.up,
        Math.max(0, a.y - b.y) / WATER_SPEED.down);
}
const timeBetween = waterTravelSeconds;

/** A bounded Dijkstra/A* over loaded, body-sized water/shore cells.
 * Air goals must actually be breathable and supported by water or solid ground.
 * Paths store waypoints, rather than steering through ceilings toward an endpoint.
 */
export function planWaterRoute(bot, { from = bot.entity.position, target = null, air = false, range = 0, maxNodes = 7000 } = {}) {
    if (typeof bot.blockAt !== 'function') return null;
    const origin = new Vec3(Math.floor(from.x), Math.floor(from.y), Math.floor(from.z));
    // Fractional submerged player feet may be inside the bottom voxel. Use the
    // nearest body-sized cell rather than asking a standing bot to occupy it.
    if (!waterNodeOpen(bot, center(origin))) origin.y = Math.ceil(from.y);
    if (!waterNodeOpen(bot, center(origin))) return null;
    const goal = p => air
        ? !headInWater(bot, center(p)) && (bodyInWater(bot, center(p)) || supported(bot, center(p)))
        : Math.hypot(p.x + 0.5 - target.x, p.z + 0.5 - target.z) <= range + 0.5
            && Math.abs(p.y - target.y) <= 0.7
            && (bodyInWater(bot, center(p)) || supported(bot, center(p)));
    const heuristic = p => !target ? 0 : Math.max(
        Math.max(0, Math.hypot(p.x + 0.5 - target.x, p.z + 0.5 - target.z) - range) / WATER_SPEED.horizontal,
        Math.max(0, target.y - p.y - 0.7) / WATER_SPEED.up,
        Math.max(0, p.y - target.y - 0.7) / WATER_SPEED.down);
    const records = new Map();
    if (air) {
        const points = [];
        for (let dy = 0; dy <= 64; dy++) {
            const p = origin.offset(0, dy, 0);
            if (!waterNodeOpen(bot, center(p))) break;
            points.push(center(p));
            if (goal(p)) return { target: points.at(-1), points: points.length > 1 ? points.slice(1) : points,
                seconds: timeBetween(from, points[0]) + dy / WATER_SPEED.up };
        }
    }
    const start = { p: origin, cost: 0, score: heuristic(origin), parent: null };
    records.set(key(origin), start);
    const queue = [start];
    let visited = 0;
    while (queue.length && visited++ < maxNodes) {
        // Small binary heap; avoid sorting a broad underwater frontier every step.
        const node = heapPop(queue);
        if (node.closed) continue;
        node.closed = true;
        if (goal(node.p)) {
            const points = [];
            for (let n = node; n; n = n.parent) points.unshift(center(n.p));
            return { target: points.at(-1), points: points.length > 1 ? points.slice(1) : points,
                seconds: node.cost + timeBetween(from, points[0]) };
        }
        const neighbors = [[0,1,0],[0,-1,0]];
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            for (const dy of [0, 1, -1]) neighbors.push([dx,dy,dz]);
        }
        for (const [dx, dy, dz] of neighbors) {
            const p = node.p.offset(dx, dy, dz);
            if (Math.abs(p.x - origin.x) > 24 || Math.abs(p.z - origin.z) > 24
                || p.y < origin.y - 36 || p.y > origin.y + 64) continue;
            const c = center(p);
            if (!waterNodeOpen(bot, c)) continue;
            const wet = bodyInWater(bot, c);
            const currentWet = bodyInWater(bot, center(node.p));
            if (dy !== 0 && (dx !== 0 || dz !== 0)) {
                const corner = dy > 0 ? center(node.p.offset(0, 1, 0)) : center(p.offset(0, 1, 0));
                if (!waterNodeOpen(bot, corner)) continue;
            }
            if (!wet && !supported(bot, c) && !currentWet) continue;
            if (dy > 0 && !currentWet && !supported(bot, center(node.p))) continue;
            if (dy < 0 && !wet) continue;
            const cost = node.cost + timeBetween(center(node.p), c);
            const old = records.get(key(p));
            if (old && old.cost <= cost) continue;
            // Old entries stay in the heap but are marked closed when replaced.
            if (old) old.closed = true;
            const next = { p, cost, score: cost + heuristic(p), parent: node };
            records.set(key(p), next);
            heapPush(queue, next);
        }
    }
    return null;
}

function heapPush(heap, item) {
    heap.push(item);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent].score <= item.score) break;
        heap[index] = heap[parent]; index = parent;
    }
    heap[index] = item;
}

function heapPop(heap) {
    const first = heap[0], last = heap.pop();
    if (!heap.length) return first;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++;
        if (last.score <= heap[child].score) break;
        heap[index] = heap[child]; index = child;
    }
    heap[index] = last;
    return first;
}

export function clearWaterControls(bot) {
    for (const name of CONTROLS) bot.setControlState?.(name, false);
}

/** Follow each waypoint, with jump serving as the upward swim input.
 * One-block shoreline climbs need upward and forward inputs together.
 */
export function steerWaterRoute(bot, plan) {
    const p = bot.entity.position;
    while (plan.points.length > 1) {
        const next = plan.points[0];
        if (Math.hypot(next.x - p.x, next.z - p.z) > 0.38 || Math.abs(next.y - p.y) > 0.4) break;
        plan.points.shift();
    }
    const next = plan.points[0] ?? plan.target;
    const horizontal = Math.hypot(next.x - p.x, next.z - p.z);
    const controls = movementControlsTowardBearing(threatBearingRad(p, next), bot.entity.yaw ?? 0, 0.15);
    for (const name of ['forward', 'back', 'left', 'right']) bot.setControlState?.(name, horizontal > 0.15 && controls[name]);
    const wet = bodyInWater(bot);
    const dy = next.y - p.y;
    bot.setControlState?.('jump', Boolean((wet && (dy > 0.05
        || (dy >= -0.2 && (bot.entity.velocity?.y ?? 0) < 0)))
        || (bot.entity.onGround && dy > 0.4)
        || (wet && bot.entity.isCollidedHorizontally && dy >= -0.2))
        && !jumpBlockedByFarmland(bot, p, next));
    bot.setControlState?.('sprint', false);
    return next;
}
