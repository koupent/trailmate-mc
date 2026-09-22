/**
 * Track which retention categories fell below their target and hold one
 * merged request until chat is actually able to deliver it.
 */

export const SUPPLY_REQUEST_EVENT_ID = 'supply_request';

export class SupplyRequestTracker {
    constructor() {
        /** @type {Map<string, number>|null} missing count per category at the last reading */
        this.observed = null;
        /** @type {string[]} category order of the last reading */
        this.order = [];
        /** @type {Set<string>} categories queued for the next request */
        this.pending = new Set();
    }

    /**
     * Compare a stock reading with the previous one. The first reading asks
     * for whatever is already short; later readings only ask again when a
     * category gets worse, so a steady shortage stays quiet and a restock on
     * its own never speaks.
     *
     * @param {Array<{ id: string, missing: number }>} stock
     */
    observe(stock) {
        const previous = this.observed;
        const next = new Map();

        for (const { id, missing } of stock) {
            const before = previous?.get(id) ?? 0;
            if (missing > 0 && (previous == null || missing > before)) {
                this.pending.add(id);
            }
            // Back at target: drop any queued request and re-arm the category.
            if (missing === 0) this.pending.delete(id);
            next.set(id, missing);
        }

        this.observed = next;
        this.order = stock.map((entry) => entry.id);
        return this.peek();
    }

    /**
     * Take the current stock as already requested. Used after a 全回収 sweep,
     * where every category the sweep emptied is expected rather than reported.
     *
     * @param {Array<{ id: string, missing: number }>} stock
     */
    acknowledge(stock) {
        const previous = this.observed;
        const next = new Map();

        for (const { id, missing } of stock) {
            const before = previous?.get(id) ?? 0;
            // Only a shortage the sweep itself caused is absorbed; a request
            // that was already waiting must still be delivered.
            if (missing > before) this.pending.delete(id);
            next.set(id, missing);
        }

        this.observed = next;
        this.order = stock.map((entry) => entry.id);
    }

    /** Pending request without consuming it. */
    peek() {
        if (this.pending.size === 0) return null;
        return {
            id: SUPPLY_REQUEST_EVENT_ID,
            priority: 2,
            supplyCategories: this.order.filter((id) => this.pending.has(id))
        };
    }

    /** Consume only after the queued chat message has been delivered. */
    markDelivered() {
        this.pending.clear();
    }
}
