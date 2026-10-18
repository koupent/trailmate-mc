import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { runTree, SUCCESS } from '../../behaviorTree/bt.js';

/**
 * A safety state: hazard escape, riding as a boat passenger, or an item
 * hand-over. It can take over from any state, so the orchestrator checks it
 * before the ordinary transitions: `claim()` runs the tree, and success means
 * this state owns the tick.
 */
export class SafetyBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     * @param {string} id
     * @param {object} tree Root node built with behaviorTree/bt.js
     */
    constructor(targets, id, tree) {
        super(id);
        this.targets = targets;
        this.tree = tree;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = this.stateName;
    }

    /** @returns {Promise<boolean>} true while this state owns the bot */
    async claim() {
        return await runTree(this.tree, this.targets.ctx) === SUCCESS;
    }
}
