import { Vec3 } from 'vec3';
import { currentControlOwner } from '../ControlPriority.js';

/**
 * Blocks whose vanilla climb is reproduced by prismarine-physics when the body
 * is pressed into the wall behind them: `isOnLadder(feet)` together with
 * `isCollidedHorizontally` raises `vel.y` to the climb speed.
 *
 * Scaffolding is deliberately absent even though `isOnLadder` accepts it.
 * Vanilla climbs scaffolding with jump, and the `climbUsingJump` support
 * feature exists in no minecraft-data version, so jump can never lift the bot
 * here. Ladder and vine are the only two that behave alike on both sides.
 */
const CLIMBABLE_COLUMN_BLOCKS = new Set(['ladder', 'vine']);

/** Controls this climb presses. Released together on every exit. */
const CLIMB_CONTROLS = ['forward', 'sprint'];

/** The owner must be at least this far above before a climb starts. */
export const CLIMB_MIN_OWNER_DY = 2;
/** Give up once the feet Y has not risen for this long. */
export const CLIMB_STALL_MS = 1500;
/** Hard cap on a single climb, stall or not. */
export const CLIMB_TIMEOUT_MS = 12000;
/** Forward push kept after the column ends, to land on top of the wall. */
export const CLIMB_TOP_OUT_MS = 800;
/** Climb restarts allowed after sliding back off the top. */
export const CLIMB_MAX_TOP_OUT_RETRIES = 2;
/** Ordinary follow gets this long back after a wall refuses to be climbed. */
export const CLIMB_RETRY_COOLDOWN_MS = 3000;
/** Feet Y gain that counts as climb progress. */
const CLIMB_PROGRESS_EPSILON = 0.15;

/**
 * Exits that mean the wall itself is the problem. They hold the next attempt
 * off for a cooldown, so a vine that breaks halfway cannot pin the companion in
 * a loop of doomed climbs instead of letting it follow.
 */
const CLIMB_FAILURE_REASONS = new Set(['stalled', 'timeout', 'top-out-failed']);

