import { Mode } from '../Mode.js';
import { currentControlOwner } from '../ControlPriority.js';

/**
 * Stay put until another mode is selected (e.g. follow again).
 */
export class WaitMode extends Mode {
    constructor() {
        super({
            id: 'wait',
            description: 'Stop moving and wait in place until told otherwise'
        });
    }

    async onEnter(ctx) {
        ctx.movement.stop();
        try {
            ctx.bot.clearControlStates();
        } catch {
            // ignore
        }
    }

    async onExit(ctx) {
        ctx.movement.stop();
    }

    async tick(ctx) {
        // Recovery owns movement until grave/item/equipment work is complete.
        if (currentControlOwner(ctx, 'wait') !== 'wait') return;
        // Wait owns the idle destination, not tactical combat movement.
        // Reflexes still permits emergency self-defense/owner protection.
        if (ctx.agent.reflexes?.isControllingMovement) return;
        // Keep pathfinder idle; recovery interrupt still runs for stuck/hole cases.
        if (ctx.movement.hasGoal) {
            ctx.movement.stop();
        }
    }
}
