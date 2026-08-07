import Vec3 from 'vec3';
import { isDoorPassableName } from '../blockProtection.js';

/** Half-width of the scanned grid (2 = 5x5 columns around the bot). */
const RADIUS = 2;
/** How far up/down a column is searched for a place to stand. */
const SEARCH_UP = 2;
const SEARCH_DOWN = 3;
/** A cell counts as "toward the target" above this alignment. */
const TOWARD_ALIGNMENT = 0.3;

/**
 * Snapshot of the walkable terrain around the bot.
 *
 * `rise` is the height of the standing surface of a column relative to the
 * bot's feet: 0 is flat, +1 is a one-block step up, -1 a step down, and null
 * means there is nowhere to stand (a wall, or a drop deeper than the scan).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{x: number, y: number, z: number}} target
 */
export function scanSurroundings(bot, target) {
    const pos = bot.entity.position;
    const feetY = Math.floor(pos.y + 0.001);
    const baseX = Math.floor(pos.x);
    const baseZ = Math.floor(pos.z);
    const facing = unitToward(pos, target);

    const cells = [];
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
            cells.push(readColumn(bot, baseX + dx, feetY, baseZ + dz, dx, dz));
        }
    }

    const neighbours = cells.filter((c) => c.ring === 1);
    const toward = neighbours.filter((c) => alignment(c, facing) >= TOWARD_ALIGNMENT);
    const raisedNeighbors = neighbours.filter((c) => c.rise !== null && c.rise >= 1).length;

    return {
        facing,
        feetY,
        grid: renderGrid(cells),
        front: describeFront(bot, cells, facing, baseX, feetY, baseZ),
        walkable: toward.filter((c) => c.rise === 0),
        stepUps: toward
            .filter((c) => c.rise === 1)
            .sort((a, b) => alignment(b, facing) - alignment(a, facing)),
        stepDowns: toward
            .filter((c) => c.rise === -1)
            .sort((a, b) => alignment(b, facing) - alignment(a, facing)),
        // Escaping a hole may need a step that points away from the owner.
        escapes: neighbours
            .filter((c) => c.rise === 1)
            .sort((a, b) => alignment(b, facing) - alignment(a, facing)),
        raisedNeighbors
    };
}

/**
 * The three columns straight ahead: left-diagonal, ahead, right-diagonal.
 * This is the shape that keeps blocking the bot (raised middle, flat sides).
 */
function describeFront(bot, cells, facing, baseX, feetY, baseZ) {
    const fx = Math.round(facing.x);
    const fz = Math.round(facing.z);
    if (fx === 0 && fz === 0) return [];

    // Perpendicular to the facing direction.
    const px = -fz;
    const pz = fx;
    const offsets = [
        { dx: fx + px, dz: fz + pz, side: 'left' },
        { dx: fx, dz: fz, side: 'ahead' },
        { dx: fx - px, dz: fz - pz, side: 'right' }
    ];

    return offsets.map(({ dx, dz, side }) => {
        const cell = cells.find((c) => c.dx === dx && c.dz === dz);
        const obstacle = bot.blockAt(new Vec3(baseX + dx, feetY, baseZ + dz));
        const name = obstacle?.name || 'unknown';
        const openPassage = isOpenPassageBlock(obstacle);
        return {
            side,
            rise: cell ? cell.rise : null,
            block: name,
            position: obstacle?.position
                ? { x: obstacle.position.x, y: obstacle.position.y, z: obstacle.position.z }
                : { x: baseX + dx, y: feetY, z: baseZ + dz },
            solid: !openPassage && obstacle?.boundingBox === 'block'
        };
    });
}

/**
 * Open wooden doors / gates should not count as solid walls for recovery decisions.
 * @param {{ name?: string, _properties?: { open?: boolean, half?: string } }|null|undefined} block
 */
function isOpenPassageBlock(block) {
    if (!isDoorPassableName(block?.name)) return false;
    return block._properties?.open === true || block._properties?.half === 'upper';
}

/**
 * @returns {{dx: number, dz: number, ring: number, rise: number|null, center: import('vec3').Vec3}}
 */
function readColumn(bot, x, feetY, z, dx, dz) {
    let rise = null;
    for (let dy = SEARCH_UP; dy >= -SEARCH_DOWN; dy--) {
        const floor = bot.blockAt(new Vec3(x, feetY + dy - 1, z));
        if (!floor || floor.boundingBox !== 'block') continue;
        const body = bot.blockAt(new Vec3(x, feetY + dy, z));
        const head = bot.blockAt(new Vec3(x, feetY + dy + 1, z));
        if (body?.boundingBox === 'block' || head?.boundingBox === 'block') continue;
        rise = dy;
        break;
    }
    return {
        dx,
        dz,
        ring: Math.max(Math.abs(dx), Math.abs(dz)),
        rise,
        center: new Vec3(x + 0.5, feetY + (rise ?? 0), z + 0.5)
    };
}

/** Compact rows for the log, one string per Z line. */
function renderGrid(cells) {
    const rows = [];
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        const row = cells
            .filter((c) => c.dz === dz)
            .sort((a, b) => a.dx - b.dx)
            .map((c) => (c.rise === null ? ' X' : c.rise > 0 ? `+${c.rise}` : `${c.rise}`).padStart(2))
            .join(' ');
        rows.push(row);
    }
    return rows;
}

function unitToward(from, to) {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
}

function alignment(cell, facing) {
    const len = Math.hypot(cell.dx, cell.dz) || 1;
    return (cell.dx / len) * facing.x + (cell.dz / len) * facing.z;
}
