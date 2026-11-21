import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { maybePlaceSupportTorch } from '../torchSupport.js';
import {
    action,
    condition,
    selector,
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
        super('normal', targets);
        /** @type {'follow'|'wait'|null} Mode whose onEnter has run. */
        this._mode = null;

        const { followMode, waitMode } = targets;
        const bow = () => selector('視線への反応', [
            action('目が合った相手にお辞儀をする', (ctx) => targets.agent.companion?.eyeContact?.tick(ctx)),
            condition('視線への反応は不要', () => true)
        ]);
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
                }),
                bow()
            ], { mode: 'follow' }),
            wait: sequence('待機モードの平常時', [
                subtree('その場で待機する', waitMode.tree, (ctx) => waitMode.tick(ctx)),
                bow()
            ], { mode: 'wait' })
        };
    }

    /** The tree of the mode the player has selected (what the dashboard shows). */
    get tree() {
        return this.trees[this.targets.preferredMode === 'wait' ? 'wait' : 'follow'];
    }

    onStateEntered() {
        super.onStateEntered();
        this._enterMode(this.targets.preferredMode);
    }

    onStateExited() {
        this.targets.agent.companion?.eyeContact?.cancel?.(this.targets.ctx);
        this._exitMode();
        super.onStateExited();
    }

    prepareTick() {
        const { targets } = this;
        // A switch made while another state owned the bot simply takes
        // effect here, on the first normal tick.
        if (targets.preferredMode !== this._mode) {
            this._exitMode();
            this._enterMode(targets.preferredMode);
        }
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
