/**
 * Keep passage tracking alive while a behavior tick holds the orchestrator.
 *
 * Duty runs (loot pickup, death recovery) await for seconds inside a single
 * orchestrator tick, and the DoorTracker tick in prepareCompanionWorldTick
 * never runs meanwhile. Without this upkeep a gate the bot crosses on the way
 * to a drop stays open: the close request only fires once the duty returns,
 * by which time the bot is usually out of interaction reach.
 */

const DEFAULT_PERIOD_MS = 250;

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
