/**
 * Shared blackboard for companion NestedStateMachine transitions and behaviors.
 */

/**
 * @typedef {'normal'|'combat'|'passage_transit'|'duty'} CompanionFsmStateId
 */

/**
 * @param {object} opts
 * @param {import('../CompanionContext.js').CompanionContext} opts.ctx
 * @param {import('../../host/BotHost.ts').TrailmateHost} opts.agent
 * @param {import('../modes/FollowMode.js').FollowMode} opts.followMode
 * @param {import('../modes/WaitMode.js').WaitMode} opts.waitMode
 * @param {Array<{ name: string, shouldRun: Function, run: Function }>} opts.interrupts
 */
export function createCompanionTargets(opts) {
    return {
        ctx: opts.ctx,
        agent: opts.agent,
        followMode: opts.followMode,
        waitMode: opts.waitMode,
        interrupts: opts.interrupts || [],
        /** @type {'follow'|'wait'} Player-selected mode, read by the normal state's tree. */
        preferredMode: 'follow',
        /** Item transfer etc. — skip FSM behavior work. */
        paused: false,
        /** @type {CompanionFsmStateId} */
        activeId: 'normal',
        /** A passage transaction must finish before normal work resumes. */
        _passagePending: false
    };
}
