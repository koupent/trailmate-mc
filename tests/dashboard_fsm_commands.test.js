import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutNodes, renderFsmSvg } from '../dashboard/public/fsmGraph.js';
import { renderBtTree } from '../dashboard/public/btTree.js';
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
        active: 'normal',
        states: ['normal', 'duty', 'combat'],
        transitions: [
          { name: 'normal_to_duty', from: 'normal', to: 'duty' },
          { name: 'combat_to_duty', from: 'combat', to: 'duty' },
          { name: 'combat_to_safety_duty', from: 'combat', to: 'duty' }
        ],
        trees: { normal: { label: 'root', kind: 'action', status: null } }
      },
      { ...text, selected: 'duty' }
    );
    assert.equal(svg.match(/class="fsm-node/g).length, 3);
    assert.equal(svg.match(/<path class="fsm-edge/g).length, 2);
    assert.match(svg, /class="fsm-node is-active" data-state="normal"/);
    assert.match(svg, /class="fsm-node is-selected" data-state="duty"/);
    assert.match(svg, /fsm-edge is-out/);
    assert.equal(svg.match(/class="fsm-bt"/g).length, 1, 'only states with a tree get the BT mark');
  });

  it('puts safety states in a row with the "from any state" marker', () => {
    const svg = renderFsmSvg(
      {
        active: 'hazard_escape',
        states: ['hazard_escape', 'normal', 'combat'],
        safetyStates: ['hazard_escape'],
        transitions: [
          { name: 'any_to_hazard_escape', from: 'any', to: 'hazard_escape' },
          { name: 'hazard_escape_to_normal', from: 'hazard_escape', to: 'normal' },
          { name: 'normal_to_combat', from: 'normal', to: 'combat' }
        ]
      },
      text
    );
    assert.match(svg, /class="fsm-any"/);
    assert.match(svg, /class="fsm-node is-safety is-active" data-state="hazard_escape"/);
    assert.equal(svg.match(/<path class="fsm-edge/g).length, 3);
  });

  it('follows a state that the diagram has never heard of', () => {
    const states = ['normal', 'combat', 'duty', 'passage_transit', 'mining'];
    assert.equal(layoutNodes(states).size, 5);
    const svg = renderFsmSvg(
      {
        active: 'mining',
        states,
        transitions: [{ name: 'normal_to_mining', from: 'normal', to: 'mining' }]
      },
      text
    );
    assert.match(svg, />mining</);
  });

  it('marks the transition that just happened', () => {
    const fsm = {
      active: 'combat',
      states: ['normal', 'combat'],
      transitions: [{ name: 'normal_to_combat', from: 'normal', to: 'combat' }],
      history: [{ kind: 'state', name: 'normal_to_combat', from: 'normal', to: 'combat', at: 1000 }]
    };
    assert.match(renderFsmSvg(fsm, { ...text, now: 2000 }), /is-recent/);
    assert.doesNotMatch(renderFsmSvg(fsm, { ...text, now: 60000 }), /is-recent/);
  });
});

describe('dashboard behavior tree panel', () => {
  const tree = {
    label: 'モードで分岐',
    kind: 'selector',
    status: 'success',
    children: [
      { label: '追従モード時の動作', kind: 'sequence', status: 'failure', mode: 'follow', children: [] },
      { label: '待機モード時の動作', kind: 'sequence', status: 'success', mode: 'wait' },
      { label: '<未評価>', kind: 'action', status: null }
    ]
  };

  it('shows this tick\'s results only for the live state', () => {
    const live = renderBtTree(tree, { live: true, mode: 'wait' });
    assert.match(live, /bt-node bt-sequence is-success is-mode-branch is-current-mode/);
    assert.match(live, /bt-node bt-sequence is-failure is-mode-branch"/);
    assert.match(live, /bt-node bt-action is-skipped/);
    assert.match(live, /&lt;未評価&gt;/);

    const idle = renderBtTree(tree, { live: false, mode: 'wait' });
    assert.doesNotMatch(idle, /is-success|is-failure|bt-mark/);
  });
});

describe('orchestrator describes its live machine', () => {
  it('keeps modes out of the states and records a switch in the timeline', async () => {
    const ctx = { bot: {}, config: {}, movement: { stop() {} } };
    const orchestrator = new CompanionOrchestrator(ctx, {}, [{ name: 'recovery' }]);
    assert.equal(await orchestrator.switchMode('wait'), true);
    orchestrator._applyTransitions();

    const fsm = orchestrator.describeFsm();
    assert.equal(fsm.active, 'normal');
    assert.equal(fsm.preferredMode, 'wait');
    assert.deepEqual(fsm.modes, ['follow', 'wait']);
    assert.deepEqual([...fsm.states].sort(), [
      'boat_passenger',
      'combat',
      'death_recovery',
      'hazard_escape',
      'item_transfer',
      'loot',
      'normal',
      'passage_transit',
      'planting',
      'stuck_recovery'
    ]);
    assert.deepEqual(fsm.safetyStates, ['hazard_escape', 'boat_passenger', 'item_transfer']);
    assert.ok(
      fsm.transitions.every(
        (t) => (t.from === 'any' || fsm.states.includes(t.from)) && fsm.states.includes(t.to)
      )
    );
    assert.ok(fsm.transitions.some((t) => t.from === 'any' && t.to === 'hazard_escape'));
    assert.deepEqual(fsm.duties, [{ name: 'recovery', pending: false }]);
    assert.deepEqual(Object.keys(fsm.trees).sort(), [...fsm.states].sort());
    assert.equal(fsm.trees.normal.mode, 'wait', 'normal shows only the selected mode');
    assert.equal(fsm.history.length, 1);
    assert.equal(fsm.history[0].kind, 'mode');
    assert.equal(fsm.history[0].from, 'follow');
    assert.equal(fsm.history[0].to, 'wait');
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
      companion: { ctx: {}, manager: { describeFsm: () => ({ active: 'normal' }) } }
    });
    assert.deepEqual(buildStatus(state).fsm, { active: 'normal' });
  });
});
