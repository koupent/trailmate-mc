import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { createPlantingTree } from '../../planting/CropPlanter.js';

/**
 * Follow mode only: walk to empty farmland near the owner and plant seeds.
 * `targets.planter.work` is refreshed once per tick by the orchestrator.
 */
export class PlantingBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('planting', targets);
        this.tree = createPlantingTree(targets.planter);
    }

    onStateExited() {
        this.targets.planter.release();
        super.onStateExited();
    }

    prepareTick() {
        this.targets.followMode.trackOwner?.(this.targets.ctx);
    }
}
