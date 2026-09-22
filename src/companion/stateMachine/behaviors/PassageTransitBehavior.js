import { AsyncTickBehavior } from './AsyncTickBehavior.js';

/**
 * Runs the one passage job the tracker selected: walk into reach, activate the
 * block, report the result. Nothing else touches a door, so a blocked passage
 * can no longer strand a normal behavior in front of a gate.
 *
 * Movement is stopped in exactly one place — immediately before an activation,
 * so the click cannot race the bot's own walk. Every other branch leaves the
 * pathfinder alone; stopping on a tick that is only waiting for the server was
 * costing a goal reset and a path reset per tick, for nothing.
 */
export class PassageTransitBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('passage_transit');
        this.targets = targets;
        /** @type {string|null} Job this behavior has issued a move for. */
        this._movedFor = null;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'passage_transit';
        this._movedFor = null;
        this.targets.ctx.doors?.resumePassage?.();
    }

    onStateExited() {
        // Combat and hazard escape pause the deadline instead of consuming it.
        this.targets.ctx.doors?.suspendPassage?.();
        this._movedFor = null;
        super.onStateExited();
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        const ctx = targets.ctx;
        const doors = ctx.doors;
        if (!doors?.passagePending) return;

        doors.resumePassage?.();

        const movement = ctx.movement;
        const job = jobToken(doors.passageJob);
        if (this._movedFor && this._movedFor !== job) this._movedFor = null;
        // Only a move this behavior issued for this job can prove the passage is
        // out of reach. A follow route that died before the job started says
        // nothing about it, and used to fail the job on the entry tick.
        if (this._movedFor === job && (movement?.isBlocked || movement?.isUnreachable)) {
            doors.failPassage?.('unreachable');
            return;
        }

        const step = doors.advancePassage();
        switch (step.action) {
            case 'move':
                this._movedFor = job;
                movement?.goToward?.(step.target, step.range);
                return;
            case 'activate':
                movement?.stop?.();
                await doors.activatePassage();
                return;
            case 'fail':
                doors.failPassage?.(step.reason || 'unknown');
                return;
            case 'done':
                doors.finishPassage?.();
                return;
            default:
                // Waiting for the server to publish the requested block state.
        }
    }
}

/** @param {{ intent: string, key: string }|null} job */
function jobToken(job) {
    return job ? `${job.intent}:${job.key}` : null;
}
