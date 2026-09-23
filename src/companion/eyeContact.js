import { hasLineOfSight } from '../world/lineOfSight.js';

export const HEAD_RADIUS = 0.4;
const EYE_HEIGHT = 1.62;
const MOVEMENT_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

export const DEFAULT_EYE_CONTACT_CONFIG = {
    enabled: true,
    max_distance: 8,
    dwell_ms: 500,
    cooldown_ms: 15000,
    chat_chance: 0.3
};

/**
 * Whether the viewer's crosshair ray intersects the target's head sphere.
 * Mineflayer yaw 0 faces -Z and positive pitch faces upward.
 *
 * @param {{ position: { x:number, y:number, z:number }, yaw:number, pitch:number }} viewer
 * @param {{ position: { x:number, y:number, z:number } }} target
 * @param {{ maxDistance:number }} options
 */
export function isLookingAt(viewer, target, { maxDistance }) {
    const dx = target.position.x - viewer.position.x;
    const dy = target.position.y - viewer.position.y;
    const dz = target.position.z - viewer.position.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > maxDistance * maxDistance) return false;

    const cosPitch = Math.cos(viewer.pitch);
    const viewX = -Math.sin(viewer.yaw) * cosPitch;
    const viewY = Math.sin(viewer.pitch);
    const viewZ = -Math.cos(viewer.yaw) * cosPitch;
    const forwardDistance = dx * viewX + dy * viewY + dz * viewZ;
    if (forwardDistance <= 0) return false;

    const rayDistanceSquared = distanceSquared - forwardDistance * forwardDistance;
    return rayDistanceSquared <= HEAD_RADIUS * HEAD_RADIUS;
}

export class EyeContactReaction {
    /**
     * @param {object} config
     * @param {{ now?:()=>number, random?:()=>number, manager?:object, dialogue?:object }} [options]
     */
    constructor(config = {}, options = {}) {
        this.config = { ...DEFAULT_EYE_CONTACT_CONFIG, ...config };
        this.now = options.now || Date.now;
        this.random = options.random || Math.random;
        this.manager = options.manager || null;
        this.dialogue = options.dialogue || null;
        this.state = 'watching';
        this.watchingSince = null;
        this.reactionStep = 0;
        this.restStartedAt = 0;
        this.lookedAway = false;
    }

    /** @param {import('./CompanionContext.js').CompanionContext} ctx */
    async tick(ctx) {
        const now = this.now();
        const owner = ctx.ownerEntity;

        if (this.config.enabled === false) {
            this._setSneaking(ctx.bot, false);
            this._reset();
            return;
        }

        if (this.state === 'reacting') {
            if (!this._canReact(ctx, owner)) {
                this._setSneaking(ctx.bot, false);
                this._beginRest(now, owner, ctx.bot.entity);
                return;
            }
            await this._runReactionStep(ctx, owner, now);
            return;
        }

        const looking = Boolean(
            owner
            && ctx.bot.entity
            && isLookingAt(owner, ctx.bot.entity, {
                maxDistance: this.config.max_distance
            })
        );

        if (this.state === 'resting') {
            if (!looking) this.lookedAway = true;
            if (!this.lookedAway || now - this.restStartedAt < this.config.cooldown_ms) return;
            this.state = 'watching';
            this.watchingSince = null;
        }

        if (!this._canReact(ctx, owner) || !looking) {
            this.watchingSince = null;
            return;
        }

        if (this.watchingSince == null) this.watchingSince = now;
        if (now - this.watchingSince < this.config.dwell_ms) return;

        this.state = 'reacting';
        this.reactionStep = 0;
        await this._runReactionStep(ctx, owner, now);
    }

    _canReact(ctx, owner) {
        if (!ctx.ownerName || !owner) return false;

        const manager = this.manager || ctx.agent?.companion?.manager;
        const fsmId = manager?.getActiveFsmId?.();
        if (fsmId !== 'follow' && fsmId !== 'wait') return false;

        if (ctx.movement?.hasGoal || ctx.movement?.isMoving) return false;
        if (MOVEMENT_CONTROLS.some((control) => ctx.bot.getControlState?.(control))) return false;

        const dialogue = this.dialogue || ctx.agent?.companion?.dialogue;
        if (dialogue?.isActionBusy || ctx.itemTransfer?.active) return false;

        return hasLineOfSight(ctx.bot, owner);
    }

    async _runReactionStep(ctx, owner, now) {
        await lookAtFace(ctx.bot, owner);

        if (this.reactionStep === 0 || this.reactionStep === 2) {
            this._setSneaking(ctx.bot, true);
        } else {
            this._setSneaking(ctx.bot, false);
        }

        if (this.reactionStep === 3) {
            const dialogue = this.dialogue || ctx.agent?.companion?.dialogue;
            if (this.random() < this.config.chat_chance) {
                await dialogue?.speakEyeContact?.();
            }
            this._beginRest(now, owner, ctx.bot.entity);
            return;
        }

        this.reactionStep++;
    }

    _setSneaking(bot, enabled) {
        if (bot.getControlState?.('sneak') === enabled) return;
        bot.setControlState?.('sneak', enabled);
    }

    _beginRest(now, owner, botEntity) {
        this.state = 'resting';
        this.watchingSince = null;
        this.reactionStep = 0;
        this.restStartedAt = now;
        this.lookedAway = !owner || !botEntity || !isLookingAt(owner, botEntity, {
            maxDistance: this.config.max_distance
        });
    }

    _reset() {
        this.state = 'watching';
        this.watchingSince = null;
        this.reactionStep = 0;
        this.restStartedAt = 0;
        this.lookedAway = false;
    }
}

async function lookAtFace(bot, target) {
    const dx = target.position.x - bot.entity.position.x;
    const dy = target.position.y + EYE_HEIGHT - (bot.entity.position.y + EYE_HEIGHT);
    const dz = target.position.z - bot.entity.position.z;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    await bot.look(yaw, pitch, true);
}
