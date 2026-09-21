/**
 * Build the root NestedStateMachine for companion orchestration.
 */

import { NestedStateMachine, StateTransition } from './machineApi.js';
import { FollowBehavior } from './behaviors/FollowBehavior.js';
import { WaitBehavior } from './behaviors/WaitBehavior.js';
import { CombatBehavior } from './behaviors/CombatBehavior.js';
import { PassageCleanupBehavior } from './behaviors/PassageCleanupBehavior.js';
import { DutyBehavior } from './behaviors/DutyBehavior.js';
import {
    dutyPending,
    passagePending,
    resumeUpperMode,
    safetyDutyPending,
    shouldEnterCombat,
    shouldEnterDuty,
    shouldEnterPassageCleanup,
    shouldStayInCombat
} from './transitions.js';

/**
 * @param {object} targets
 */
export function createRootMachine(targets) {
    const follow = new FollowBehavior(targets);
    const wait = new WaitBehavior(targets);
    const combat = new CombatBehavior(targets);
    const passageCleanup = new PassageCleanupBehavior(targets);
    const duty = new DutyBehavior(targets);

    const transitions = [
        // Preferred mode switches (dialogue)
        new StateTransition({
            parent: follow,
            child: wait,
            name: 'follow_to_wait',
            shouldTransition: () => targets.preferredMode === 'wait'
                && !shouldEnterCombat(targets)
                && !shouldEnterPassageCleanup(targets)
        }),
        new StateTransition({
            parent: wait,
            child: follow,
            name: 'wait_to_follow',
            shouldTransition: () => targets.preferredMode === 'follow'
                && !shouldEnterCombat(targets)
                && !shouldEnterPassageCleanup(targets)
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
            parent: passageCleanup,
            child: combat,
            name: 'passage_cleanup_to_combat',
            shouldTransition: () => shouldEnterCombat(targets)
        }),

        // Passage cleanup outranks normal movement and duty work.
        new StateTransition({
            parent: follow,
            child: passageCleanup,
            name: 'follow_to_passage_cleanup',
            shouldTransition: () => shouldEnterPassageCleanup(targets)
        }),
        new StateTransition({
            parent: wait,
            child: passageCleanup,
            name: 'wait_to_passage_cleanup',
            shouldTransition: () => shouldEnterPassageCleanup(targets)
        }),
        new StateTransition({
            parent: duty,
            child: passageCleanup,
            name: 'duty_to_passage_cleanup',
            shouldTransition: () => shouldEnterPassageCleanup(targets)
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
            child: passageCleanup,
            name: 'combat_to_passage_cleanup',
            shouldTransition: () => !shouldStayInCombat(targets)
                && shouldEnterPassageCleanup(targets)
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

        // Safety work may interrupt cleanup; otherwise leave only after confirmation/failure.
        new StateTransition({
            parent: passageCleanup,
            child: duty,
            name: 'passage_cleanup_to_duty',
            shouldTransition: () => !shouldEnterCombat(targets)
                && dutyPending(targets)
                && (!passagePending(targets) || safetyDutyPending(targets))
        }),
        new StateTransition({
            parent: passageCleanup,
            child: follow,
            name: 'passage_cleanup_to_follow',
            shouldTransition: () => !passagePending(targets)
                && !dutyPending(targets)
                && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: passageCleanup,
            child: wait,
            name: 'passage_cleanup_to_wait',
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
        states: { follow, wait, combat, passageCleanup, duty }
    };
}
