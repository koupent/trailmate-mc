/**
 * Companion orchestrator: NestedStateMachine is the SSOT for behavior.
 * Keeps ModeManager-compatible facade for Dialogue / ItemTransfer.
 */

import { FollowMode } from '../modes/FollowMode.js';
import { WaitMode } from '../modes/WaitMode.js';
import { createCompanionTargets } from './targets.js';
import { createRootMachine } from './createRootMachine.js';
import { prepareCompanionWorldTick } from './prepareTick.js';
import { startPassageUpkeep, syncPassageTransit } from './passageUpkeep.js';
import { deathRecoveryInProgress } from '../deathRecovery.js';
import { refreshDutyFlags, shouldEnterPassageTransit } from './transitions.js';
import { describeTree } from '../behaviorTree/bt.js';
import { CropPlanter } from '../planting/CropPlanter.js';

/** Recent transitions kept for the dashboard timeline. */
const HISTORY_LIMIT = 12;

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
            interrupts: this.interrupts,
            planter: new CropPlanter()
        });
        // Long-running normal actions use one common cooperative-yield signal.
        ctx.shouldYieldNormalAction = () => shouldEnterPassageTransit(this.targets);
        this.targets.preferredMode = defaultModeId === 'wait' ? 'wait' : 'follow';

        const built = createRootMachine(this.targets);
        this.root = built.root;
        this.fsmStates = built.states;
        this.safetyStates = built.safetyStates;
        this.root.active = true;
        this.root.onStateEntered();
        /** @type {Array<{ kind: 'state'|'mode', name: string, from: string, to: string, at: number }>} newest last */
        this.transitionHistory = [];
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
     * Player-selected mode (follow/wait). Independent of the active state.
     */
    getCurrentModeId() {
        return this.targets.preferredMode;
    }

    /**
     * Active state id: normal | planting | combat | passage_transit | loot |
     * death_recovery | stuck_recovery | hazard_escape | boat_passenger | item_transfer.
     */
    getActiveFsmId() {
        return this.targets.activeId;
    }

    /**
     * The machine as it is actually wired, for the dashboard to draw. Read
     * from the live transitions so added or removed states show up as-is.
     */
    describeFsm() {
        const all = [...this.safetyStates, ...Object.values(this.fsmStates)];
        return {
            active: this.targets.activeId,
            preferredMode: this.targets.preferredMode,
            modes: [...this.modes.keys()],
            states: all.map((state) => state.stateName),
            // Safety states are entered from any state and return to normal.
            safetyStates: this.safetyStates.map((state) => state.stateName),
            transitions: [
                ...this.safetyStates.flatMap((state) => [
                    { name: `any_to_${state.stateName}`, from: 'any', to: state.stateName },
                    { name: `${state.stateName}_to_normal`, from: state.stateName, to: 'normal' }
                ]),
                ...(this.root.transitions || []).map((transition) => ({
                    name: transition.name,
                    from: transition.parentState?.stateName,
                    to: transition.childState?.stateName
                }))
            ],
            duties: this.interrupts.map((interrupt) => ({
                name: interrupt.name,
                pending: interrupt._lastShouldRun === true
            })),
            // Each state's behavior tree with the result of its last tick.
            // The normal state shows the tree of the selected mode only.
            trees: Object.fromEntries(all.map((state) => [state.stateName, describeTree(state.tree)])),
            history: this.transitionHistory
        };
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
        const from = this.targets.preferredMode;
        this.targets.preferredMode = modeId === 'wait' ? 'wait' : 'follow';
        // Not a state transition, but the player wants to see it in the timeline.
        this._recordHistory({ kind: 'mode', name: `mode_${from}_to_${modeId}`, from, to: modeId });
        console.log(`[companion] mode -> ${modeId}`);
        return true;
    }

    async start() {
        // Root enter already called NormalBehavior.onStateEntered.
    }

    async tick() {
        if (this._busy) return;
        this._busy = true;
        try {
            // Safety states can take over from any state, in every tick:
            // environmental damage, riding as a passenger, an item hand-over.
            // The first that claims the tick owns it.
            for (const state of this.safetyStates) {
                if (await state.claim()) {
                    this._switchTo(state, `any_to_${state.stateName}`);
                    return;
                }
            }
            if (this.safetyStates.includes(this.root.activeState)) {
                // 危険回避が終わっても、墓の移動と回収が残っているなら追従に落とさない。
                const resumeRecovery = deathRecoveryInProgress(this.ctx);
                const next = resumeRecovery ? this.fsmStates.death_recovery : this.fsmStates.normal;
                const name = resumeRecovery
                    ? `${this.root.activeState.stateName}_to_death_recovery`
                    : `${this.root.activeState.stateName}_to_normal`;
                this._switchTo(next, name);
            }

            await prepareCompanionWorldTick(this.ctx);
            await refreshDutyFlags(this.targets);
            syncPassageTransit(this.ctx, this.targets);
            this._refreshPlanting();

            // A requested passage must take control before another
            // normal-state tick walks away from the door. Also let safety work
            // preempt or release an active transaction immediately.
            if (this.targets.activeId === 'passage_transit'
                || shouldEnterPassageTransit(this.targets)) {
                this._applyTransitions();
            }

            // 平常時のtickが先に走ると、その1回で追従が死亡地点の経路を消す。
            if ((this.targets.activeId === 'normal' || this.targets.activeId === 'planting')
                && deathRecoveryInProgress(this.ctx)) {
                this._applyTransitions();
            }

            // Await active behavior BEFORE transitions so combat latch is visible.
            const active = this.root.activeState;
            if (active && typeof active.runTick === 'function') {
                // Long normal actions can hold this await for seconds. Keep
                // detecting passages so they can yield to passage_transit.
                const upkeep = active === this.fsmStates.passageTransit
                    ? { stop() {} }
                    : startPassageUpkeep(this.ctx, this.targets);
                try {
                    await active.runTick();
                } catch (err) {
                    console.error(`[companion/fsm] ${active.stateName || 'active'} error:`, err);
                } finally {
                    upkeep.stop();
                }
            }

            syncPassageTransit(this.ctx, this.targets);
            this._applyTransitions();
        } catch (err) {
            console.error('[companion] fsm tick error:', err);
        } finally {
            this._busy = false;
        }
    }

    /** @param {{ kind: 'state'|'mode', name: string, from: string, to: string }} entry */
    _recordHistory(entry) {
        this.transitionHistory.push({ ...entry, at: Date.now() });
        if (this.transitionHistory.length > HISTORY_LIMIT) this.transitionHistory.shift();
    }

    /** Planting work is looked up once per tick, only where it can matter. */
    _refreshPlanting() {
        const { targets } = this;
        if (targets.preferredMode === 'follow'
            && (targets.activeId === 'normal' || targets.activeId === 'planting')) {
            targets.planter.findWork(this.ctx);
        } else {
            targets.planter.work = null;
        }
    }

    /**
     * Move to `next`, recording the change for the dashboard.
     * @param {object} next
     * @param {string} name
     */
    _switchTo(next, name) {
        const nested = this.root;
        const current = nested.activeState;
        if (current === next) return;
        this._recordHistory({ kind: 'state', name, from: current.stateName, to: next.stateName });
        current.active = false;
        current.onStateExited?.();
        nested.activeState = next;
        next.active = true;
        next.onStateEntered?.();
        nested.emit?.('stateChanged');
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
            transition.onTransition();
            this._switchTo(transition.childState, transition.name);
            return;
        }
    }
}

/** @deprecated Alias kept for gradual renames — prefer CompanionOrchestrator. */
export { CompanionOrchestrator as ModeManager };
