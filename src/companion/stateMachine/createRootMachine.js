/**
 * Build the root NestedStateMachine for companion orchestration.
 *
 * States are the bot's jobs (macro). What a job does tick by tick lives in
 * the behavior tree of its state (micro). The player-selected mode
 * (follow / wait) sits above the machine: it picks the tree the normal state
 * runs and whether planting is allowed, but it is not a state.
 *
 * Safety states (hazard escape, boat passenger, item hand-over) can take over
 * from any state; the orchestrator checks them before these transitions.
 */

import { NestedStateMachine, StateTransition } from './machineApi.js';
import { action, condition, sequence } from '../behaviorTree/bt.js';
import { NormalBehavior } from './behaviors/NormalBehavior.js';
import { CombatBehavior } from './behaviors/CombatBehavior.js';
import { PassageTransitBehavior } from './behaviors/PassageTransitBehavior.js';
import { DutyBehavior } from './behaviors/DutyBehavior.js';
import { PlantingBehavior } from './behaviors/PlantingBehavior.js';
import { SafetyBehavior } from './behaviors/SafetyBehavior.js';
import {
    DUTY_STATES,
    dutyPending,
    passagePending,
    pendingDutyState,
    safetyDutyPending,
    shouldEnterCombat,
    shouldEnterDuty,
    shouldEnterPassageTransit,
    shouldStayInCombat
} from './transitions.js';

/**
 * @param {object} targets
 */
export function createRootMachine(targets) {
    const normal = new NormalBehavior(targets);
    const planting = new PlantingBehavior(targets);
    const combat = new CombatBehavior(targets);
    const passageTransit = new PassageTransitBehavior(targets);
    const duties = DUTY_STATES.map((spec) => new DutyBehavior(targets, {
        id: spec.id,
        label: spec.label,
        interrupts: (targets.interrupts || []).filter((interrupt) => spec.interrupts.includes(interrupt.name))
    }));
    const safety = createSafetyStates(targets);

    const dutyTarget = (duty) => () => pendingDutyState(targets) === duty.stateName;
    const plantingWanted = () => targets.preferredMode === 'follow' && Boolean(targets.planter?.work);

    const transitions = [
        // Combat entry
        ...[normal, planting, ...duties, passageTransit].map((state) => new StateTransition({
            parent: state,
            child: combat,
            name: `${state.stateName}_to_combat`,
            shouldTransition: () => shouldEnterCombat(targets)
        })),

        // A passage transaction outranks normal movement and interrupt work.
        ...[normal, planting, ...duties].map((state) => new StateTransition({
            parent: state,
            child: passageTransit,
            name: `${state.stateName}_to_passage_transit`,
            shouldTransition: () => shouldEnterPassageTransit(targets)
        })),

        // Leave combat: safety work first, then a pending passage, then other work.
        ...duties.map((duty) => new StateTransition({
            parent: combat,
            child: duty,
            name: `combat_to_${duty.stateName}_safety`,
            shouldTransition: () => !shouldStayInCombat(targets)
                && safetyDutyPending(targets)
                && dutyTarget(duty)()
        })),
        new StateTransition({
            parent: combat,
            child: passageTransit,
            name: 'combat_to_passage_transit',
            shouldTransition: () => !shouldStayInCombat(targets)
                && shouldEnterPassageTransit(targets)
        }),
        ...duties.map((duty) => new StateTransition({
            parent: combat,
            child: duty,
            name: `combat_to_${duty.stateName}`,
            shouldTransition: () => !shouldStayInCombat(targets)
                && shouldEnterDuty(targets)
                && dutyTarget(duty)()
        })),
        new StateTransition({
            parent: combat,
            child: normal,
            name: 'combat_to_normal',
            shouldTransition: () => !shouldStayInCombat(targets)
                && !dutyPending(targets)
                && !passagePending(targets)
        }),

        // Safety work may interrupt a transaction; otherwise leave only after
        // the final block state is confirmed, or the transaction failed.
        ...duties.map((duty) => new StateTransition({
            parent: passageTransit,
            child: duty,
            name: `passage_transit_to_${duty.stateName}`,
            shouldTransition: () => !shouldEnterCombat(targets)
                && dutyPending(targets)
                && (!passagePending(targets) || safetyDutyPending(targets))
                && dutyTarget(duty)()
        })),
        new StateTransition({
            parent: passageTransit,
            child: normal,
            name: 'passage_transit_to_normal',
            shouldTransition: () => !passagePending(targets)
                && !dutyPending(targets)
        }),

        // Interrupt work: entry, hand-over to an earlier-listed kind, exit.
        ...[normal, planting].flatMap((state) => duties.map((duty) => new StateTransition({
            parent: state,
            child: duty,
            name: `${state.stateName}_to_${duty.stateName}`,
            shouldTransition: () => shouldEnterDuty(targets) && dutyTarget(duty)()
        }))),
        ...duties.flatMap((from) => duties
            .filter((to) => to !== from)
            .map((to) => new StateTransition({
                parent: from,
                child: to,
                name: `${from.stateName}_to_${to.stateName}`,
                shouldTransition: () => !shouldEnterCombat(targets) && dutyTarget(to)()
            }))),
        ...duties.map((duty) => new StateTransition({
            parent: duty,
            child: normal,
            name: `${duty.stateName}_to_normal`,
            shouldTransition: () => !dutyPending(targets)
                && !passagePending(targets)
                && !shouldEnterCombat(targets)
        })),

        // Planting (follow mode only) is the lowest-priority job.
        new StateTransition({
            parent: normal,
            child: planting,
            name: 'normal_to_planting',
            shouldTransition: plantingWanted
        }),
        new StateTransition({
            parent: planting,
            child: normal,
            name: 'planting_to_normal',
            shouldTransition: () => !plantingWanted()
        })
    ];

    const root = new NestedStateMachine(transitions, normal);
    root.stateName = 'companionRoot';
    const states = { normal, planting, combat, passageTransit };
    for (const duty of duties) states[duty.stateName] = duty;
    return { root, states, safetyStates: safety };
}

/**
 * Highest priority first. Each tree succeeds only while its state owns the
 * bot; the first that succeeds takes the tick.
 * @param {object} targets
 */
function createSafetyStates(targets) {
    return [
        new SafetyBehavior(targets, 'hazard_escape', action(
            '危険なブロック・炎・水から抜け出す',
            (ctx) => Boolean(ctx.hazardEscape?.tick?.())
        )),
        // A second-seat passenger must not issue pathfinder, combat, or
        // vehicle inputs. Invalid seat ownership requests a clean dismount.
        new SafetyBehavior(targets, 'boat_passenger', action(
            'ボートの同乗を保つ（操作しない）',
            (ctx) => Boolean(ctx.boatPassenger?.maintain?.(ctx.ownerEntity))
        )),
        new SafetyBehavior(targets, 'item_transfer', sequence('アイテムの受け渡し', [
            condition('受け渡し・預け入れの処理中', () => Boolean(targets.paused)),
            action('動かずに処理を待つ', () => true)
        ]))
    ];
}