/** Probe order for the supporting wall. Fixed so the choice is reproducible. */
const HORIZONTAL_NEIGHBORS = [
    { x: 0, z: -1 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    { x: -1, z: 0 }
];

/**
 * @typedef {{ x: number, z: number }} HorizontalDirection
 * @typedef {{ cell: Vec3, push: HorizontalDirection }} ClimbColumn
 */

/**
 * @param {{ name?: string }|null|undefined} block
 * @returns {boolean}
 */
export function isClimbableColumnBlock(block) {
    return CLIMBABLE_COLUMN_BLOCKS.has(block?.name ?? '');
}

/**
 * Horizontal direction that presses the body into the wall holding the column.
 *
 * The four neighbours are probed instead of the block state, so vine
 * `north/south/east/west` and ladder `facing` never have to be told apart. A
 * column with no solid neighbour (a vine hanging in open air) returns null and
 * is never climbed: physics would have nothing to collide with.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} cell block coordinates
 * @returns {HorizontalDirection|null}
 */
export function findClimbPushDirection(bot, cell) {
    if (!cell || typeof bot?.blockAt !== 'function') return null;

    const x = Math.floor(cell.x);
    const y = Math.floor(cell.y);
    const z = Math.floor(cell.z);
    for (const direction of HORIZONTAL_NEIGHBORS) {
        const neighbor = bot.blockAt(new Vec3(x + direction.x, y, z + direction.z));
        if (neighbor?.boundingBox === 'block') return { ...direction };
    }
    return null;
}

/**
 * The climbable column the bot is standing in right now.
 *
 * Only the feet cell is inspected, matching `isOnLadder`, which reads the
 * entity position and nothing else.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} [position]
 * @returns {ClimbColumn|null}
 */
export function findStandingClimbColumn(bot, position = bot?.entity?.position) {
    if (!position || typeof bot?.blockAt !== 'function') return null;

    const cell = new Vec3(
        Math.floor(position.x),
        Math.floor(position.y + 0.001),
        Math.floor(position.z)
    );
    if (!isClimbableColumnBlock(bot.blockAt(cell))) return null;

    const push = findClimbPushDirection(bot, cell);
    return push ? { cell, push } : null;
}

/**
 * Yaw that makes `forward` walk along a horizontal direction.
 * Mineflayer's forward vector is `(-sin(yaw), -cos(yaw))`.
 *
 * @param {HorizontalDirection} direction
 * @returns {number}
 */
export function yawTowardDirection(direction) {
    return Math.atan2(-direction.x, -direction.z);
}

/**
 * Hand-rolled ladder / vine climb.
 *
 * mineflayer-pathfinder never emits an upward move for this companion:
 * `allow1by1towers` is off, so `getMoveUp` returns before it can use a
 * climbable, and vines are not in `climbables` at all. A follow route therefore
 * ends at the foot of the wall — which is exactly where this controller starts.
 *
 * From there physics asks for nothing but standing in the column and walking
 * into the wall behind it. Jump is never touched, because `climbUsingJump` is
 * false everywhere and `isCollidedHorizontally` is the only climb trigger left.
 */
export class ColumnClimber {
    /**
     * @param {{
     *   now?: () => number,
     *   minOwnerDy?: number,
     *   stallMs?: number,
     *   timeoutMs?: number,
     *   topOutMs?: number,
     *   maxTopOutRetries?: number,
     *   retryCooldownMs?: number
     * }} [options]
     */
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.minOwnerDy = options.minOwnerDy ?? CLIMB_MIN_OWNER_DY;
        this.stallMs = options.stallMs ?? CLIMB_STALL_MS;
        this.timeoutMs = options.timeoutMs ?? CLIMB_TIMEOUT_MS;
        this.topOutMs = options.topOutMs ?? CLIMB_TOP_OUT_MS;
        this.maxTopOutRetries = options.maxTopOutRetries ?? CLIMB_MAX_TOP_OUT_RETRIES;
        this.retryCooldownMs = options.retryCooldownMs ?? CLIMB_RETRY_COOLDOWN_MS;

        /** @type {'idle' | 'climbing' | 'topping'} */
        this.phase = 'idle';
        /** @type {HorizontalDirection|null} */
        this._push = null;
        this._blockedUntil = 0;
        this._startedAt = 0;
        this._progressAt = 0;
        this._bestY = 0;
        this._columnTopY = 0;
        this._topOutUntil = 0;
        this._retries = 0;
    }

    /** @returns {boolean} */
    get active() {
        return this.phase !== 'idle';
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @returns {boolean} true while the climb owns this tick
     */
    tick(ctx) {
        const bot = ctx?.bot;
        const position = bot?.entity?.position;
        const ownerY = ctx?.ownerEntity?.position?.y;
        const now = this.now();

        if (!position || !Number.isFinite(ownerY)) return this._release(ctx, 'owner-lost');

        // Combat, hazard escape and death recovery all own movement outright.
        const control = currentControlOwner(ctx, 'follow');
        if (control !== 'follow' && control !== 'wait') {
            return this._release(ctx, `control-${control}`);
        }

        if (this.phase === 'topping') return this._tickTopOut(ctx, position, now);

        const column = findStandingClimbColumn(bot, position);

        if (this.phase === 'idle') {
            if (now < this._blockedUntil) return false;
            if (!column || ownerY - position.y < this.minOwnerDy) return false;
            this._begin(ctx, position, column, now);
            pressIntoWall(bot, this._push);
            return true;
        }

        if (now - this._startedAt >= this.timeoutMs) return this._release(ctx, 'timeout');

        // The exhausted column is checked before the owner's height: on top of a
        // cliff the owner stands one block above the last climbable cell, so
        // releasing on height here would drop the bot back down the wall.
        if (!column) {
            this.phase = 'topping';
            this._topOutUntil = now + this.topOutMs;
            pressIntoWall(bot, this._push);
            return true;
        }

        this._columnTopY = Math.max(this._columnTopY, column.cell.y);
        this._push = column.push;

        if (position.y > this._bestY + CLIMB_PROGRESS_EPSILON) {
            this._bestY = position.y;
            this._progressAt = now;
        } else if (now - this._progressAt >= this.stallMs) {
            return this._release(ctx, 'stalled');
        }

        // Covers both "level with the owner" and "the owner is back below".
        if (position.y >= ownerY) return this._release(ctx, 'reached-owner');

        pressIntoWall(bot, this._push);
        return true;
    }

    /**
     * Release the controls this climb pressed. Safe to call on any tick.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    release(ctx) {
        this._release(ctx, 'released');
    }

    /**
     * Ride the last of the climb momentum onto the top of the wall.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     * @param {number} now
     * @returns {boolean}
     */
    _tickTopOut(ctx, position, now) {
        const bot = ctx.bot;
        // Landing is the only proof the wall was cleared. Merely floating above
        // the last climbable cell also happens when the column breaks halfway
        // and the bot is left pinned against a wall it cannot climb.
        const landedOnTop = position.y >= this._columnTopY
            && bot?.entity?.onGround === true;

        if (landedOnTop) return this._release(ctx, 'topped-out');

        if (now < this._topOutUntil) {
            pressIntoWall(bot, this._push);
            return true;
        }

        const column = findStandingClimbColumn(bot, position);
        if (column && this._retries < this.maxTopOutRetries) {
            this._retries += 1;
            this._push = column.push;
            this._columnTopY = Math.max(this._columnTopY, column.cell.y);
            this._bestY = position.y;
            this._progressAt = now;
            this.phase = 'climbing';
            pressIntoWall(bot, this._push);
            return true;
        }

        return this._release(ctx, 'top-out-failed');
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     * @param {ClimbColumn} column
     * @param {number} now
     */
    _begin(ctx, position, column, now) {
        // Mandatory: while pathfinder still holds a path it rewrites every
        // control state on each physics tick and steals the forward push.
        ctx.movement?.stop?.();

        this.phase = 'climbing';
        this._push = column.push;
        this._startedAt = now;
        this._progressAt = now;
        this._bestY = position.y;
        this._columnTopY = column.cell.y;
        this._topOutUntil = 0;
        this._retries = 0;

        console.log(
            '[companion] column climb start',
            JSON.stringify({
                block: ctx.bot?.blockAt?.(column.cell)?.name ?? null,
                y: round2(position.y)
            })
        );
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext|null|undefined} ctx
     * @param {string} reason
     * @returns {false}
     */
    _release(ctx, reason) {
        if (this.phase === 'idle') return false;

        const bot = ctx?.bot;
        for (const control of CLIMB_CONTROLS) {
            bot?.setControlState?.(control, false);
        }

        console.log(
            '[companion] column climb end',
            JSON.stringify({ reason, y: round2(bot?.entity?.position?.y ?? 0) })
        );

        this.phase = 'idle';
        this._push = null;
        this._startedAt = 0;
        this._progressAt = 0;
        this._bestY = 0;
        this._columnTopY = 0;
        this._topOutUntil = 0;
        this._retries = 0;
        this._blockedUntil = CLIMB_FAILURE_REASONS.has(reason)
            ? this.now() + this.retryCooldownMs
            : 0;
        return false;
    }
}

/**
 * Face the supporting wall and hold forward. `force` applies the yaw on the
 * spot, so the very next physics tick already walks into the wall.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {HorizontalDirection|null} push
 */
function pressIntoWall(bot, push) {
    if (!bot || !push) return;

    try {
        const looking = bot.look?.(yawTowardDirection(push), 0, true);
        if (typeof looking?.catch === 'function') looking.catch(() => {});
    } catch {
        // look can fail while a chunk reloads; the next tick retries
    }
    // Sprinting off the lip overshoots the wall top and drops the bot back down.
    bot.setControlState?.('sprint', false);
    bot.setControlState?.('forward', true);
}

function round2(value) {
    return Math.round(value * 100) / 100;
}
