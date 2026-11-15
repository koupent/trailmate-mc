import { blockAt, isPassableBlock, isPassableLiquid } from './hazardBlocks.js';
import { movementControlsTowardBearing, threatBearingRad } from '../../combat/threatArc.js';

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

export function isInWater(bot, position) {
    return Boolean(position && typeof bot?.blockAt === 'function' && (
        isPassableLiquid(blockAt(bot, position.x, position.y, position.z))
        || isPassableLiquid(blockAt(bot, position.x, position.y + 1, position.z))
    ));
}

/** Local water steering; land entry and routes around obstructions stay with A*. */
export class SwimFollow {
    constructor() {
        this.active = false;
    }

    tick(ctx) {
        const { bot, ownerEntity: owner, movement } = ctx;
        const position = bot.entity?.position;
        if (!owner || bot.vehicle || !isInWater(bot, position)
            || !isInWater(bot, owner.position)
            || !waterCorridorOpen(bot, position, owner.position)) return false;

        if (!this.active) movement.stop();
        this.active = true;
        const horizontal = Math.hypot(owner.position.x - position.x, owner.position.z - position.z);
        const range = ctx.config?.follow_distance ?? 3;
        const controls = movementControlsTowardBearing(
            threatBearingRad(position, owner.position), bot.entity.yaw ?? 0, 0.15
        );
        for (const control of ['forward', 'back', 'left', 'right']) {
            bot.setControlState?.(control, horizontal > range && controls[control]);
        }
        // prismarine-physics swims upward with jump and descends by buoyancy/gravity.
        // Pulse jump near the owner's depth to prevent sinking while stationary.
        const dy = owner.position.y - position.y;
        bot.setControlState?.('jump', dy > 0.2
            || (dy >= -0.2 && (bot.entity.velocity?.y ?? 0) <= 0));
        // Ordinary swimming conserves hunger; it does not require sprinting.
        bot.setControlState?.('sprint', false);
        return true;
    }

    release(ctx) {
        if (!this.active) return;
        this.active = false;
        // Safety claim already issued the replacement controls before FSM exit.
        if (ctx.hazardEscape?.active) return;
        for (const control of CONTROLS) ctx.bot.setControlState?.(control, false);
    }
}

function waterCorridorOpen(bot, from, to) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    if (distance > 16) return false;
    const steps = Math.max(1, Math.ceil(distance * 4));
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const z = from.z + (to.z - from.z) * t;
        for (const dx of [-0.3, 0.3]) {
            for (const dz of [-0.3, 0.3]) {
                if (!isPassableBlock(blockAt(bot, x + dx, y, z + dz))
                    || !isPassableBlock(blockAt(bot, x + dx, y + 1, z + dz))) return false;
            }
        }
    }
    return true;
}
