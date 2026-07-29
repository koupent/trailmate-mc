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
        // 墓・アイテム・装備の処理が終わるまでRecoveryが移動を所有する。
        if (currentControlOwner(ctx, 'wait') !== 'wait') return;
        // Waitが所有するのは待機目的地であり、戦術的な戦闘移動ではない。
        // Reflexesによる緊急自己防衛・owner防衛は引き続き許可する。
        if (ctx.agent.reflexes?.isControllingMovement) return;
        // Keep pathfinder idle; recovery interrupt still runs for stuck/hole cases.
        if (ctx.movement.hasGoal) {
            ctx.movement.stop();
        }
    }
}
