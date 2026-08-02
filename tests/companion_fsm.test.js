/**
 * Unit tests for companion NestedStateMachine transition helpers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    dutyPending,
    preferGearRecovery,
    resumeUpperMode,
    shouldEnterCombat,
    shouldEnterDuty,
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
