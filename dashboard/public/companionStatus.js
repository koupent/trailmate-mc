/** Missing polls are not proof that the bot despawned. Keep a clearly stale
 * snapshot until a successful response explicitly reports spawned=false. */
export function createCompanionStatusCache() {
    let last = null;
    return {
        update(status) {
            const unavailable = !status || status.backendReady === false || status.spawned == null;
            if (unavailable) return { snapshot: last, stale: Boolean(last) };
            if (!status.spawned) { last = null; return { snapshot: null, stale: false }; }
            const incomplete = !status.fsm && Boolean(last?.fsm);
            last = { ...status, fsm: status.fsm ?? last?.fsm ?? null };
            return { snapshot: last, stale: incomplete };
        }
    };
}
