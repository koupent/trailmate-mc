import { AsyncTickBehavior } from './AsyncTickBehavior.js';

/** Stay within interaction range until a crossed door or gate is confirmed closed. */
export class PassageCleanupBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('passage_cleanup');
        this.targets = targets;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'passage_cleanup';
        this.targets.ctx.movement?.stop?.();
        this.targets.ctx.doors?.resumeCleanup?.();
    }

    onStateExited() {
        this.targets.ctx.doors?.suspendCleanup?.();
        super.onStateExited();
    }

    async runTick() {
        const { ctx } = this.targets;
        ctx.doors?.resumeCleanup?.();
        const target = ctx.doors?.cleanupTarget;
        const botPos = ctx.bot?.entity?.position;
        if (!target || !botPos) return;

        const movement = ctx.movement;
        if (movement?.isBlocked || movement?.isUnreachable) {
            movement.stop?.();
            ctx.doors.failCleanup?.('unreachable');
            return;
        }

        const center = {
            x: target.doorPos.x + 0.5,
            y: target.doorPos.y,
            z: target.doorPos.z + 0.5
        };
        const distance = Math.hypot(
            botPos.x - center.x,
            botPos.y - center.y,
            botPos.z - center.z
        );

        if (distance > 3.5) {
            movement?.goToward?.(center, 2.5);
            return;
        }

        movement?.stop?.();
        await ctx.doors.tick({ allowClose: true });
    }
}
