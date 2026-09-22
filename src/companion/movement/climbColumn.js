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
/** How far around the bot the approach looks for a column to walk into. */
export const CLIMB_APPROACH_RADIUS = 3;
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
/** Horizontal gain toward the column that counts as approach progress. */
const CLIMB_APPROACH_PROGRESS_EPSILON = 0.15;

/**
 * Exits that mean the wall itself is the problem. They hold the next attempt
 * off for a cooldown, so a vine that breaks halfway cannot pin the companion in
 * a loop of doomed climbs instead of letting it follow. The approach exits are
 * in here for the same reason: a column A* refuses to route into must hand the
 * tick back to ordinary follow for a while instead of being asked again at 4Hz.
 */
const CLIMB_FAILURE_REASONS = new Set([
    'stalled',
    'timeout',
    'top-out-failed',
    'approach-blocked',
    'approach-stalled',
    'approach-timeout'
]);

/** Probe order for the supporting wall. Fixed so the choice is reproducible. */
const HORIZONTAL_NEIGHBORS = [
    { x: 0, z: -1 },
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    { x: -1, z: 0 }
];

/**
 * Every horizontal offset within the approach radius, nearest first. Built once
 * and never mutated, so the column picked for a given world is reproducible.
 * The bot's own cell is left out: the caller has already asked
 * `findStandingClimbColumn` about it.
 */
const APPROACH_OFFSETS = buildApproachOffsets(CLIMB_APPROACH_RADIUS);

/**
 * @param {number} radius
 * @returns {HorizontalDirection[]}
 */
function buildApproachOffsets(radius) {
    const offsets = [];
    for (let x = -radius; x <= radius; x += 1) {
        for (let z = -radius; z <= radius; z += 1) {
            if (x !== 0 || z !== 0) offsets.push({ x, z });
        }
    }
    return offsets.sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
}

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
 * The nearest climbable column the bot could walk into from where it stands.
 *
 * Only the bot's own feet level is scanned, because entering a column means
 * walking into it horizontally: a cell higher or lower is a different problem
 * that ordinary pathfinding owns.
 *
 * The search is around the BOT, never around the owner. Once the owner has
 * topped the wall its x,z column is the wall itself, and the vines stand at a
 * different x,z entirely — while the companion, having failed to route onto the
 * wall, is parked next to the foot of that very column.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} [position]
 * @returns {ClimbColumn|null}
 */
