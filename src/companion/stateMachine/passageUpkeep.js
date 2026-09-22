/**
 * Keep passage detection alive while a behavior tick holds the orchestrator.
 *
 * Duty runs (loot pickup, death recovery) await for seconds inside a single
 * orchestrator tick, and the DoorTracker tick in prepareCompanionWorldTick
 * never runs meanwhile. Detection requests the passage_transit FSM state and
 * asks interruptible normal work to yield; every door operation is owned by
 * that state.
 */

import { safetyDutyPending } from './transitions.js';

const DEFAULT_PERIOD_MS = 250;

/** Mirror DoorTracker transaction state onto the FSM blackboard. */
export function syncPassageTransit(ctx, targets) {
    const pending = Boolean(ctx?.doors?.passagePending);
    if (targets) targets._passagePending = pending;

    if (!pending || targets?.activeId === 'combat' || targets?.activeId === 'passage_transit'
        || ctx?.hazardEscape?.active
        || (targets && safetyDutyPending(targets))) {
        return pending;
    }

    // Acquire the transaction before the stop: stopping resets the pathfinder,
    // and only a candidate the FSM has not taken yet may be dropped there.
    ctx?.doors?.claimPassage?.();
    // Stop ordinary movement immediately; the active async action observes the
    // shared shouldYieldNormalAction signal and returns control to the FSM.
    ctx?.movement?.stop?.();
    return pending;
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ paused?: boolean }} [targets]
 * @param {number} [periodMs]
 * @returns {{ stop: () => void }}
 */
export function startPassageUpkeep(ctx, targets, periodMs) {
    const doors = ctx?.doors;
    if (typeof doors?.tick !== 'function') return { stop() {} };

    const period = Math.max(1, periodMs ?? ctx?.config?.tick_ms ?? DEFAULT_PERIOD_MS);
    let running = false;
    const timer = setInterval(() => {
        // Item transfer pauses the FSM; keep door handling paused with it.
        if (running || targets?.paused) return;
        running = true;
        Promise.resolve()
            .then(() => doors.tick())
            .then(() => syncPassageTransit(ctx, targets))
            .catch((err) => {
                console.error('[companion] passage upkeep error:', err);
            })
            .finally(() => {
                running = false;
            });
    }, period);
    timer.unref?.();

    return {
        stop() {
            clearInterval(timer);
        }
    };
}
