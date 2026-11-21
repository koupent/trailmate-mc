import { runTree } from '../../behaviorTree/bt.js';

/** Execute the state's registered tree, including from synchronous StateBehavior.update(). */
export class AsyncTickBehavior {
    constructor(stateName, targets) {
        this.stateName = stateName;
        this.targets = targets;
        this.active = false;
        this._busy = false;
    }

    onStateEntered() {
        this.active = true;
        this.targets.activeId = this.stateName;
    }

    onStateExited() {
        this.active = false;
    }

    update() {
        if (!this.active || this._busy) return;
        this._busy = true;
        Promise.resolve()
            .then(() => this.runTick())
            .catch((err) => {
                console.error(`[companion/fsm] ${this.stateName} error:`, err);
            })
            .finally(() => {
                this._busy = false;
            });
    }

    async runTick() {
        if (this.targets.paused) return;
        this.prepareTick?.();
        const tree = this.tree;
        await runTree(tree, this.targets.ctx);
        return tree;
    }
}
