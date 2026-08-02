import {
    horizontalDistanceBetween,
    horizontalPointToSegmentDistance
} from './followGeometry.js';

/** Block only when a straight bot→target line passes this close to a player. */
export const PLAYER_PUSH_LANE = 1.25;
/** When already this close, the target must increase separation by at least this. */
const CLEARANCE_GAIN = 0.75;

/**
 * All nearby player entities whose space must not be crossed on a direct path.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 */
export function collectPathPlayers(ctx) {
    /** @type {import('prismarine-entity').Entity[]} */
    const players = [];
    const seen = new Set();
    const bot = ctx?.bot;

    const add = (player) => {
        if (!player?.position) return;
        const id = player.id ?? player.uuid ?? player.username ?? null;
        if (id != null) {
            if (seen.has(id)) return;
            seen.add(id);
        }
        if (bot?.entity?.id != null && player.id === bot.entity.id) return;
        players.push(player);
    };

    for (const name of Object.keys(bot?.players || {})) {
        add(bot.players[name]?.entity);
    }
    add(ctx?.ownerEntity);
    return players;
}

/**
 * True when moving bot→target would push through / scrape a player.
 * Also true when already inside the push lane and the target does not clearly
 * increase separation (pathfinder otherwise walks into the player).
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} targetPos
 * @param {number} [lane=PLAYER_PUSH_LANE]
 */
export function wouldPathPassNearPlayer(ctx, targetPos, lane = PLAYER_PUSH_LANE) {
    const botPos = ctx.bot?.entity?.position;
    if (!botPos || !targetPos || lane <= 0) return false;

    const toTargetX = targetPos.x - botPos.x;
    const toTargetZ = targetPos.z - botPos.z;
    const targetLen = Math.hypot(toTargetX, toTargetZ);
    if (targetLen < 0.05) return false;

    for (const player of collectPathPlayers(ctx)) {
        const playerPos = player.position;
        if (!playerPos) continue;

        const playerLen = horizontalDistanceBetween(botPos, playerPos);
        const targetClear = horizontalDistanceBetween(targetPos, playerPos);

        // Already overlapping / scraping — only allow goals that clearly step away.
        if (playerLen <= lane) {
            if (targetClear < playerLen + CLEARANCE_GAIN) return true;
            continue;
        }

        const pathDist = horizontalPointToSegmentDistance(playerPos, botPos, targetPos);
        if (pathDist > lane) continue;

        const toPlayerX = playerPos.x - botPos.x;
        const toPlayerZ = playerPos.z - botPos.z;
        const alongDot = toPlayerX * toTargetX + toPlayerZ * toTargetZ;
        if (alongDot <= 0) continue;

        if (playerLen > targetLen + 0.25) continue;

        return true;
    }
    return false;
}
