import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeThreatArc, spanDegrees } from '../src/combat/threatArc.js';
import {
  createScenario,
  stepSimulation,
  type SimulationDecision,
  type SimulationState
} from '../src/simulator/SimulationCore.js';

function runUntil(
  initial: SimulationState,
  predicate: (state: SimulationState, decision: SimulationDecision) => boolean,
  maxTicks = 80
) {
  let state = initial;
  let decision: SimulationDecision | null = null;
  for (let index = 0; index < maxTicks; index += 1) {
    ({ state, decision } = stepSimulation(state));
    if (predicate(state, decision)) return { state, decision };
  }
  throw new Error(`condition not reached after ${maxTicks} ticks`);
}

describe('desktop combat simulator core', () => {
  it('uses the shared ranged latch for dodge -> advance -> attack', () => {
    let state = createScenario('single-ranged');
    let result = stepSimulation(state);
    assert.equal(result.decision.controlOwner, 'combat');
    assert.equal(result.decision.movement, 'dodge');

    ({ state } = result);
    result = runUntil(state, (next) => next.attacks > 0);
    assert.equal(result.decision.movement, 'attack');
    assert.ok(result.state.attacks > 0);
  });

  it('uses shared threat-arc selection and improves a front/back layout', () => {
    const state = createScenario('multi-positioning');
    const before = computeThreatArc(state.bot, state.enemies)!;
    const result = stepSimulation(state);
    const after = computeThreatArc(result.state.bot, result.state.enemies)!;
    assert.equal(result.decision.movement, 'positioning');
    assert.ok(result.decision.destination);
    assert.ok(result.decision.selectedSpanDeg! < spanDegrees(before.spanRad));
    assert.ok(result.decision.validation.every((check) => check.pass));
    assert.ok(spanDegrees(after.spanRad) < spanDegrees(before.spanRad));
  });

  it('runs grave recovery through shared owned-ID policy then reacquires combat', () => {
    const initial = createScenario('recovery');
    const recovered = runUntil(initial, (state) => !state.recovery.active);
    assert.equal(recovered.state.equipped, 'iron_sword');
    assert.ok(recovered.state.inventory.includes('iron_boots'));
    assert.ok(recovered.state.transitions.some((line) => line.includes('grave → items')));

    const combat = stepSimulation(recovered.state);
    assert.equal(combat.decision.controlOwner, 'combat');
    assert.ok(combat.decision.primaryId);
  });

  it('keeps unrelated pre-grave drops outside the Recovery owned set', () => {
    let state = createScenario('recovery');
    state.drops.push({ id: 77, item: 'dirt', x: 0.2, z: 0.2 });
    const reachedItems = runUntil(state, (next) => next.recovery.phase === 'items');
    const captured = stepSimulation(reachedItems.state);
    assert.ok(!captured.state.recovery.ownedItemIds.includes(77));
  });
});
