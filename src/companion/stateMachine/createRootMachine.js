/**
 * Build the root NestedStateMachine for companion orchestration.
 */

import { NestedStateMachine, StateTransition } from './machineApi.js';
import { FollowBehavior } from './behaviors/FollowBehavior.js';
import { WaitBehavior } from './behaviors/WaitBehavior.js';
import { CombatBehavior } from './behaviors/CombatBehavior.js';
import { DutyBehavior } from './behaviors/DutyBehavior.js';
import {
    dutyPending,
    resumeUpperMode,
    shouldEnterCombat,
    shouldEnterDuty,
    shouldStayInCombat
} from './transitions.js';

/**
 * @param {object} targets
 */
export function createRootMachine(targets) {
    const follow = new FollowBehavior(targets);
    const wait = new WaitBehavior(targets);
    const combat = new CombatBehavior(targets);
    const duty = new DutyBehavior(targets);

    const transitions = [
        // Preferred mode switches (dialogue)
        new StateTransition({
            parent: follow,
            child: wait,
            name: 'follow_to_wait',
            shouldTransition: () => targets.preferredMode === 'wait' && !shouldEnterCombat(targets)
        }),
        new StateTransition({
            parent: wait,
            child: follow,
            name: 'wait_to_follow',
            shouldTransition: () => targets.preferredMode === 'follow' && !shouldEnterCombat(targets)
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

        // Leave combat
        new StateTransition({
            parent: combat,
            child: follow,
            name: 'combat_to_follow',
            shouldTransition: () => !shouldStayInCombat(targets) && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: combat,
            child: wait,
            name: 'combat_to_wait',
            shouldTransition: () => !shouldStayInCombat(targets) && resumeUpperMode(targets) === 'wait'
        }),
        new StateTransition({
            parent: combat,
            child: duty,
            name: 'combat_to_duty',
            shouldTransition: () => !shouldStayInCombat(targets) && shouldEnterDuty(targets)
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
            shouldTransition: () => !dutyPending(targets) && !shouldEnterCombat(targets)
                && resumeUpperMode(targets) === 'follow'
        }),
        new StateTransition({
            parent: duty,
            child: wait,
            name: 'duty_to_wait',
            shouldTransition: () => !dutyPending(targets) && !shouldEnterCombat(targets)
                && resumeUpperMode(targets) === 'wait'
        })
    ];

    const root = new NestedStateMachine(transitions, follow);
    root.stateName = 'companionRoot';
    return {
        root,
        states: { follow, wait, combat, duty }
    };
}
