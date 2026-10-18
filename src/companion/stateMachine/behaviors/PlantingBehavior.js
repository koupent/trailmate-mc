import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { runTree } from '../../behaviorTree/bt.js';
import { createPlantingTree } from '../../planting/CropPlanter.js';

/**
 * Follow mode only: walk to empty farmland near the owner and plant seeds.
 * `targets.planter.work` is refreshed once per tick by the orchestrator.
 */
export class PlantingBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('planting');
        this.targets = targets;
        this.tree = createPlantingTree(targets.planter);
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'planting';
    }

    onStateExited() {
        this.targets.planter.release();
        super.onStateExited();
    }

    async runTick() {
        if (this.targets.paused) return;
        this.targets.followMode.trackOwner?.(this.targets.ctx);
        await runTree(this.tree, this.targets.ctx);
    }
}
