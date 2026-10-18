import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { maybePlaceSupportTorch } from '../torchSupport.js';
import {
    action,
    runTree,
    sequence,
    subtree
} from '../../behaviorTree/bt.js';

/**
 * Normal state: nothing urgent owns the bot, so it does what the
 * player-selected mode asks. The mode is a setting above the state machine —
 * switching it swaps the tree this state runs, not the state.
 */
export class NormalBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('normal');
        this.targets = targets;
        /** @type {'follow'|'wait'|null} Mode whose onEnter has run. */
        this._mode = null;

        const { followMode, waitMode } = targets;
        // One tree per mode. The mode is chosen above the state machine, so
        // the normal state simply runs (and shows) the tree of that mode.
        this.trees = {
            follow: sequence('追従モードの平常時', [
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
            wait: subtree('待機モードの平常時', waitMode.tree, (ctx) => waitMode.tick(ctx), { mode: 'wait' })
        };
    }

    /** The tree of the mode the player has selected (what the dashboard shows). */
    get tree() {
        return this.trees[this.targets.preferredMode === 'wait' ? 'wait' : 'follow'];
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
        await runTree(this.trees[this._mode], targets.ctx);
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