export function findNearbyClimbColumn(bot, position = bot?.entity?.position) {
    if (!position || typeof bot?.blockAt !== 'function') return null;

    const x = Math.floor(position.x);
    const y = Math.floor(position.y + 0.001);
    const z = Math.floor(position.z);

    for (const offset of APPROACH_OFFSETS) {
        const cell = new Vec3(x + offset.x, y, z + offset.z);
        if (!isClimbableColumnBlock(bot.blockAt(cell))) continue;
        // A single climbable block is decoration, not a wall. The climb only
        // ever runs with the owner CLIMB_MIN_OWNER_DY above, which one cell can
        // never deliver, so walking over there would just burn the cooldown.
        if (!isClimbableColumnBlock(bot.blockAt(cell.offset(0, 1, 0)))) continue;

        const push = findClimbPushDirection(bot, cell);
        if (push) return { cell, push };
    }

    return null;
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
 * Hand-rolled vine climb, in two phases: walk into the column, then go up it.
 *
 * mineflayer-pathfinder emits no upward move over vines because they are absent
 * from `climbables`, and putting them back does not help: `postProcessPath`
 * collapses a vine node onto the cell below it, so every upward move A* planned
 * is erased before it runs. Ladders are in `climbables` and are climbed by the
 * pathfinder on its own; this controller merely also handles them.
 *
 * The approach phase exists because the follow route does NOT end at the foot of
 * the wall. `GoalNear` with the follow range counts seven cells as arrived, of
 * which the column is one, so a companion walking in from open ground stops
 * beside the column rather than inside it; and once the owner is on top of the
 * wall, the follow target is the owner's own unreachable cell up there. Either
 * way nothing ever puts the feet in the column, which is the single condition
 * the climb needs. So the climb walks itself in, with `GoalNear` range 0.
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

        /** @type {'idle' | 'approaching' | 'climbing' | 'topping'} */
        this.phase = 'idle';
        /** @type {HorizontalDirection|null} */
        this._push = null;
        /** @type {Vec3|null} */
        this._approachCell = null;
        this._bestDistance = 0;
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
        const belowOwner = ownerY - position.y >= this.minOwnerDy;

        // Unlike the climb below, height is read before the column here: a bot
        // still on the ground has nothing to lose by giving the walk up the
        // moment the owner is no longer worth climbing to.
        if (this.phase === 'approaching') {
            if (!belowOwner) return this._release(ctx, 'owner-level');
            if (column) return this._begin(ctx, position, column, now);
            return this._tickApproach(ctx, position, now);
        }

        if (this.phase === 'idle') {
            if (now < this._blockedUntil || !belowOwner) return false;
            if (column) return this._begin(ctx, position, column, now);
            return this._beginApproach(ctx, position, now);
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
     * Send the bot into a nearby column, since nothing else ever will.
     *
     * No control state is touched here. The walk belongs to the pathfinder;
     * `forward` is only ever held once the feet are actually in the column.
     *
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     * @param {number} now
     * @returns {boolean}
     */
    _beginApproach(ctx, position, now) {
        if (typeof ctx?.movement?.goToward !== 'function') return false;

        const target = findNearbyClimbColumn(ctx.bot, position);
        if (!target) return false;

        this.phase = 'approaching';
        this._approachCell = target.cell;
        this._startedAt = now;
        this._progressAt = now;
        this._bestDistance = horizontalDistanceToCell(position, target.cell);

        console.log(
            '[companion] column approach start',
            JSON.stringify({
                block: ctx.bot?.blockAt?.(target.cell)?.name ?? null,
                cell: `${target.cell.x},${target.cell.y},${target.cell.z}`
            })
        );

        // Ask for the route before any status is read: the follow route this
        // replaces has usually just failed on the owner's cell on top of the
        // wall, and that stale `unreachable` would abort the approach at once.
        this._requestApproach(ctx);
        return true;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     * @param {number} now
     * @returns {boolean}
     */
    _tickApproach(ctx, position, now) {
        if (now - this._startedAt >= this.timeoutMs) {
            return this._release(ctx, 'approach-timeout');
        }

        const movement = ctx.movement;
        if (movement?.isBlocked || movement?.isUnreachable) {
            return this._release(ctx, 'approach-blocked');
        }

        const distance = horizontalDistanceToCell(position, this._approachCell);
        if (distance <= this._bestDistance - CLIMB_APPROACH_PROGRESS_EPSILON) {
            this._bestDistance = distance;
            this._progressAt = now;
        } else if (now - this._progressAt >= this.stallMs) {
            return this._release(ctx, 'approach-stalled');
        }

        this._requestApproach(ctx);
        return true;
    }

    /**
     * Re-assert the goal that puts the feet inside the column.
     *
     * Range 0 leaves `GoalNear.rangeSq` at 0, so `isEnd` demands the exact cell.
     * Any wider range is what broke this in the first place: at range 1 the four
     * horizontal neighbours also count as arrived, and A* stops at whichever it
     * touches first — never the column itself.
     *
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    _requestApproach(ctx) {
        const cell = this._approachCell;
        if (!cell) return;
        ctx.movement.goToward(new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5), 0);
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {{ x: number, y: number, z: number }} position
     * @param {ClimbColumn} column
     * @param {number} now
     * @returns {true}
     */
    _begin(ctx, position, column, now) {
        // Mandatory: while pathfinder still holds a path it rewrites every
        // control state on each physics tick and steals the forward push.
        ctx.movement?.stop?.();

        this.phase = 'climbing';
        this._push = column.push;
        this._approachCell = null;
        this._bestDistance = 0;
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

        pressIntoWall(ctx.bot, this._push);
        return true;
    }

    /**
     * Drop everything this controller was holding and hand the tick back.
     *
     * Controls are always released; an approach route is not, on purpose.
     * Whatever takes the tick next — ordinary follow, combat, recovery — asks
     * for its own goal before the bot could walk one more tick toward a column
     * nobody wants any more.
     *
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
            JSON.stringify({
                phase: this.phase,
                reason,
                y: round2(bot?.entity?.position?.y ?? 0)
            })
        );

        this.phase = 'idle';
        this._push = null;
        this._approachCell = null;
        this._bestDistance = 0;
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

/**
 * Distance from the body to the centre of a block cell, ignoring Y. The
 * approach is a walk, so a bob over a step must not read as progress.
 *
 * @param {{ x: number, z: number }} position
 * @param {{ x: number, z: number }|null} cell
 * @returns {number}
 */
function horizontalDistanceToCell(position, cell) {
    if (!cell) return 0;
    return Math.hypot(position.x - (cell.x + 0.5), position.z - (cell.z + 0.5));
}

function round2(value) {
    return Math.round(value * 100) / 100;
}
