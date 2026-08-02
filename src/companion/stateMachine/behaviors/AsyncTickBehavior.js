/**
 * Fire-and-forget async work inside sync StateBehavior.update().
 */
export class AsyncTickBehavior {
    constructor(stateName) {
        this.stateName = stateName;
        this.active = false;
        this._busy = false;
    }

    onStateEntered() {
        this.active = true;
    }

    onStateExited() {
        this.active = false;
    }

    update() {
        if (!this.active || this._busy) return;
        this._busy = true;
        Promise.resolve()
            .then(() => this.runTick())
            .catch((err) => {
                console.error(`[companion/fsm] ${this.stateName} error:`, err);
            })
            .finally(() => {
                this._busy = false;
            });
    }

    /** @returns {void|Promise<void>} */
    async runTick() {}
}
