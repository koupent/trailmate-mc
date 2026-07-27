import { jumpOntoStep, sleep } from '../movement/climb.js';
import { scanSurroundings } from '../movement/surroundings.js';

/** Cooldown after any recovery action, so the path gets a chance to work. */
const COOLDOWN_MS = 900;
/** Neighbours raised by ≥1 that mean "we are in a depression". */
const HOLE_RAISED_MIN = 2;
/** Fallback when config omits follow_min_distance. */
const DEFAULT_FOLLOW_MIN_DISTANCE = 2;
/** Retry the same ledge this many times before picking a new one. */
const MAX_CLIMB_STICKY_ATTEMPTS = 4;
/** Prefer a manual jump when this close to the ledge lip. */
const MANUAL_JUMP_DISTANCE = 1.35;
/** After this many sticky attempts, always jump manually. */
const MANUAL_JUMP_AFTER_ATTEMPTS = 2;
/** Hold duration for climbTo pathfinder goals (ms). */
const CLIMB_HOLD_MS = 2000;
/** Brief pause after stopping pathfinder before a manual jump (ms). */
const PRE_JUMP_PAUSE_MS = 60;

/**
 * Gets the bot moving again when the path stalls.
 *
 * Climbing out of holes is handed to pathfinder via climbTo() first.
 * Manual jump is used when already against the lip (pathfinder alone stalls).
 * Never places or breaks blocks (companion block protection).
 */
export class RecoveryInterrupt {
    constructor() {
        this.name = 'recovery';
        this.cooldownUntil = 0;
        this._climbAttempts = 0;
        this._stickyCell = null;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    shouldRun(ctx) {
        if (Date.now() < this.cooldownUntil) return false;
        if (!ctx.ownerEntity) return false;
        if (ctx.movement.isHeld) return false;

        const owner = ctx.ownerEntity;
        const botPos = ctx.bot.entity.position;
        const xz = Math.hypot(owner.position.x - botPos.x, owner.position.z - botPos.z);
        const minDistance = ctx.config.follow_min_distance ?? DEFAULT_FOLLOW_MIN_DISTANCE;
        // Already next to the owner: climbing toward them only causes bumping in caves.
        if (xz < minDistance) {
            return false;
        }

        return ctx.movement.isBlocked || ctx.stuck.seconds >= ctx.config.stuck_detect_seconds;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    async run(ctx) {
        const bot = ctx.bot;
        const owner = ctx.ownerEntity;
        const start = bot.entity.position.clone();
        const dy = owner.position.y - start.y;
        const around = scanSurroundings(bot, owner.position);
        const plan = choosePlan(around, dy);

        await this._perform(ctx, plan);

        ctx.stuck.reset(bot.entity.position);
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }

    async _perform(ctx, plan) {
        if (plan.action !== 'path_climb') return;

        const bot = ctx.bot;
        // Stick to the same ledge for several attempts instead of
        // switching climb targets every tick.
        if (!this._stickyCell || this._climbAttempts >= MAX_CLIMB_STICKY_ATTEMPTS) {
            this._stickyCell = plan.cell;
            this._climbAttempts = 1;
        } else {
            this._climbAttempts += 1;
        }
        const cell = this._stickyCell;
        const distToStep = Math.hypot(
            cell.center.x - bot.entity.position.x,
            cell.center.z - bot.entity.position.z
        );

        // When already against the lip, skip GoalNear and jump manually.
        const preferManual =
            distToStep <= MANUAL_JUMP_DISTANCE ||
            this._climbAttempts >= MANUAL_JUMP_AFTER_ATTEMPTS;
        if (!preferManual) {
            ctx.movement.climbTo(cell.center, CLIMB_HOLD_MS);
            return;
        }

        ctx.movement.stop();
        bot.clearControlStates();
        await sleep(PRE_JUMP_PAUSE_MS);
        await jumpOntoStep(bot, cell.center);
        this._climbAttempts = 0;
        this._stickyCell = null;
    }
}

/**
 * @param {ReturnType<import('../movement/surroundings.js').scanSurroundings>} around
 * @param {number} dy
 */
export function choosePlan(around, dy) {
    const inHole = around.raisedNeighbors >= HOLE_RAISED_MIN;

    // Owner below: do not climb the wrong wall.
    if (dy < -0.5 && !inHole) {
        return { action: 'wait' };
    }

    if (around.stepUps.length > 0 && dy > 0.3) {
        return { action: 'path_climb', cell: around.stepUps[0] };
    }

    // Any adjacent +1 ledge is an exit when surrounded or the owner is above.
    if (around.escapes.length > 0 && (inHole || dy > 0.5)) {
        return { action: 'path_climb', cell: around.escapes[0] };
    }

    // No scaffolding / pillar: wait for a non-destructive path instead.
    return { action: 'wait' };
}
