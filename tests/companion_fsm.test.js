/**
 * Unit tests for companion NestedStateMachine transition helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import {
    dutyPending,
    passagePending,
    preferGearRecovery,
    safetyDutyPending,
    shouldEnterCombat,
    shouldEnterDuty,
    shouldEnterPassageTransit,
    shouldStayInCombat
} from '../src/companion/stateMachine/transitions.js';
import { action, runTree } from '../src/companion/behaviorTree/bt.js';

function makeTargets(overrides = {}) {
    return {
        preferredMode: 'follow',
        _dutyPending: false,
        interrupts: [],
        ctx: {
            bot: {
                entity: { position: { x: 0, y: 64, z: 0 } },
                entities: {},
                username: 'bot',
                inventory: { items: () => [{ name: 'iron_sword' }] },
                heldItem: { name: 'iron_sword' },
                pvp: { target: null }
            },
            ownerEntity: null,
            deathRecovery: { active: false },
            config: { reflexes: { hostile_range: 16 }, own_grave: { scan_radius: 10 } },
            agent: {
                reflexes: {
                    isControllingMovement: false,
                    wantsCombat: false
                }
            },
            ...overrides.ctx
        },
        ...overrides
    };
}

describe('companion fsm transitions', () => {
    it('shouldEnterCombat when wantsCombat', () => {
        const targets = makeTargets();
        targets.ctx.agent.reflexes.wantsCombat = true;
        assert.equal(shouldEnterCombat(targets), true);
        assert.equal(shouldStayInCombat(targets), true);
    });

    it('does not enter combat for a hostile behind a wall', () => {
        const targets = makeTargets();
        const bot = targets.ctx.bot;
        bot.entity.position = new Vec3(0, 64, 0);
        bot.entities = { 12: { id: 12, type: 'hostile', name: 'zombie', position: new Vec3(3, 64, 0) } };

        bot.world = { raycast: () => ({ name: 'stone' }) };
        assert.equal(shouldEnterCombat(targets), false);

        bot.world = { raycast: () => null };
        assert.equal(shouldEnterCombat(targets), true);
    });

    it('shouldEnterDuty when duty pending and no combat', () => {
        const targets = makeTargets({ _dutyPending: true });
        assert.equal(dutyPending(targets), true);
        assert.equal(shouldEnterDuty(targets), true);
        targets.ctx.agent.reflexes.wantsCombat = true;
        assert.equal(shouldEnterDuty(targets), false);
    });

    it('prioritizes combat and safety duty above a passage transaction', () => {
        const recovery = { name: 'recovery', _lastShouldRun: false };
        const targets = makeTargets({
            _passagePending: true,
            interrupts: [recovery]
        });

        assert.equal(passagePending(targets), true);
        assert.equal(shouldEnterPassageTransit(targets), true);

        targets.ctx.agent.reflexes.wantsCombat = true;
        assert.equal(shouldEnterPassageTransit(targets), false);

        targets.ctx.agent.reflexes.wantsCombat = false;
        recovery._lastShouldRun = true;
        assert.equal(safetyDutyPending(targets), true);
        assert.equal(shouldEnterPassageTransit(targets), false);
    });

    it('returns from combat to a pending passage transaction before normal work', async () => {
        const { createRootMachine } = await import('../src/companion/stateMachine/createRootMachine.js');
        const { createCompanionTargets } = await import('../src/companion/stateMachine/targets.js');
        const base = makeTargets().ctx;
        base.movement = { stop() {} };
        base.doors = { resumePassage() {}, suspendPassage() {} };
        const targets = createCompanionTargets({
            ctx: base,
            agent: base.agent,
            followMode: fakeMode(),
            waitMode: fakeMode(),
            interrupts: []
        });
        const { root, states } = createRootMachine(targets);
        root.active = true;
        root.onStateEntered();

        targets._passagePending = true;
        root.update();
        assert.equal(root.activeState, states.passageTransit);

        targets.ctx.agent.reflexes.wantsCombat = true;
        root.update();
        assert.equal(root.activeState, states.combat);

        targets.ctx.agent.reflexes.wantsCombat = false;
        root.update();
        assert.equal(root.activeState, states.passageTransit);
    });

    it('preferGearRecovery when unarmed near own grave helper path', () => {
        const targets = makeTargets();
        targets.ctx.bot.inventory.items = () => [];
        targets.ctx.bot.heldItem = null;
        // No graves module entities — preferGearRecovery returns false without graves
        assert.equal(preferGearRecovery(targets), false);
    });

    it('a mode switch changes the normal branch, not the state', async () => {
        const { createRootMachine } = await import('../src/companion/stateMachine/createRootMachine.js');
        const { createCompanionTargets } = await import('../src/companion/stateMachine/targets.js');
        const calls = [];
        const followMode = fakeMode('follow', calls);
        const waitMode = fakeMode('wait', calls);
        const targets = createCompanionTargets({
            ctx: makeTargets().ctx,
            agent: makeTargets().ctx.agent,
            followMode,
            waitMode,
            interrupts: []
        });
        const { root, states } = createRootMachine(targets);
        root.active = true;
        root.onStateEntered();
        assert.equal(root.activeState, states.normal);
        assert.equal(targets.activeId, 'normal');

        await states.normal.runTick();
        targets.preferredMode = 'wait';
        root.update();
        assert.equal(root.activeState, states.normal, 'switching modes is not a transition');
        // update() runs the active behavior without awaiting it.
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepEqual(calls, [
            'follow:enter',
            'follow:tick',
            'follow:exit',
            'wait:enter',
            'wait:tick'
        ]);
        const branches = Object.fromEntries(
            states.normal.tree.children.map((branch) => [branch.mode, branch.status])
        );
        assert.deepEqual(branches, { follow: 'failure', wait: 'success' });
    });

    it('a switch made during combat takes effect on return to normal', async () => {
        const { createRootMachine } = await import('../src/companion/stateMachine/createRootMachine.js');
        const { createCompanionTargets } = await import('../src/companion/stateMachine/targets.js');
        const calls = [];
        const base = makeTargets().ctx;
        const targets = createCompanionTargets({
            ctx: base,
            agent: base.agent,
            followMode: fakeMode('follow', calls),
            waitMode: fakeMode('wait', calls),
            interrupts: []
        });
        const { root, states } = createRootMachine(targets);
        root.active = true;
        root.onStateEntered();

        base.agent.reflexes.wantsCombat = true;
        root.update();
        assert.equal(root.activeState, states.combat);
        targets.preferredMode = 'wait';

        base.agent.reflexes.wantsCombat = false;
        root.update();
        assert.equal(root.activeState, states.normal);
        assert.deepEqual(calls, ['follow:enter', 'follow:exit', 'wait:enter']);
    });
});

/** A mode with a one-action tree that records what the machine asked of it. */
function fakeMode(id = 'mode', calls = []) {
    const tree = action(id, () => true);
    return {
        id,
        tree,
        onEnter: () => { calls.push(`${id}:enter`); },
        onExit: () => { calls.push(`${id}:exit`); },
        tick: async (ctx) => {
            calls.push(`${id}:tick`);
            return runTree(tree, ctx);
        }
    };
}
