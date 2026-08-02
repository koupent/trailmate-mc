import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { maybePlaceSupportTorch } from '../torchSupport.js';

/**
 * Owner follow — wraps FollowMode and optional torch support.
 */
export class FollowBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     */
    constructor(targets) {
        super('follow');
        this.targets = targets;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'follow';
        this.targets.resumeMode = 'follow';
        void this.targets.followMode.onEnter?.(this.targets.ctx);
    }

    onStateExited() {
        void this.targets.followMode.onExit?.(this.targets.ctx);
        super.onStateExited();
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        await targets.followMode.tick(targets.ctx);
        try {
            await maybePlaceSupportTorch(targets.ctx, targets.agent);
        } catch {
            // 松明配置の失敗で追従を止めない。
        }
    }
}
