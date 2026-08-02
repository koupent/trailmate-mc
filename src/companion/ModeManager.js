import { tickOwnerWork } from './ownerWorkTracker.js';

/**
 * Runs recovery interrupts, then the active registered mode.
 * New modes are discovered via the registry for dialogue / mode switching.
 */
export class ModeManager {
    /**
     * @param {import('./CompanionContext.js').CompanionContext} ctx
     * @param {import('./Mode.js').Mode[]} modes
     * @param {Array<{ name: string, shouldRun: Function, run: Function }>} interrupts
     * @param {string} [defaultModeId='follow']
     */
    constructor(ctx, modes, interrupts, defaultModeId = 'follow') {
        this.ctx = ctx;
        this.interrupts = interrupts || [];
        this._busy = false;
        /** @type {Map<string, import('./Mode.js').Mode>} */
        this.modes = new Map();
        for (const mode of modes) {
            if (!mode?.id) throw new Error('ModeManager: each mode needs an id');
            if (this.modes.has(mode.id)) throw new Error(`ModeManager: duplicate mode id ${mode.id}`);
            this.modes.set(mode.id, mode);
        }
        if (!this.modes.has(defaultModeId)) {
            throw new Error(`ModeManager: default mode "${defaultModeId}" is not registered`);
        }
        this.currentId = defaultModeId;
        this.mode = this.modes.get(defaultModeId);
        /** When true, tick skips modes/interrupts (e.g. item transfer). */
        this._paused = false;
    }

    /** Pause mode ticks without leaving the current mode. */
    pause() {
        this._paused = true;
    }

    /** Resume mode ticks after a temporary pause. */
    resume() {
        this._paused = false;
    }

    get isPaused() {
        return this._paused;
    }

    /** @returns {{ id: string, description: string }[]} */
    getModeCatalog() {
        return [...this.modes.values()].map((m) => ({
            id: m.id,
            description: m.description
        }));
    }

    getCurrentModeId() {
        return this.currentId;
    }

    /**
     * Switch to a registered mode. Unknown ids are rejected (no-op).
     * @param {string} modeId
     * @returns {Promise<boolean>} true if switched
     */
    async switchMode(modeId) {
        if (!modeId || modeId === this.currentId) return false;
        const next = this.modes.get(modeId);
        if (!next) {
            console.warn(`[companion] ignored unknown mode: ${modeId}`);
            return false;
        }

        try {
            await this.mode.onExit(this.ctx);
        } catch (err) {
            console.error(`[companion] onExit(${this.currentId}) error:`, err);
        }

        this.currentId = modeId;
        this.mode = next;
        console.log(`[companion] mode -> ${modeId}`);

        try {
            await this.mode.onEnter(this.ctx);
        } catch (err) {
            console.error(`[companion] onEnter(${modeId}) error:`, err);
        }
        return true;
    }

    async start() {
        await this.mode.onEnter(this.ctx);
    }

    async tick() {
        if (this._busy || this._paused) return;

        this._busy = true;
        try {
            this.ctx.invalidateCompanionAwareness?.();
            tickOwnerWork(this.ctx);
            this.ctx.worldState.update(this.ctx);
            this.ctx.stuck.update(this.ctx.bot, this.ctx.movement.hasGoal);
            const detectSec = this.ctx.config?.stuck_detect_seconds ?? 1.5;
            if (this.ctx.stuck.seconds >= detectSec) {
                // Sticky until dialogue speaks; survives RecoveryInterrupt stuck.reset.
                this.ctx.stuckChat = {
                    seconds: Number(this.ctx.stuck.seconds.toFixed(1)),
                    at: Date.now()
                };
            }
            await this.ctx.doors?.tick();

            for (const interrupt of this.interrupts) {
                if (!(await interrupt.shouldRun(this.ctx))) continue;
                await interrupt.run(this.ctx);
                return;
            }

            await this.mode.tick(this.ctx);
        } catch (err) {
            console.error('[companion] tick error:', err);
        } finally {
            this._busy = false;
        }
    }
}
