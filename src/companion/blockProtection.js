import pf from 'mineflayer-pathfinder';

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
 */
export function canBreakUnderProtection() {
    return !policy.enabled;
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
    return movements;
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
 * Set pathfinder movements: safe when protection is on, otherwise default.
 * @param {import('mineflayer').Bot} bot
 */
export function setPathfinderMovements(bot) {
    bot.pathfinder.setMovements(
        policy.enabled ? createSafeMovements(bot) : new pf.Movements(bot)
    );
}
