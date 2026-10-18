import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { getActiveOwnerThreat } from '../../ownerThreatTracker.js';
import { preferGearRecovery } from '../transitions.js';
import { shouldDeferRecoveryForCombat } from '../../combatGate.js';
import { action, runTree } from '../../behaviorTree/bt.js';

/**
 * Runs Reflexes combat as the active FSM state (single-loop ownership).
 */
export class CombatBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     */
    constructor(targets) {
        super('combat');
        this.targets = targets;
        // The combat decisions live in src/reflexes/Reflexes.ts (this
        // project's own code; mineflayer-pvp only swings and chases).
        this.tree = action('戦闘の判断と行動（Reflexes.ts）', () => this._tickReflexes());
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'combat';
    }

    async runTick() {
        if (this.targets.paused) return;
        await runTree(this.tree, this.targets.ctx);
    }

    async _tickReflexes() {
        const { targets } = this;
        const ctx = targets.ctx;
        const agent = targets.agent;
        const recoveryActive = Boolean(ctx.deathRecovery?.active);
        const gear = preferGearRecovery(targets);
        await agent.reflexes?.tick?.({
            movementHeld: !!ctx.movement?.isHeld,
            isIdleish: false,
            nonCombatHeld: !!ctx.holdReflexes || gear,
            preferGearRecovery: gear,
            recoveryDeferCombat: recoveryActive && shouldDeferRecoveryForCombat(ctx),
            recovery: ctx.deathRecovery,
            owner: ctx.ownerEntity ?? null,
            ownerThreat: getActiveOwnerThreat(ctx),
            movement: ctx.movement
        });
        return true;
    }
}
