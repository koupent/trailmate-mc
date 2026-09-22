/**
 * Keep passage detection alive while a behavior tick holds the orchestrator.
 *
 * Duty runs (loot pickup, death recovery) await for seconds inside a single
 * orchestrator tick, and the DoorTracker tick in prepareCompanionWorldTick
 * never runs meanwhile. Detection requests the passage_transit FSM state and
 * asks interruptible normal work to yield; every door operation is owned by
 * that state.
 */

const DEFAULT_PERIOD_MS = 250;

/**
 * Mirror the DoorTracker job onto the FSM blackboard.
 *
 * Nothing is stopped here. The long normal action observes the shared
 * `shouldYieldNormalAction` signal and hands control back on its own, and
 * `passage_transit` then issues whatever goal the job needs. Stopping movement
 * on every one of these ticks reset the pathfinder four times a second while
 * the bot was still walking somewhere perfectly sensible.
 */
export function syncPassageTransit(ctx, targets) {
    const pending = Boolean(ctx?.doors?.passagePending);
    if (targets) targets._passagePending = pending;
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
