export const DEFAULT_INVENTORY_FILL_THRESHOLDS = [75, 90, 100];
export const DEFAULT_INVENTORY_FILL_REARM_SLOTS = 2;

const LEVELS = [
    { id: 'inventory_fill_high', rank: 0 },
    { id: 'inventory_fill_critical', rank: 1 },
    { id: 'inventory_fill_full', rank: 2 }
];

/**
 * Retains the highest unsent fill milestone so chat throttling cannot lose it.
 * Each milestone rearms independently after enough slots have been emptied.
 */
export class InventoryFillTracker {
    constructor(options = {}) {
        const thresholds = normalizeThresholds(options.thresholds);
        this.levels = LEVELS.map((level, index) => ({
            ...level,
            percent: thresholds[index]
        }));
        this.rearmSlots = normalizeRearmSlots(options.rearmSlots);
        this.armed = new Set(this.levels.map((level) => level.id));
        this.pending = null;
    }

    /** Observe a live inventory snapshot and retain any newly reached stage. */
    observe(snapshot = {}) {
        const usedSlots = Number(snapshot.inventoryUsedSlots);
        const totalSlots = Number(snapshot.inventoryTotalSlots);
        if (!Number.isFinite(usedSlots) || !Number.isFinite(totalSlots) || totalSlots <= 0) {
            return this.peek();
        }

        for (const level of this.levels) {
            const thresholdSlots = slotsForPercent(totalSlots, level.percent);
            if (usedSlots <= thresholdSlots - this.rearmSlots) {
                this.armed.add(level.id);
            }
        }

        const reached = this.levels.filter((level) => (
            this.armed.has(level.id)
            && usedSlots >= slotsForPercent(totalSlots, level.percent)
        ));
        if (reached.length === 0) return this.peek();

        for (const level of reached) this.armed.delete(level.id);
        const highest = reached[reached.length - 1];
        if (!this.pending || highest.rank >= this.pending.rank) {
            this.pending = {
                ...highest,
                usedSlots,
                totalSlots,
                emptySlots: Math.max(0, totalSlots - usedSlots)
            };
        }
        return this.peek();
    }

    /** Return an event payload without consuming it. */
    peek() {
        if (!this.pending) return null;
        return {
            id: this.pending.id,
            priority: 2,
            inventoryFill: { ...this.pending }
        };
    }

    /** Consume only after the queued chat message has been delivered. */
    markDelivered() {
        this.pending = null;
    }
}

export function slotsForPercent(totalSlots, percent) {
    return Math.ceil((totalSlots * percent) / 100);
}

function normalizeThresholds(value) {
    if (!Array.isArray(value) || value.length !== LEVELS.length) {
        return [...DEFAULT_INVENTORY_FILL_THRESHOLDS];
    }
    const thresholds = value.map(Number);
    const valid = thresholds.every((threshold, index) => (
        Number.isFinite(threshold)
        && threshold > 0
        && threshold <= 100
        && (index === 0 || threshold > thresholds[index - 1])
    )) && thresholds[thresholds.length - 1] === 100;
    return valid ? thresholds : [...DEFAULT_INVENTORY_FILL_THRESHOLDS];
}

function normalizeRearmSlots(value) {
    const slots = Number(value);
    return Number.isInteger(slots) && slots >= 1
        ? slots
        : DEFAULT_INVENTORY_FILL_REARM_SLOTS;
}
