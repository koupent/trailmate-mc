/**
 * Shared blackboard for companion NestedStateMachine transitions and behaviors.
 */

/**
 * @typedef {'normal'|'planting'|'combat'|'passage_transit'|'loot'|'death_recovery'|'stuck_recovery'|'hazard_escape'|'boat_passenger'|'item_transfer'} CompanionFsmStateId
 */

/**
 * @param {object} opts
 * @param {import('../CompanionContext.js').CompanionContext} opts.ctx
 * @param {import('../../host/BotHost.ts').TrailmateHost} opts.agent
 * @param {import('../modes/FollowMode.js').FollowMode} opts.followMode
 * @param {import('../modes/WaitMode.js').WaitMode} opts.waitMode
 * @param {Array<{ name: string, shouldRun: Function, run: Function }>} opts.interrupts
 * @param {import('../planting/CropPlanter.js').CropPlanter} [opts.planter]
 */
export function createCompanionTargets(opts) {
    return {
        ctx: opts.ctx,
        agent: opts.agent,
        followMode: opts.followMode,
        waitMode: opts.waitMode,
        interrupts: opts.interrupts || [],
        /** @type {import('../planting/CropPlanter.js').CropPlanter} */
        planter: opts.planter,
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
