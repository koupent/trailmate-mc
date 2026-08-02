import { AsyncTickBehavior } from './AsyncTickBehavior.js';

/**
 * Wait in place — wraps WaitMode.
 */
export class WaitBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     */
    constructor(targets) {
        super('wait');
        this.targets = targets;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'wait';
        this.targets.resumeMode = 'wait';
        void this.targets.waitMode.onEnter?.(this.targets.ctx);
    }

    onStateExited() {
        void this.targets.waitMode.onExit?.(this.targets.ctx);
        super.onStateExited();
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        await targets.waitMode.tick(targets.ctx);
    }
}
