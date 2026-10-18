import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { maybePlaceSupportTorch } from '../torchSupport.js';
import {
    action,
    condition,
    runTree,
    selector,
    sequence,
    subtree
} from '../../behaviorTree/bt.js';

/**
 * Normal state: nothing urgent owns the bot, so it does what the
 * player-selected mode asks. The mode is a setting, not a state — switching
 * it only changes which branch of this tree runs.
 */
export class NormalBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('normal');
        this.targets = targets;
        /** @type {'follow'|'wait'|null} Mode whose onEnter has run. */
        this._mode = null;

        const { followMode, waitMode } = targets;
        this.tree = selector('モードで分岐', [
            sequence('追従モード時の動作', [
                condition('モードが追従', () => this._mode === 'follow'),
                subtree('オーナーについていく', followMode.tree, (ctx) => followMode.tick(ctx)),
                action('暗ければ松明を置く', async (ctx) => {
                    try {
                        await maybePlaceSupportTorch(ctx, targets.agent);
                    } catch {
                        // 松明配置の失敗で追従を止めない。
                    }
                    return true;
                })
            ], { mode: 'follow' }),
            sequence('待機モード時の動作', [
                condition('モードが待機', () => this._mode === 'wait'),
                subtree('その場で待つ', waitMode.tree, (ctx) => waitMode.tick(ctx))
            ], { mode: 'wait' })
        ]);
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'normal';
        this._enterMode(this.targets.preferredMode);
    }

    onStateExited() {
        this._exitMode();
        super.onStateExited();
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        // A switch made while another state owned the bot simply takes
        // effect here, on the first normal tick.
        if (targets.preferredMode !== this._mode) {
            this._exitMode();
            this._enterMode(targets.preferredMode);
        }
        await runTree(this.tree, targets.ctx);
    }

    /** @param {'follow'|'wait'} modeId */
    _enterMode(modeId) {
        this._mode = modeId === 'wait' ? 'wait' : 'follow';
        void this._modeObject(this._mode).onEnter?.(this.targets.ctx);
    }

    _exitMode() {
        if (!this._mode) return;
        void this._modeObject(this._mode).onExit?.(this.targets.ctx);
        this._mode = null;
    }

    /** @param {'follow'|'wait'} modeId */
    _modeObject(modeId) {
        return modeId === 'wait' ? this.targets.waitMode : this.targets.followMode;
    }
}
