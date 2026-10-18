import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import {
    action,
    condition,
    runTree,
    selector,
    sequence
} from '../../behaviorTree/bt.js';
import { refreshDutyPending } from '../transitions.js';

/** Dashboard names for the interrupts; unknown ones show their raw name. */
const INTERRUPT_LABELS = {
    nearby_loot: '落ちているアイテムを拾いに行く',
    own_grave: '墓から装備を回収',
    death_return: '死亡地点へ戻る',
    recovery: '穴や詰まりから抜け出す'
};

/**
 * One kind of interrupt work (item pickup, death recovery, getting unstuck).
 * Runs the first of its interrupts that still needs to run.
 */
export class DutyBehavior extends AsyncTickBehavior {
    /**
     * @param {object} targets
     * @param {{ id: string, label: string, interrupts: Array<{ name: string, shouldRun: Function, run: Function }> }} spec
     */
    constructor(targets, spec) {
        super(spec.id);
        this.targets = targets;
        this.interrupts = spec.interrupts;

        this.tree = sequence(spec.label, [
            selector('死亡復帰中の自衛', [
                sequence('復帰中なら最低限の自衛', [
                    condition('死亡からの復帰中', (ctx) => Boolean(ctx.deathRecovery?.active)),
                    action('戦闘処理で身を守る', (ctx) => this._selfDefense(ctx))
                ]),
                condition('自衛は不要', () => true)
            ]),
            selector('優先順に1つ実行', [
                ...spec.interrupts.map((interrupt) => sequence(
                    INTERRUPT_LABELS[interrupt.name] || interrupt.name,
                    [
                        // refreshDutyFlags の結果を優先し、実行直前に再判定して陳腐化を防ぐ。
                        condition('必要か', async (ctx) => {
                            if (interrupt._lastShouldRun !== true) return false;
                            if (await interrupt.shouldRun(ctx)) return true;
                            interrupt._lastShouldRun = false;
                            return false;
                        }),
                        action('実行する', async (ctx) => {
                            await interrupt.run(ctx);
                            return true;
                        })
                    ]
                )),
                // shouldRun が実行前に false になった場合、同 tick で抜けられるようにする。
                action('やることがなければ終える', () => {
                    refreshDutyPending(targets);
                    return true;
                })
            ])
        ]);
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = this.stateName;
    }

    async runTick() {
        if (this.targets.paused) return;
        await runTree(this.tree, this.targets.ctx);
    }

    /** Light survival while recovering without full combat ownership. */
    async _selfDefense(ctx) {
        const reflexes = this.targets.agent.reflexes;
        if (!reflexes?.tick) return false;
        await reflexes.tick({
            movementHeld: !!ctx.movement?.isHeld,
            isIdleish: false,
            nonCombatHeld: true,
            preferGearRecovery: false,
            recoveryDeferCombat: false,
            recovery: ctx.deathRecovery,
            owner: ctx.ownerEntity ?? null,
            movement: ctx.movement
        });
        return true;
    }
}
