import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { getActiveOwnerThreat } from '../../ownerThreatTracker.js';
import { preferGearRecovery } from '../transitions.js';
import { shouldDeferRecoveryForCombat } from '../../combatGate.js';

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
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'combat';
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
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
    }
}
