import { Vec3 } from 'vec3';

/**
 * Jumping off farmland, and landing on it from a jump or a fall, reverts the
 * block to dirt and destroys whatever was planted on it. Whether a crop is
 * already growing there makes no difference: the support block alone decides.
 */
const FARMLAND_BLOCK = 'farmland';

/**
 * Entity Y is the feet coordinate and farmland is only 15/16 of a block tall,
 * so the supporting cell sits just below the feet instead of a full block down.
 * The same probe also resolves block-aligned feet coordinates (y - 0.05 stays
 * inside the cell below), which is what path nodes and scan cells report.
 */
const SUPPORT_PROBE_DEPTH = 0.05;

/**
 * @param {{ name?: string }|null|undefined} block
 */
export function isFarmlandBlock(block) {
    return block?.name === FARMLAND_BLOCK;
}

/**
 * Block carrying the weight of a standing position.
 * @param {{ blockAt?: (pos: Vec3) => any }|null|undefined} bot
 * @param {{ x: number, y: number, z: number }|null|undefined} position feet coordinate
 */
export function supportBlockAt(bot, position) {
    if (!position || typeof bot?.blockAt !== 'function') return null;
    return bot.blockAt(new Vec3(
        Math.floor(position.x),
        Math.floor(position.y - SUPPORT_PROBE_DEPTH),
        Math.floor(position.z)
    ));
}

/**
 * Whether a jump or a fall between these two positions would trample farmland.
 * Either end disqualifies the move: the take-off breaks the block pushed off,
 * the landing breaks the block dropped onto. Pass null for an end that does not
 * exist, such as the landing of a straight-up swim jump.
 *
 * Walking stays unaffected, so flat farmland remains crossable and plantable.
 *
 * @param {{ blockAt?: (pos: Vec3) => any }|null|undefined} bot
 * @param {{ x: number, y: number, z: number }|null|undefined} takeoff feet coordinate
 * @param {{ x: number, y: number, z: number }|null|undefined} landing feet coordinate
 */
export function jumpBlockedByFarmland(bot, takeoff, landing) {
    return isFarmlandBlock(supportBlockAt(bot, takeoff))
        || isFarmlandBlock(supportBlockAt(bot, landing));
}
