import pf from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import {
    findContactHazards,
    isDamageBlock
} from './movement/hazardBlocks.js';

/** Default block-light level at which spawn-proof torches may be placed (1.21 hostile spawn). */
export const DEFAULT_TORCH_LIGHT_THRESHOLD = 0;
export const MIN_TORCH_LIGHT_THRESHOLD = 0;
export const MAX_TORCH_LIGHT_THRESHOLD = 15;
/** Torch / wall_torch emit this much block light. */
export const TORCH_LIGHT_LEVEL = 14;
/** Default max fall distance for companion pathfinding. */
export const DEFAULT_SAFE_MAX_DROP_DOWN = 4;

const ALLOWED_PLACE_TYPES = new Set(['torch', 'wall_torch']);

/** @type {{ enabled: boolean, torchLightThreshold: number }} */
let policy = {
    enabled: false,
    torchLightThreshold: DEFAULT_TORCH_LIGHT_THRESHOLD
};

/** @type {string|null} temporary dig allow-list key "x,y,z" for own-grave recovery */
let allowedDigKey = null;

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Clamp a torch light threshold to the valid Minecraft range (0–15).
 * @param {unknown} value
 * @returns {number}
 */
export function clampTorchLightThreshold(value) {
    return clamp(
        value ?? DEFAULT_TORCH_LIGHT_THRESHOLD,
        MIN_TORCH_LIGHT_THRESHOLD,
        MAX_TORCH_LIGHT_THRESHOLD
    );
}

/**
 * Enable companion block protection (no dig, no scaffold, torch-only place).
 * @param {{ torchLightThreshold?: number }} [options]
 */
export function enableCompanionBlockProtection(options = {}) {
    policy = {
        enabled: true,
        torchLightThreshold: clampTorchLightThreshold(options.torchLightThreshold)
    };
}

/** Disable companion block protection (for tests / non-companion profiles). */
export function disableCompanionBlockProtection() {
    policy = {
        enabled: false,
        torchLightThreshold: DEFAULT_TORCH_LIGHT_THRESHOLD
    };
    allowedDigKey = null;
}

export function isBlockProtectionEnabled() {
    return policy.enabled;
}

export function getTorchLightThreshold() {
    return policy.torchLightThreshold;
}

/**
 * Whether placing this block type is allowed under the current policy.
 * @param {string} blockType
 */
export function canPlaceUnderProtection(blockType) {
    if (!policy.enabled) return true;
    if (!blockType) return false;
    return ALLOWED_PLACE_TYPES.has(blockType);
}

/**
 * Whether breaking blocks is allowed under the current policy.
 * Without a specific block, only unrestricted (protection off) digs are allowed.
 */
export function canBreakUnderProtection() {
    return !policy.enabled;
}

/**
 * Whether this concrete block may be broken.
 * When protection is on, only a temporarily allow-listed grave position is diggable.
 * @param {{ position?: { x: number, y: number, z: number } }|null|undefined} block
 */
export function canBreakBlockUnderProtection(block) {
    if (!policy.enabled) return true;
    if (!block?.position || !allowedDigKey) return false;
    return blockKey(block.position) === allowedDigKey;
}

/**
 * Allow digging exactly one block position (guarded exceptions under block protection).
 * @param {{ x: number, y: number, z: number }} pos
 */
export function allowDigAt(pos) {
    allowedDigKey = blockKey(pos);
}

/** Clear the temporary dig allow-list. */
export function clearAllowedDig() {
    allowedDigKey = null;
}

/**
 * @param {{ x: number, y: number, z: number }} pos
 */
function blockKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Wooden doors / fence gates pathfinder should treat as openable passages.
 * Iron doors and trapdoors are excluded.
 * @param {string|undefined|null} name
 */
export function isDoorPassableName(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (lower.includes('iron') || lower.includes('trapdoor')) return false;
    return lower.includes('door') || lower.includes('fence_gate');
}

/**
 * Mark an open passage walkable for A* only.
 * Do not clear shapes / boundingBox: those are shared with physics, and the
 * real door leaf must keep colliding so the client stays in sync with the server.
 * @param {{ name?: string, _properties?: { open?: boolean, half?: string }, safe?: boolean, physical?: boolean, openable?: boolean }|null|undefined} block
 * @returns {boolean} true if the block was marked walkable
 */
