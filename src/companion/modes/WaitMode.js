import { Mode } from '../Mode.js';

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
        // Keep pathfinder idle; recovery interrupt still runs for stuck/hole cases.
        if (ctx.movement.hasGoal) {
            ctx.movement.stop();
        }
    }
}
