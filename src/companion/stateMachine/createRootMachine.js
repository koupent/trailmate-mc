/**
 * Build the root NestedStateMachine for companion orchestration.
 */

import { NestedStateMachine, StateTransition } from './machineApi.js';
import { NormalBehavior } from './behaviors/NormalBehavior.js';
import { CombatBehavior } from './behaviors/CombatBehavior.js';
import { PassageTransitBehavior } from './behaviors/PassageTransitBehavior.js';
import { DutyBehavior } from './behaviors/DutyBehavior.js';
import {
    dutyPending,
    passagePending,
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
    const combat = new CombatBehavior(targets);
    const passageTransit = new PassageTransitBehavior(targets);
    const duty = new DutyBehavior(targets);

    // The player-selected mode (follow / wait) is not a state: it is read by
    // the normal state's behavior tree. Every state returns to `normal`.
    const transitions = [
        // Combat entry
        new StateTransition({
            parent: normal,
            child: combat,
            name: 'normal_to_combat',
            shouldTransition: () => shouldEnterCombat(targets)
        }),
        new StateTransition({
            parent: duty,
            child: combat,
            name: 'duty_to_combat',
            shouldTransition: () => shouldEnterCombat(targets)
        }),
        new StateTransition({
            parent: passageTransit,
            child: combat,
            name: 'passage_transit_to_combat',
            shouldTransition: () => shouldEnterCombat(targets)
        }),

        // A passage transaction outranks normal movement and duty work.
        new StateTransition({
            parent: normal,
            child: passageTransit,
            name: 'normal_to_passage_transit',
            shouldTransition: () => shouldEnterPassageTransit(targets)
        }),
        new StateTransition({
            parent: duty,
            child: passageTransit,
            name: 'duty_to_passage_transit',
            shouldTransition: () => shouldEnterPassageTransit(targets)
        }),

        // Leave combat
        new StateTransition({
            parent: combat,
            child: duty,
            name: 'combat_to_safety_duty',
            shouldTransition: () => !shouldStayInCombat(targets) && safetyDutyPending(targets)
        }),
        new StateTransition({
            parent: combat,
            child: passageTransit,
            name: 'combat_to_passage_transit',
            shouldTransition: () => !shouldStayInCombat(targets)
                && shouldEnterPassageTransit(targets)
        }),
        new StateTransition({
            parent: combat,
            child: duty,
            name: 'combat_to_duty',
            shouldTransition: () => !shouldStayInCombat(targets) && shouldEnterDuty(targets)
        }),
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
        new StateTransition({
            parent: passageTransit,
            child: duty,
            name: 'passage_transit_to_duty',
            shouldTransition: () => !shouldEnterCombat(targets)
                && dutyPending(targets)
                && (!passagePending(targets) || safetyDutyPending(targets))
        }),
        new StateTransition({
            parent: passageTransit,
            child: normal,
            name: 'passage_transit_to_normal',
            shouldTransition: () => !passagePending(targets)
                && !dutyPending(targets)
        }),

        // Duty (interrupts) entry / exit
        new StateTransition({
            parent: normal,
            child: duty,
            name: 'normal_to_duty',
            shouldTransition: () => shouldEnterDuty(targets)
        }),
        new StateTransition({
            parent: duty,
            child: normal,
            name: 'duty_to_normal',
            shouldTransition: () => !dutyPending(targets)
                && !passagePending(targets)
                && !shouldEnterCombat(targets)
        })
    ];

    const root = new NestedStateMachine(transitions, normal);
    root.stateName = 'companionRoot';
    return {
        root,
        states: { normal, combat, passageTransit, duty }
    };
}
