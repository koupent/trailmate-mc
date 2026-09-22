/**
 * Build the root NestedStateMachine for companion orchestration.
 */

import { NestedStateMachine, StateTransition } from './machineApi.js';
import { FollowBehavior } from './behaviors/FollowBehavior.js';
import { WaitBehavior } from './behaviors/WaitBehavior.js';
import { CombatBehavior } from './behaviors/CombatBehavior.js';
import { PassageTransitBehavior } from './behaviors/PassageTransitBehavior.js';
import { DutyBehavior } from './behaviors/DutyBehavior.js';
import {
    dutyPending,
    passagePending,
    resumeUpperMode,
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
    const follow = new FollowBehavior(targets);
    const wait = new WaitBehavior(targets);
    const combat = new CombatBehavior(targets);
    const passageTransit = new PassageTransitBehavior(targets);
    const duty = new DutyBehavior(targets);

    const transitions = [
        // Preferred mode switches (dialogue)
        new StateTransition({
            parent: follow,
            child: wait,
            name: 'follow_to_wait',
            shouldTransition: () => targets.preferredMode === 'wait'
                && !shouldEnterCombat(targets)
                && !shouldEnterPassageTransit(targets)
        }),
        new StateTransition({
            parent: wait,
            child: follow,
            name: 'wait_to_follow',
            shouldTransition: () => targets.preferredMode === 'follow'
                && !shouldEnterCombat(targets)
                && !shouldEnterPassageTransit(targets)
        }),

        // Combat entry from upper modes / duty
        new StateTransition({
            parent: follow,
            child: combat,
            name: 'follow_to_combat',
            shouldTransition: () => shouldEnterCombat(targets)
        }),
        new StateTransition({
            parent: wait,
            child: combat,
            name: 'wait_to_combat',
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
            parent: follow,
            child: passageTransit,
            name: 'follow_to_passage_transit',
            shouldTransition: () => shouldEnterPassageTransit(targets)
        }),
        new StateTransition({
            parent: wait,
            child: passageTransit,
            name: 'wait_to_passage_transit',
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
            child: follow,
            name: 'combat_to_follow',
            shouldTransition: () => !shouldStayInCombat(targets)
                && !dutyPending(targets)
                && !passagePending(targets)
                && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: combat,
            child: wait,
            name: 'combat_to_wait',
            shouldTransition: () => !shouldStayInCombat(targets)
                && !dutyPending(targets)
                && !passagePending(targets)
                && resumeUpperMode(targets) === 'wait'
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
            child: follow,
            name: 'passage_transit_to_follow',
            shouldTransition: () => !passagePending(targets)
                && !dutyPending(targets)
                && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: passageTransit,
            child: wait,
            name: 'passage_transit_to_wait',
            shouldTransition: () => !passagePending(targets)
                && !dutyPending(targets)
                && resumeUpperMode(targets) === 'wait'
        }),

        // Duty (interrupts) entry / exit
        new StateTransition({
            parent: follow,
            child: duty,
            name: 'follow_to_duty',
            shouldTransition: () => shouldEnterDuty(targets)
        }),
        new StateTransition({
            parent: wait,
            child: duty,
            name: 'wait_to_duty',
            shouldTransition: () => shouldEnterDuty(targets)
        }),
        new StateTransition({
            parent: duty,
            child: follow,
            name: 'duty_to_follow',
            shouldTransition: () => !dutyPending(targets)
                && !passagePending(targets)
                && !shouldEnterCombat(targets)
                && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: duty,
            child: wait,
            name: 'duty_to_wait',
            shouldTransition: () => !dutyPending(targets)
                && !passagePending(targets)
                && !shouldEnterCombat(targets)
                && resumeUpperMode(targets) === 'wait'
        })
    ];

    const root = new NestedStateMachine(transitions, follow);
    root.stateName = 'companionRoot';
    return {
        root,
        states: { follow, wait, combat, passageTransit, duty }
    };
}
