/**
 * Tracks players needed by the follow behavior.
 */
export class WorldState {
    constructor() {
        this.visiblePlayers = [];
        this.ownerVisible = false;
    }

    /**
     * @param {import('./CompanionContext.js').CompanionContext} ctx
     */
    update(ctx) {
        const bot = ctx.bot;
        const config = ctx.config;
        const pos = bot.entity.position;
        const yaw = bot.entity.yaw;

        const players = [];
        for (const name of Object.keys(bot.players)) {
            if (name === bot.username) continue;
            const entity = bot.players[name]?.entity;
            if (!entity) continue;
            const distance = pos.distanceTo(entity.position);
            if (distance > config.scan_radius) continue;
            players.push({ name, entity, distance, inFov: isInFov(pos, yaw, entity.position, config.fov_degrees) });
        }
        players.sort((a, b) => a.distance - b.distance);
        this.visiblePlayers = players.filter((p) => {
            if (!p.inFov) return false;
            try {
                return typeof bot.canSeeEntity === 'function' ? bot.canSeeEntity(p.entity) : true;
            } catch {
                return true;
            }
        });

        if (ctx.ownerName) {
            const owner = players.find((p) => p.name === ctx.ownerName);
            this.ownerVisible = !!(owner && (owner.inFov || owner.distance <= config.owner_near_radius));
        } else {
            this.ownerVisible = false;
        }
    }
}

function isInFov(origin, yaw, targetPos, fovDegrees) {
    const dx = targetPos.x - origin.x;
    const dz = targetPos.z - origin.z;
    const angleTo = Math.atan2(-dx, -dz); // mineflayer yaw convention
    let diff = angleTo - yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= (fovDegrees * Math.PI) / 180 / 2;
}
