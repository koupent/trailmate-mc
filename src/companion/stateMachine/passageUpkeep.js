/**
 * Keep passage detection alive while a behavior tick holds the orchestrator.
 *
 * Duty runs (loot pickup, death recovery) await for seconds inside a single
 * orchestrator tick, and the DoorTracker tick in prepareCompanionWorldTick
 * never runs meanwhile. Detection requests the passage_cleanup FSM state and
 * asks interruptible normal work to yield; closing is owned by that state.
 */

import { safetyDutyPending } from './transitions.js';

const DEFAULT_PERIOD_MS = 250;

/** Mirror DoorTracker transaction state onto the FSM blackboard. */
export function syncPassageCleanup(ctx, targets) {
    const pending = Boolean(ctx?.doors?.cleanupPending);
    if (targets) targets._passagePending = pending;

    if (!pending || targets?.activeId === 'combat' || targets?.activeId === 'passage_cleanup'
        || ctx?.hazardEscape?.active
        || (targets && safetyDutyPending(targets))) {
        return pending;
    }

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
            .then(() => doors.tick({ allowClose: false }))
            .then(() => syncPassageCleanup(ctx, targets))
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
