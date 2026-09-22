import { AsyncTickBehavior } from './AsyncTickBehavior.js';

/**
 * Owns one passage transaction end to end: approach, open, confirm open,
 * cross, then close and confirm closed. No other state touches a door, so a
 * blocked crossing can no longer strand a normal behavior in front of a gate.
 */
export class PassageTransitBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('passage_transit');
        this.targets = targets;
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'passage_transit';
        const ctx = this.targets.ctx;
        // Acquire before stopping: the pathfinder reset that the stop triggers
        // must not discard the transaction this state is taking over.
        ctx.doors?.claimPassage?.();
        ctx.movement?.stop?.();
        ctx.doors?.resumePassage?.();
    }

    onStateExited() {
        // Combat and hazard escape pause the deadline instead of consuming it.
        this.targets.ctx.doors?.suspendPassage?.();
        super.onStateExited();
    }

    async runTick() {
        const { targets } = this;
        if (targets.paused) return;
        const ctx = targets.ctx;
        const doors = ctx.doors;
        if (!doors?.passagePending) return;

        doors.claimPassage?.();
        doors.resumePassage?.();

        const movement = ctx.movement;
        if (movement?.isBlocked || movement?.isUnreachable) {
            movement.stop?.();
            doors.failPassage?.('unreachable');
            return;
        }

        const step = doors.advancePassage();
        switch (step.action) {
            case 'move':
                movement?.goToward?.(step.target, step.range);
                return;
            case 'open':
                movement?.stop?.();
                await doors.openPassage();
                return;
            case 'close':
                movement?.stop?.();
                await doors.closePassage();
                return;
            case 'fail':
                movement?.stop?.();
                doors.failPassage?.(step.reason || 'unknown');
                return;
            case 'done':
                movement?.stop?.();
                doors.finishPassage?.();
                return;
            default:
                // Waiting for the server to publish an open/close state.
                movement?.stop?.();
        }
    }
}
