/** Distance that counts as real progress before the stuck timer resets. */
const PROGRESS_BLOCKS = 0.75;

/**
 * Observes movement progress. Pure measurement: it never touches the bot.
 */
export class StuckMonitor {
    constructor() {
        this.anchor = null;
        this.lastAt = Date.now();
        this.seconds = 0;
    }

    /**
     * @param {import('mineflayer').Bot} bot
     * @param {boolean} tryingToMove
     * @returns {number} seconds without progress
     */
    update(bot, tryingToMove) {
        const now = Date.now();
        // Cap dt so a paused process (or long GC) cannot fake a long stall.
        const dt = Math.min(1, (now - this.lastAt) / 1000);
        this.lastAt = now;

        const pos = bot.entity.position;
        if (!tryingToMove) {
            this.reset(pos);
            return 0;
        }

        if (!this.anchor || this.anchor.distanceTo(pos) >= PROGRESS_BLOCKS) {
            this.reset(pos);
            return 0;
        }

        this.seconds += dt;
        return this.seconds;
    }

    /**
     * @param {{clone: Function}} pos
     */
    reset(pos) {
        this.anchor = pos ? pos.clone() : null;
        this.seconds = 0;
    }
}
