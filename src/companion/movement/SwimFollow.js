import { bodyInWater, planWaterRoute, steerWaterRoute, clearWaterControls, headInWater, waterTravelSeconds, AIR_SECONDS_PER_POINT, AIR_RESERVE_SECONDS } from './waterNavigation.js';

export const isInWater = bodyInWater;

/** Body-sized water/shore routes, with a return-to-air budget for each dive. */
export class SwimFollow {
    constructor() {
        this.active = false;
    }

    tick(ctx) {
        const { bot, ownerEntity: owner, movement } = ctx;
        const position = bot.entity?.position;
        if (!owner || bot.vehicle || !position
            || (!isInWater(bot, position) && !isInWater(bot, owner.position))) return false;
        if (!this.active) movement.stop();
        this.active = true;
        const range = ctx.config?.follow_distance ?? 3;
        const cell = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
        const ownerKey = `${Math.floor(owner.position.x)},${Math.round(owner.position.y)},${Math.floor(owner.position.z)}`;
        if (!this.plan || this.ownerKey !== ownerKey || this.cell !== cell) {
            // Approach in stages, so an unreachable deep owner cannot make
            // the bot spend the whole breath diving vertically in place.
            const target = { ...owner.position, y: Math.max(owner.position.y, position.y - 2) };
            this.plan = planWaterRoute(bot, { target, range });
            this.ownerKey = ownerKey; this.cell = cell;
        }
        if (!this.plan) {
            this.status = { phase: 'blocked' };
            // Let land A* handle distant approaches, but never continue a stale
            // pathfinder goal underwater when no safe body-sized path exists.
            clearWaterControls(bot);
            if (!isInWater(bot, position)) { this.active = false; return false; }
            bot.setControlState?.('jump', headInWater(bot));
            return true;
        }
        // Before committing the next submerged step, verify an affordable way
        // back to air from that waypoint. Oxygen is reserved for the return trip.
        const next = this.plan.points.find(p => position.distanceTo(p) > 0.4) ?? this.plan.target;
        if (headInWater(bot, next)) {
            const escape = planWaterRoute(bot, { from: next, air: true });
            const available = Math.max(0, (bot.oxygenLevel ?? (headInWater(bot) ? 0 : 20)) - 0.5) * AIR_SECONDS_PER_POINT;
            if (!escape || available < waterTravelSeconds(position, next) + escape.seconds + AIR_RESERVE_SECONDS + 1) {
                this.status = { phase: 'holding', availableSeconds: available,
                    returnSeconds: escape?.seconds ?? null };
                if (headInWater(bot)) ctx.hazardEscape?.requestAirReturn?.();
                clearWaterControls(bot);
                bot.setControlState?.('jump', headInWater(bot));
                return true;
            }
        }
        this.status = { phase: 'following' };
        steerWaterRoute(bot, this.plan);
        return true;
    }

    release(ctx) {
        if (!this.active) return;
        this.active = false;
        this.status = null;
        // Safety claim already issued the replacement controls before FSM exit.
        if (ctx.hazardEscape?.active) return;
        clearWaterControls(ctx.bot);
        this.plan = null;
    }
}
