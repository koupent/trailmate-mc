/**
 * Unit tests for companion NestedStateMachine transition helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    dutyPending,
    passagePending,
    preferGearRecovery,
    resumeUpperMode,
    safetyDutyPending,
    shouldEnterCombat,
    shouldEnterDuty,
    shouldEnterPassageTransit,
    shouldStayInCombat
} from '../src/companion/stateMachine/transitions.js';

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
    it('resumeUpperMode respects preferredMode', () => {
        assert.equal(resumeUpperMode({ preferredMode: 'wait' }), 'wait');
        assert.equal(resumeUpperMode({ preferredMode: 'follow' }), 'follow');
    });

    it('shouldEnterCombat when wantsCombat', () => {
        const targets = makeTargets();
        targets.ctx.agent.reflexes.wantsCombat = true;
        assert.equal(shouldEnterCombat(targets), true);
        assert.equal(shouldStayInCombat(targets), true);
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
        base.doors = { claimPassage() {}, resumePassage() {}, suspendPassage() {} };
        const mode = { onEnter() {}, onExit() {}, tick() {} };
        const targets = createCompanionTargets({
            ctx: base,
            agent: base.agent,
            followMode: mode,
            waitMode: mode,
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

    it('NestedStateMachine switches follow to wait on preferredMode', async () => {
        const { createRootMachine } = await import('../src/companion/stateMachine/createRootMachine.js');
        const { createCompanionTargets } = await import('../src/companion/stateMachine/targets.js');
        const followMode = {
            id: 'follow',
            onEnter: async () => {},
            onExit: async () => {},
            tick: async () => {}
        };
        const waitMode = {
            id: 'wait',
            onEnter: async () => {},
            onExit: async () => {},
            tick: async () => {}
        };
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
        assert.equal(root.activeState, states.follow);
        targets.preferredMode = 'wait';
        root.update();
        assert.equal(root.activeState, states.wait);
        assert.equal(targets.activeId, 'wait');
    });
});
