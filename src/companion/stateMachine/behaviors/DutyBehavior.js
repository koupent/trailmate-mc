import { AsyncTickBehavior } from './AsyncTickBehavior.js';

/**
 * Runs the first matching interrupt (NearbyLoot / Grave / DeathReturn / Recovery).
 */
export class DutyBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     */
    constructor(targets) {
        super('duty');
        this.targets = targets;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'duty';
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        const ctx = targets.ctx;

        // Light survival while recovering without full combat ownership.
        const recoveryActive = Boolean(ctx.deathRecovery?.active);
        if (recoveryActive && targets.agent.reflexes?.tick) {
            await targets.agent.reflexes.tick({
                movementHeld: !!ctx.movement?.isHeld,
                isIdleish: false,
                nonCombatHeld: true,
                preferGearRecovery: false,
                recoveryDeferCombat: false,
                recovery: ctx.deathRecovery,
                owner: ctx.ownerEntity ?? null,
                movement: ctx.movement
            });
        }

        for (const interrupt of targets.interrupts) {
            if (!(await interrupt.shouldRun(ctx))) continue;
            await interrupt.run(ctx);
            return;
        }
    }
}