export function markDoorWalkableForPathfinder(block) {
    if (!block?.name || !isDoorPassableName(block.name)) return false;
    const props = block._properties || {};
    if (props.open !== true && props.half !== 'upper') return false;
    block.safe = true;
    block.physical = false;
    block.openable = false;
    return true;
}

/**
 * Center of the walkable gap in an open door cell (away from the leaf).
 * Uses shapes when present; otherwise reconstructs from facing/hinge.
 * @param {{
 *   position: { x: number, y: number, z: number },
 *   shapes?: number[][],
 *   _properties?: { open?: boolean, facing?: string, hinge?: string }
 * }} block
 * @returns {{ x: number, y: number, z: number }}
 */
export function computeDoorFreeCenter(block) {
    const pos = block.position;
    let localX = 0.5;
    let localZ = 0.5;

    const shape = block.shapes?.[0];
    if (shape) {
        const [x0, , z0, x1, , z1] = shape;
        const leafW = x1 - x0;
        const leafD = z1 - z0;
        if (leafW > 0 && leafW < 0.35) {
            const freeMin = x0 < 0.5 ? x1 : 0;
            const freeMax = x0 < 0.5 ? 1 : x0;
            localX = (freeMin + freeMax) / 2;
        } else if (leafD > 0 && leafD < 0.35) {
            const freeMin = z0 < 0.5 ? z1 : 0;
            const freeMax = z0 < 0.5 ? 1 : z0;
            localZ = (freeMin + freeMax) / 2;
        }
    } else {
        const facing = block._properties?.facing;
        const hinge = block._properties?.hinge;
        // Open door leaf positions by facing+hinge (minecraft collision tables).
        const leafWest =
            (facing === 'north' && hinge === 'left')
            || (facing === 'south' && hinge === 'right');
        const leafEast =
            (facing === 'north' && hinge === 'right')
            || (facing === 'south' && hinge === 'left');
        const leafNorth =
            (facing === 'east' && hinge === 'left')
            || (facing === 'west' && hinge === 'right');
        const leafSouth =
            (facing === 'east' && hinge === 'right')
            || (facing === 'west' && hinge === 'left');
        if (leafWest) localX = 0.594;
        else if (leafEast) localX = 0.406;
        else if (leafNorth) localZ = 0.594;
        else if (leafSouth) localZ = 0.406;
    }

    return { x: pos.x + localX, y: pos.y, z: pos.z + localZ };
}

/**
 * Open doors keep boundingBox=block, so stock pathfinder treats them as walls.
 * Upper halves must also be non-blocking or canOpenDoors never reaches the lower half.
 * @param {import('mineflayer-pathfinder').Movements} movements
 */
export function configureDoorAwareMovements(movements) {
    const registry = movements.bot?.registry;
    if (registry?.blocksArray) {
        for (const block of registry.blocksArray) {
            if (!isDoorPassableName(block.name)) continue;
            movements.openable.add(block.id);
        }
    }
    // Closed lower doors and gates remain available to A*. DoorTracker allows
    // activation only after the complete route proves a real crossing.
    movements.canOpenDoors = true;

    if (movements._trailmateDoorAware) return movements;
    movements._trailmateDoorAware = true;

    const originalGetBlock = movements.getBlock.bind(movements);
    movements.getBlock = (pos, dx, dy, dz) => {
        const block = originalGetBlock(pos, dx, dy, dz);
        if (!block?.name || !isDoorPassableName(block.name)) return block;

        const props = block._properties || {};
        const isOpen = props.open === true;
        const isUpperDoor = props.half === 'upper';

        // Open passages, and the upper half of a 2-block door, must not block A*.
        if (isOpen || isUpperDoor) {
            markDoorWalkableForPathfinder(block);
        }
        return block;
    };

    // A doorway is one block wide: corners cannot be cut, so the bot would
    // wedge against the wall beside the door. Keep door moves cardinal.
    const originalGetMoveDiagonal = movements.getMoveDiagonal.bind(movements);
    movements.getMoveDiagonal = (node, dir, neighbors) => {
        const cells = [
            movements.getBlock(node, dir.x, 0, dir.z),
            movements.getBlock(node, dir.x, 0, 0),
            movements.getBlock(node, 0, 0, dir.z)
        ];
        if (cells.some((cell) => isDoorPassableName(cell?.name))) return;
        return originalGetMoveDiagonal(node, dir, neighbors);
    };

    return movements;
}

