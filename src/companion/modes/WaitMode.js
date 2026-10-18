import { Mode } from '../Mode.js';
import { action, condition, FAILURE, runTree, selector, sequence } from '../behaviorTree/bt.js';
import { yieldsOutsideMachine } from '../ControlPriority.js';

/**
 * Stay put until another mode is selected (e.g. follow again).
 */
export class WaitMode extends Mode {
    constructor() {
        super({
            id: 'wait',
            description: 'Stop moving and wait in place until told otherwise'
        });
        this.tree = selector('待機の手順', [
            sequence('動いていたら止まる', [
                condition('移動の目標が残っている', (ctx) => Boolean(ctx.movement.hasGoal)),
                action('立ち止まる', (ctx) => {
                    ctx.movement.stop();
                    return true;
                })
            ]),
            action('その場で待つ', () => true)
        ]);
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

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @returns {Promise<'success'|'failure'>}
     */
    async tick(ctx) {
        if (yieldsOutsideMachine(ctx, 'wait')) return FAILURE;
        return runTree(this.tree, ctx);
    }
}
