import { bodyInWater, planWaterRoute, steerWaterRoute, clearWaterControls, headInWater, waterTravelSeconds, AIR_SECONDS_PER_POINT, AIR_RESERVE_SECONDS, waterNodeOpen } from './waterNavigation.js';

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
        const now = movement.now?.() ?? Date.now();
        const horizontal = Math.hypot(owner.position.x - position.x, owner.position.z - position.z);
        const dy = owner.position.y - position.y;
        const ownerOnLand = !isInWater(bot, owner.position)
            && bot.blockAt?.(owner.position.offset(0, -0.05, 0))?.boundingBox === 'block';
        // Landing hands back to walking only when the owner is on land too.
        // A grounded bot must still be able to enter deep water after a diver.
        if (!isInWater(bot) && bot.entity.onGround && ownerOnLand) return false;
        const mustExit = ownerOnLand && isInWater(bot);
        const close = horizontal <= range && Math.abs(dy) <= 0.8;
        if (!mustExit && (close || (this.holding && horizontal <= range + 0.8 && Math.abs(dy) <= 1.1))) {
            this.holding = true;
            this.plan = null;
            this.status = { phase: 'near' };
            clearWaterControls(bot);
            // Stay at depth without walking back to a voxel's center.
            bot.setControlState?.('jump', isInWater(bot) && (dy > 0.15
                || (dy >= -0.25 && (bot.entity.velocity?.y ?? 0) < -0.02)));
            return true;
        }
        this.holding = false;
        if (!this.progress || position.distanceTo(this.progress) > 0.25) {
            this.progress = position.clone(); this.progressAt = now;
        }
        const stalled = now - this.progressAt > 1500;
        const ownerMoved = !this.plannedOwner || owner.position.distanceTo(this.plannedOwner) > 1;
        const urgent = this.plannedOwner && (owner.position.distanceTo(this.plannedOwner) > 4
            || (this.plannedOwner.y - position.y) * dy < 0
            || (this.plannedOwner.x - position.x) * (owner.position.x - position.x)
                + (this.plannedOwner.z - position.z) * (owner.position.z - position.z) < 0);
        const reachedIntermediate = this.plan && this.plan.points.length <= 1
            && position.distanceTo(this.plan.target) < 0.8
            && (horizontal > range + 0.2 || Math.abs(dy) > 0.8);
        const invalid = this.plan?.points.some(point => !waterNodeOpen(bot, point));
        if ((!this.plan && (this.plannedAt == null || now - this.plannedAt >= 750))
            || invalid || stalled || urgent || reachedIntermediate || (ownerMoved && now - this.plannedAt >= 750)) {
            const scale = Math.min(1, 8 / Math.max(0.01, horizontal));
            const target = { x: position.x + (owner.position.x - position.x) * scale,
                z: position.z + (owner.position.z - position.z) * scale,
                y: Math.max(owner.position.y, position.y - 2) };
            this.plan = planWaterRoute(bot, { target, range: Math.max(0, (scale < 1 ? 1 : range) - 0.5), maxNodes: 2000 });
            this.plannedOwner = owner.position.clone(); this.plannedAt = now;
            if (stalled) { this.progress = position.clone(); this.progressAt = now; }
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
            const key = `${Math.floor(next.x)},${Math.floor(next.y)},${Math.floor(next.z)}`;
            if (this.airKey !== key || now - (this.airAt ?? 0) > 750) {
                this.airRoute = planWaterRoute(bot, { from: next, air: true });
                this.airKey = key; this.airAt = now;
            }
            const escape = this.airRoute;
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
        this.holding = false;
        this.plan = null;
        this.progress = null;
        this.airKey = null;
        // Safety claim already issued the replacement controls before FSM exit.
        if (ctx.hazardEscape?.active) return;
        clearWaterControls(ctx.bot);
        this.plan = null;
    }
}