/**
 * Apply non-destructive flags to an existing Movements instance.
 * @param {import('mineflayer-pathfinder').Movements} movements
 * @param {{ allowParkour?: boolean, allowSprinting?: boolean, maxDropDown?: number }} [options]
 */
export function applySafeMovementFlags(movements, options = {}) {
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = options.allowParkour !== false;
    movements.allowSprinting = options.allowSprinting === true;
    movements.maxDropDown = options.maxDropDown ?? DEFAULT_SAFE_MAX_DROP_DOWN;
    // Library typo: scafoldingBlocks. Empty = never place bridge/tower blocks.
    movements.scafoldingBlocks = [];
    configureDamageBlockAvoidance(movements);
    configureDoorAwareMovements(movements);
    return movements;
}

/**
 * Keep A* routes off both pass-through hazards and damaging support blocks.
 * Stock pathfinder only avoids fire/lava and otherwise permits magma,
 * campfires, berry bushes, wither roses, powder snow, and similar blocks.
 */
export function configureDamageBlockAvoidance(movements) {
    const registry = movements.bot?.registry;
    for (const block of registry?.blocksArray || []) {
        if (isDamageBlock(block)) movements.blocksToAvoid.add(block.id);
    }
    if (movements._trailmateDamageAvoidance) return movements;
    movements._trailmateDamageAvoidance = true;
    movements.exclusionAreasStep.push((block) => {
        if (!block?.position) return 0;
        const standPosition = new Vec3(
            block.position.x + 0.5,
            block.position.y,
            block.position.z + 0.5
        );
        return findContactHazards(movements.bot, standPosition).length > 0 ? 100 : 0;
    });
    return movements;
}

/**
 * Path nodes sit at cell centers, but an open door leaves only a side gap.
 * Retarget door nodes to that gap so the bot walks through instead of
 * scraping the leaf.
 * @param {import('mineflayer').Bot} bot
 * @param {Array<{ x: number, y: number, z: number }>} path
 * @returns {number} number of retargeted nodes
 */
export function alignPathToDoorGaps(bot, path) {
    if (!Array.isArray(path)) return 0;

    let aligned = 0;
    for (const node of path) {
        const block = bot.blockAt?.(new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)));
        if (!block?.name || !isDoorPassableName(block.name)) continue;
        if (block._properties?.open !== true) continue;

        const gap = computeDoorFreeCenter(block);
        node.x = gap.x;
        node.z = gap.z;
        aligned++;
    }
    return aligned;
}

/**
 * Non-destructive pathfinder movements: no dig, no towers, no scaffolding.
 * @param {import('mineflayer').Bot} bot
 * @param {{ allowParkour?: boolean, allowSprinting?: boolean, maxDropDown?: number }} [options]
 */
export function createSafeMovements(bot, options = {}) {
    return applySafeMovementFlags(new pf.Movements(bot), options);
}

/**
 * Plugins such as mineflayer-pvp swap in their own dig-enabled Movements and
 * never restore ours, which lets the bot mine doors and walls. Re-apply the
 * companion rules to whatever any plugin installs.
 * @param {import('mineflayer').Bot} bot
 */
export function enforceSafeMovements(bot) {
    if (!bot?.pathfinder || bot._trailmateMovementsGuard) return bot;
    bot._trailmateMovementsGuard = true;

    const originalSetMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
    bot.pathfinder.setMovements = (movements) => {
        originalSetMovements(applySafeMovementFlags(movements));
    };
    return bot;
}

/**
 * Set pathfinder movements: safe when protection is on, otherwise default.
 * @param {import('mineflayer').Bot} bot
 */
export function setPathfinderMovements(bot) {
    bot.pathfinder.setMovements(
        policy.enabled ? createSafeMovements(bot) : new pf.Movements(bot)
    );
}
