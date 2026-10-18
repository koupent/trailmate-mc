import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNodes, renderFsmSvg } from '../dashboard/public/fsmGraph.js';
import { CompanionOrchestrator } from '../src/companion/stateMachine/CompanionOrchestrator.js';
import {
  buildStatus,
  createControlState,
  listChatCommands,
  runChatCommand
} from '../src/runtime/controlServer.ts';

const text = { label: (id) => id, note: () => '' };

describe('dashboard state machine diagram', () => {
  it('draws every reported state and one arrow per state pair', () => {
    const svg = renderFsmSvg(
      {
        active: 'follow',
        preferredMode: 'follow',
        modes: ['follow', 'wait'],
        states: ['follow', 'wait', 'combat'],
        transitions: [
          { name: 'follow_to_wait', from: 'follow', to: 'wait' },
          { name: 'combat_to_wait', from: 'combat', to: 'wait' },
          { name: 'combat_to_safe_wait', from: 'combat', to: 'wait' }
        ]
      },
      text
    );
    assert.equal(svg.match(/class="fsm-node/g).length, 3);
    assert.equal(svg.match(/<path class="fsm-edge/g).length, 2);
    assert.match(svg, /fsm-node is-mode is-active is-preferred/);
    assert.match(svg, /fsm-node is-auto/);
    assert.match(svg, /fsm-edge is-out/);
  });

  it('follows a state that the diagram has never heard of', () => {
    const states = ['follow', 'wait', 'combat', 'duty', 'passage_transit', 'mining'];
    assert.equal(layoutNodes(states).size, 6);
    const svg = renderFsmSvg(
      {
        active: 'mining',
        states,
        transitions: [{ name: 'follow_to_mining', from: 'follow', to: 'mining' }]
      },
      text
    );
    assert.match(svg, />mining</);
  });

  it('marks the transition that just happened', () => {
    const fsm = {
      active: 'combat',
      states: ['follow', 'combat'],
      transitions: [{ name: 'follow_to_combat', from: 'follow', to: 'combat' }],
      history: [{ name: 'follow_to_combat', from: 'follow', to: 'combat', at: 1000 }]
    };
    assert.match(renderFsmSvg(fsm, { ...text, now: 2000 }), /is-recent/);
    assert.doesNotMatch(renderFsmSvg(fsm, { ...text, now: 60000 }), /is-recent/);
  });
});

describe('orchestrator describes its live machine', () => {
  it('lists states, wired transitions and the transition history', () => {
    const ctx = { bot: {}, config: {}, movement: { stop() {} } };
    const orchestrator = new CompanionOrchestrator(ctx, {}, [{ name: 'recovery' }]);
    orchestrator.targets.preferredMode = 'wait';
    orchestrator._applyTransitions();

    const fsm = orchestrator.describeFsm();
    assert.equal(fsm.active, 'wait');
    assert.deepEqual(fsm.modes, ['follow', 'wait']);
    assert.deepEqual(
      [...fsm.states].sort(),
      ['combat', 'duty', 'follow', 'passage_transit', 'wait']
    );
    assert.ok(
      fsm.transitions.some((t) => t.name === 'follow_to_wait' && t.from === 'follow' && t.to === 'wait')
    );
    assert.deepEqual(fsm.duties, [{ name: 'recovery', pending: false }]);
    assert.equal(fsm.history.length, 1);
    assert.equal(fsm.history[0].name, 'follow_to_wait');
  });
});

describe('dashboard chat commands', () => {
  it('lists the official chat words', () => {
    assert.deepEqual(
      listChatCommands().map((command) => [command.id, command.kind, command.word]),
      [
        ['wait', 'mode', '待機'],
        ['follow', 'mode', '追従'],
        ['give_all_items', 'action', '全回収'],
        ['set_spawnpoint', 'action', '拠点']
      ]
    );
  });

  it('sends the chat word on behalf of the locked owner', () => {
    const heard = [];
    const state = createControlState();
    state.host = /** @type {any} */ ({
      companion: {
        ctx: { ownerName: 'PlayerOne' },
        dialogue: {
          isActionBusy: false,
          handlePlayerMessage: async (user, message) => {
            heard.push([user, message]);
            return true;
          }
        }
      }
    });
    assert.deepEqual(runChatCommand(state, 'wait'), { ok: true });
    assert.deepEqual(heard, [['PlayerOne', '待機']]);
    assert.equal(runChatCommand(state, 'explode').ok, false);
  });

  it('refuses while parked or while a hand-over is running', () => {
    assert.equal(runChatCommand(createControlState(), 'wait').ok, false);
    const state = createControlState();
    state.host = /** @type {any} */ ({
      companion: { ctx: {}, dialogue: { isActionBusy: true, handlePlayerMessage: async () => true } }
    });
    assert.equal(runChatCommand(state, 'follow').ok, false);
  });

  it('status carries the machine description', () => {
    const state = createControlState();
    state.host = /** @type {any} */ ({
      bot: { username: 'bot', entity: null, inventory: { items: () => [] } },
      companion: { ctx: {}, manager: { describeFsm: () => ({ active: 'follow' }) } }
    });
    assert.deepEqual(buildStatus(state).fsm, { active: 'follow' });
  });
});
