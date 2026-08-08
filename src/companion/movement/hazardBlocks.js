import { Vec3 } from 'vec3';

export const CONTACT_HAZARD_RADIUS = 0.31;
const SAFE_CLEARANCE = 0.8;
const DEFAULT_SEARCH_RADIUS = 5;

const DAMAGE_BLOCKS = new Set([
    'lava',
    'fire',
    'soul_fire',
    'magma_block',
    'campfire',
    'soul_campfire',
    'cactus',
    'sweet_berry_bush',
    'wither_rose',
    'powder_snow',
    'pointed_dripstone'
]);

const PASSABLE_LIQUIDS = new Set(['water', 'bubble_column']);

/** Whether a block can cause contact or standing damage. */
export function isDamageBlock(block) {
    const name = block?.name;
    if (!name || !DAMAGE_BLOCKS.has(name)) return false;
    const properties = typeof block.getProperties === 'function'
        ? block.getProperties()
        : block?._properties;
    if ((name === 'campfire' || name === 'soul_campfire')
        && properties?.lit === false) {
        return false;
    }
    return true;
}

export function isPassableLiquid(block) {
    return PASSABLE_LIQUIDS.has(block?.name);
}

/**
 * Damage blocks intersecting the bot body or supporting surface.
 * The AABB scan also catches cactus contact from a neighbouring cell.
 */
export function findContactHazards(bot, position = bot?.entity?.position) {
    return findHazardsAround(bot, position, CONTACT_HAZARD_RADIUS);
}

/** Find a nearby standable cell with clearance from every known damage block. */
export function findSafeEscapePosition(
    bot,
    position = bot?.entity?.position,
    hazards = findContactHazards(bot, position),
    maxRadius = DEFAULT_SEARCH_RADIUS
) {
    if (!position || typeof bot?.blockAt !== 'function') return null;
    const baseY = Math.floor(position.y + 0.01);

    for (let radius = 1; radius <= maxRadius; radius++) {
        const candidates = [];
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                for (const dy of [0, 1, -1]) {
                    const candidate = {
                        x: Math.floor(position.x) + dx + 0.5,
                        y: baseY + dy,
                        z: Math.floor(position.z) + dz + 0.5
                    };
                    if (!isSafeStandPosition(bot, candidate)) continue;
                    if (!isEscapeCorridorOpen(bot, position, candidate)) continue;
                    candidates.push(candidate);
                }
            }
        }
        if (candidates.length > 0) {
            return candidates.sort((a, b) => (
                escapeCandidateScore(position, a, hazards)
                - escapeCandidateScore(position, b, hazards)
            ))[0];
        }
    }
    return null;
}

/** True when the bot can stand here without touching or bordering a hazard. */
export function isSafeStandPosition(bot, position) {
    if (!position || typeof bot?.blockAt !== 'function') return false;
    const feet = blockAt(bot, position.x, position.y, position.z);
    const head = blockAt(bot, position.x, position.y + 1, position.z);
    // Entity Y is its feet coordinate. A small epsilon finds the actual
    // supporting cell on slabs/carpets as well as on full blocks.
    const support = blockAt(bot, position.x, position.y - 0.05, position.z);
    if (!isPassableAt(feet, position) || !isPassableBlock(head)) return false;
    if (!isStandableSupport(support, position) && !isPassableLiquid(feet)) {
        return false;
    }
    return findHazardsAround(bot, position, SAFE_CLEARANCE).length === 0;
}

export function findHazardsAround(bot, position, horizontalPadding) {
    if (!position || typeof bot?.blockAt !== 'function') return [];
    const height = bot.entity?.height ?? 1.8;
    const minX = Math.floor(position.x - horizontalPadding);
    const maxX = Math.floor(position.x + horizontalPadding);
    const minZ = Math.floor(position.z - horizontalPadding);
    const maxZ = Math.floor(position.z + horizontalPadding);
    const minY = Math.floor(position.y);
    const maxY = Math.floor(position.y + height - 0.01);
    const supportY = Math.floor(position.y - 0.05);
    const hazards = [];
    const seen = new Set();

    for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
            for (let y = Math.min(minY, supportY); y <= maxY; y++) {
                const block = blockAt(bot, x, y, z);
                if (!isDamageBlock(block)) continue;
                const key = `${x},${y},${z}`;
                if (seen.has(key)) continue;
                seen.add(key);
                hazards.push({ block, position: { x, y, z } });
            }
        }
    }
    return hazards;
}

export function isPassableBlock(block) {
    if (!block || isDamageBlock(block)) return false;
    return block.boundingBox === 'empty'
        || block.name === 'air'
        || block.name === 'cave_air'
        || block.name === 'void_air'
        || isPassableLiquid(block);
}

export function blockAt(bot, x, y, z) {
    return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
}

function isPassableAt(block, position) {
    if (isPassableBlock(block)) return true;
    if (!block || isDamageBlock(block)) return false;
    const localY = position.y - Math.floor(position.y);
    return collisionTopAt(block, position.x, position.z) <= localY + 0.02;
}

function isStandableSupport(block, position) {
    if (!block || isDamageBlock(block) || block.boundingBox !== 'block') return false;
    const supportY = Math.floor(position.y - 0.05);
    const surfaceY = supportY + collisionTopAt(block, position.x, position.z);
    return Math.abs(position.y - surfaceY) <= 0.11;
}

function collisionTopAt(block, worldX, worldZ) {
    const localX = worldX - Math.floor(worldX);
    const localZ = worldZ - Math.floor(worldZ);
    const matchingShapes = (block.shapes || []).filter((shape) => (
        localX >= shape[0] - 0.001
        && localX <= shape[3] + 0.001
        && localZ >= shape[2] - 0.001
        && localZ <= shape[5] + 0.001
    ));
    if (matchingShapes.length > 0) {
        return Math.max(...matchingShapes.map((shape) => shape[4]));
    }
    return block.boundingBox === 'block' ? 1 : 0;
}

function isEscapeCorridorOpen(bot, from, to) {
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(distance * 2));
    for (let step = 1; step < steps; step++) {
        const ratio = step / steps;
        const x = from.x + (to.x - from.x) * ratio;
        const y = from.y + (to.y - from.y) * ratio;
        const z = from.z + (to.z - from.z) * ratio;
        if (!isOpenDuringEscape(blockAt(bot, x, y, z))) return false;
        if (!isOpenDuringEscape(blockAt(bot, x, y + 1, z))) return false;
    }
    return true;
}

function isOpenDuringEscape(block) {
    if (!block) return false;
    if (isDamageBlock(block)) return block.boundingBox !== 'block';
    return isPassableBlock(block);
}

function escapeCandidateScore(origin, candidate, hazards) {
    const travel = Math.hypot(
        candidate.x - origin.x,
        candidate.z - origin.z
    ) + Math.abs(candidate.y - origin.y) * 1.25;
    if (hazards.length === 0) return travel;
    const nearestHazard = Math.min(...hazards.map((hazard) => Math.hypot(
        candidate.x - (hazard.position.x + 0.5),
        candidate.z - (hazard.position.z + 0.5)
    )));
    return travel - nearestHazard * 0.35;
}
