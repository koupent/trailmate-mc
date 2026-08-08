/**
 * Companion orchestrator: NestedStateMachine is the SSOT for behavior.
 * Keeps ModeManager-compatible facade for Dialogue / ItemTransfer.
 */

import { FollowMode } from '../modes/FollowMode.js';
import { WaitMode } from '../modes/WaitMode.js';
import { createCompanionTargets } from './targets.js';
import { createRootMachine } from './createRootMachine.js';
import { prepareCompanionWorldTick } from './prepareTick.js';
import { refreshDutyFlags } from './transitions.js';

export class CompanionOrchestrator {
    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {import('../../host/BotHost.ts').TrailmateHost} agent
     * @param {Array<{ name: string, shouldRun: Function, run: Function }>} interrupts
     * @param {string} [defaultModeId='follow']
     */
    constructor(ctx, agent, interrupts, defaultModeId = 'follow') {
        this.ctx = ctx;
        this.agent = agent;
        this.interrupts = interrupts || [];
        this._busy = false;

        this.followMode = new FollowMode();
        this.waitMode = new WaitMode();
        /** @type {Map<string, import('../Mode.js').Mode>} */
        this.modes = new Map([
            ['follow', this.followMode],
            ['wait', this.waitMode]
        ]);

        this.targets = createCompanionTargets({
            ctx,
            agent,
            followMode: this.followMode,
            waitMode: this.waitMode,
            interrupts: this.interrupts
        });
        this.targets.preferredMode = defaultModeId === 'wait' ? 'wait' : 'follow';

        const built = createRootMachine(this.targets);
        this.root = built.root;
        this.fsmStates = built.states;
        this.root.active = true;
        this.root.onStateEntered();
    }

    pause() {
        this.targets.paused = true;
    }

    resume() {
        this.targets.paused = false;
    }

    get isPaused() {
        return this.targets.paused;
    }

    getModeCatalog() {
        return [...this.modes.values()].map((m) => ({
            id: m.id,
            description: m.description
        }));
    }

    /**
     * Dialogue-facing mode id (follow/wait), not combat/duty overlays.
     */
    getCurrentModeId() {
        return this.targets.preferredMode;
    }

    /**
     * Active NestedStateMachine leaf id (follow|wait|combat|duty).
     */
    getActiveFsmId() {
        return this.targets.activeId;
    }

    /**
     * @param {string} modeId
     * @returns {Promise<boolean>}
     */
    async switchMode(modeId) {
        if (!modeId || modeId === this.targets.preferredMode) return false;
        if (!this.modes.has(modeId)) {
            console.warn(`[companion] ignored unknown mode: ${modeId}`);
            return false;
        }
        this.targets.preferredMode = modeId === 'wait' ? 'wait' : 'follow';
        console.log(`[companion] mode -> ${modeId}`);
        return true;
    }

    async start() {
        // Root enter already called FollowBehavior.onStateEntered.
    }

    async tick() {
        if (this._busy) return;
        this._busy = true;
        try {
            // Environmental damage can happen in every FSM state, including
            // wait and paused item-transfer work. Safety owns this tick until
            // the bot reaches a clear standable position.
            if (this.ctx.hazardEscape?.tick?.()) return;
            if (this.targets.paused) return;
            await prepareCompanionWorldTick(this.ctx);
            await refreshDutyFlags(this.targets);

            // Await active behavior BEFORE transitions so combat latch is visible.
            const active = this.root.activeState;
            if (active && typeof active.runTick === 'function') {
                try {
                    await active.runTick();
                } catch (err) {
                    console.error(`[companion/fsm] ${active.stateName || 'active'} error:`, err);
                }
            }

            this._applyTransitions();
        } catch (err) {
            console.error('[companion] fsm tick error:', err);
        } finally {
            this._busy = false;
        }
    }

    /**
     * NestedStateMachine.update() runs behavior then transitions without awaiting.
     * We await runTick ourselves, then only evaluate transitions here.
     */
    _applyTransitions() {
        const nested = this.root;
        const transitions = nested.transitions || [];
        for (let i = 0; i < transitions.length; i++) {
            const transition = transitions[i];
            if (transition.parentState !== nested.activeState) continue;
            if (!(transition.isTriggered() || transition.shouldTransition())) continue;
            transition.resetTrigger();
            nested.activeState.active = false;
            nested.activeState.onStateExited?.();
            transition.onTransition();
            nested.activeState = transition.childState;
            nested.activeState.active = true;
            nested.activeState.onStateEntered?.();
            nested.emit?.('stateChanged');
            return;
        }
    }
}

/** @deprecated Alias kept for gradual renames — prefer CompanionOrchestrator. */
export { CompanionOrchestrator as ModeManager };
