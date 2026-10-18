import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import { getActiveOwnerThreat } from '../../ownerThreatTracker.js';
import { preferGearRecovery } from '../transitions.js';
import { shouldDeferRecoveryForCombat } from '../../combatGate.js';
import { action, runTree, subtree } from '../../behaviorTree/bt.js';

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
        // 戦闘の判断は箱庭と共通の CombatStep、実行は Reflexes。Reflexes の
        // ツリーがあればその中身（判断→行動の選択）をそのまま見せる。
        const combatTree = targets.agent?.reflexes?.combatTree;
        this.tree = combatTree
            ? subtree('戦闘', combatTree, () => this._tickReflexes())
            : action('戦闘', () => this._tickReflexes());
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
