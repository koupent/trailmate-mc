import Vec3 from 'vec3';
import {
    analyzePassageRoute,
    isRoutePassage,
    normalizePassagePosition,
    passageCenter,
    passagePositionKey,
    passageSide
} from './passageRoute.js';

/** Max reach used when reading what the owner is looking at. */
const OWNER_LOOK_RANGE = 5;
/**
 * If the owner opens a door while looking past it (common when exiting),
 * still track when they are this close to the door.
 */
const OWNER_NEAR_DOOR_FOR_TRACK = 4;
/** After a swing, accept a matching closed-to-open update for this long. */
const SWING_MATCH_MS = 1500;
/** Drop a tracked door if the bot never finishes passing through. */
const TRACK_TTL_MS = 45000;
/** Record which side the bot approached from once this close. */
const APPROACH_DISTANCE = 2.25;
/** Require this clearance past the passage before closing it. */
const CLEAR_DISTANCE = 1.35;
/** Maximum sideways offset for a passage to lie between bot and owner. */
const PASSAGE_CORRIDOR_HALF_WIDTH = 1.1;
/** Allow the server time to publish the open state after our activation. */
const OPEN_CONFIRM_MS = 2500;
/** Allow the server time to publish the closed state after our activation. */
const CLOSE_CONFIRM_MS = 1200;
/** Back off briefly before retrying an unconfirmed open or close. */
const OPERATION_RETRY_MS = 600;
/** Give an active transaction a bounded window before normal behavior resumes. */
export const PASSAGE_TIMEOUT_MS = 15000;
/** Horizontal distance at which the passage can be activated. */
const PASSAGE_OPERATE_REACH = 3.5;
/** Keep activation on the same walkable level as the passage. */
const PASSAGE_VERTICAL_REACH = 2.5;
/** GoalNear tolerance used when walking to the route's pre-passage point. */
const APPROACH_GOAL_RANGE = 1;
/** GoalNear tolerance used when returning into activation range to close. */
const CLOSE_GOAL_RANGE = 2.5;
/** Stand this far from the passage when the route gives no usable point. */
const PASSAGE_STAND_DISTANCE = 2.5;
/** A route point only replaces the computed crossing target beyond this range. */
const CROSS_POINT_MIN_CLEARANCE = 1.65;
/** After a failure, leave the same passage alone for this long. */
export const PASSAGE_RETRY_COOLDOWN_MS = 5000;

/**
 * Ordered stages of one passage transaction. The FSM owns a transaction from
 * the moment it is requested until the block state confirms the final close.
 * @typedef {'approach'|'crossing'|'closing'} PassageStage
 */
export const PASSAGE_STAGE = /** @type {const} */ ({
    approach: 'approach',
    crossing: 'crossing',
    closing: 'closing'
});

/**
 * Wooden doors and fence gates the companion may operate.
 * Iron doors and trapdoors are excluded.
 * @param {{ name?: string }|null|undefined} block
 * @returns {boolean}
 */
export function isCloseablePassage(block) {
    return isRoutePassage(block);
}

/**
 * Always track the lower half of a two-block door.
 * @param {{ position: { x: number, y: number, z: number }, _properties?: { half?: string } }} block
 * @returns {{ x: number, y: number, z: number }}
 */
export function normalizeDoorPos(block) {
    return normalizePassagePosition(block);
}

/**
 * @param {{ x: number, y: number, z: number }} pos
 * @returns {string}
 */
export function posKey(pos) {
    return passagePositionKey(pos);
}

/**
 * Which side of the door the position is on, using facing when available.
 * @param {{ x: number, z: number }} pos
 * @param {{ x: number, z: number }} doorPos
 * @param {string|undefined} facing
 * @returns {-1|0|1}
 */
export function doorSide(pos, doorPos, facing) {
    return passageSide(pos, doorPos, facing);
}

/**
 * Whether the door truly separates bot from owner.
 * Owner standing on the threshold (a few cm past the door plane) must not
 * count; that was opening doors while both were still sheltering inside.
 * @param {{ x: number, z: number }} botPos
 * @param {{ x: number, z: number }} ownerPos
 * @param {{ x: number, z: number }} doorPos
 * @param {string|undefined} facing
 * @param {number} [clearDistance]
 * @returns {boolean}
 */
export function isDoorBetween(botPos, ownerPos, doorPos, facing, clearDistance = CLEAR_DISTANCE) {
    const botSide = doorSide(botPos, doorPos, facing);
    const ownerSide = doorSide(ownerPos, doorPos, facing);
    if (botSide === 0 || ownerSide === 0 || botSide === ownerSide) return false;

    const segmentX = ownerPos.x - botPos.x;
    const segmentZ = ownerPos.z - botPos.z;
    const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
    if (segmentLengthSq === 0) return false;

    const doorX = doorPos.x + 0.5;
    const doorZ = doorPos.z + 0.5;
    const projection = (
        (doorX - botPos.x) * segmentX
        + (doorZ - botPos.z) * segmentZ
    ) / segmentLengthSq;
    if (projection <= 0 || projection >= 1) return false;

    const closestX = botPos.x + segmentX * projection;
    const closestZ = botPos.z + segmentZ * projection;
    const lateralOffset = Math.hypot(doorX - closestX, doorZ - closestZ);
    if (lateralOffset > PASSAGE_CORRIDOR_HALF_WIDTH) return false;

    const ownerHoriz = Math.hypot(
        ownerPos.x - (doorPos.x + 0.5),
        ownerPos.z - (doorPos.z + 0.5)
    );
    // Owner must be clearly past the door, not perched on the sill.
    if (ownerHoriz < clearDistance) return false;
    return true;
}

/**
 * Whether the bot has approached and fully crossed to the other side.
 * @param {{
 *   approachSide: -1|0|1|null,
 *   facing?: string,
 *   doorPos: { x: number, y: number, z: number }
 * }} tracked
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{ approachDistance?: number, clearDistance?: number }} [opts]
 * @returns {{ approachSide: -1|0|1|null, readyToClose: boolean }}
 */
export function evaluatePassage(tracked, botPos, opts = {}) {
    const approachDistance = opts.approachDistance ?? APPROACH_DISTANCE;
    const clearDistance = opts.clearDistance ?? CLEAR_DISTANCE;
    const doorPos = tracked.doorPos;
    const horiz = Math.hypot(botPos.x - (doorPos.x + 0.5), botPos.z - (doorPos.z + 0.5));
    const side = doorSide(botPos, doorPos, tracked.facing);

    let approachSide = tracked.approachSide;
    if ((approachSide == null || approachSide === 0) && horiz <= approachDistance && side !== 0) {
        approachSide = side;
    }

    const readyToClose =
        approachSide != null &&
        approachSide !== 0 &&
        side !== 0 &&
        side !== approachSide &&
        horiz >= clearDistance;

    return { approachSide, readyToClose };
}

/**
 * True when a block update is a closed-to-open transition of a closeable passage.
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} oldBlock
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} newBlock
 */
export function isClosedToOpen(oldBlock, newBlock) {
    if (!isCloseablePassage(newBlock) || !isCloseablePassage(oldBlock)) return false;
    return oldBlock._properties?.open !== true && newBlock._properties?.open === true;
}

/**
 * Where the bot must stand to reach the passage from the approach side.
 * @param {PassageTransaction} transaction
 */
function passageApproachTarget(transaction) {
    if (transaction.approachPoint) return { ...transaction.approachPoint };
    return offsetFromPassage(transaction, transaction.approachSide, PASSAGE_STAND_DISTANCE);
}

/**
 * Where the bot must stand so the crossing is complete and closing is safe.
 * @param {PassageTransaction} transaction
 */
function passageCrossTarget(transaction) {
    const exit = transaction.exitPoint;
    if (exit) {
        const center = passageCenter(transaction.passagePos);
        const clearance = Math.hypot(exit.x - center.x, exit.z - center.z);
        if (clearance >= CROSS_POINT_MIN_CLEARANCE) return { ...exit };
    }
    const target = offsetFromPassage(
        transaction,
        transaction.exitSide,
        PASSAGE_STAND_DISTANCE
    );
    if (exit) target.y = exit.y;
    return target;
}

/**
 * @param {PassageTransaction} transaction
 * @param {-1|0|1|null} side
 * @param {number} distance
 */
function offsetFromPassage(transaction, side, distance) {
    const center = passageCenter(transaction.passagePos);
    const step = (side ?? 1) * distance;
    return transaction.facing === 'east' || transaction.facing === 'west'
        ? { x: center.x + step, y: center.y, z: center.z }
        : { x: center.x, y: center.y, z: center.z + step };
}

/**
 * @typedef {{
 *   key: string,
 *   passagePos: { x: number, y: number, z: number },
 *   facing?: string,
 *   approachSide: -1|0|1|null,
 *   exitSide: -1|1|null,
 *   approachPoint: { x: number, y: number, z: number }|null,
 *   exitPoint: { x: number, y: number, z: number }|null,
 *   stage: PassageStage,
 *   source: 'route'|'tracked',
 *   claimed: boolean,
 *   createdAt: number,
 *   activeSince: number|null,
 *   activeMs: number,
 *   openRequestedAt: number|null,
 *   closeRequestedAt: number|null,
 *   retryAt: number
 * }} PassageTransaction
 */

/**
 * @typedef {{
 *   action: 'move'|'open'|'close'|'hold'|'done'|'fail',
 *   target?: { x: number, y: number, z: number },
 *   range?: number,
 *   reason?: string
 * }} PassageStep
 */

/**
 * Detects passages, owns their transaction state, and confirms block state.
 *
 * It never operates a door on its own: opening and closing are executed by the
 * `passage_transit` FSM state through `openPassage()` / `closePassage()`, so no
 * door handling ever runs beside a normal behavior.
 */
export class DoorTracker {
    /**
     * @param {import('mineflayer').Bot} bot
     * @param {{
     *   getOwnerEntity?: () => import('prismarine-entity').Entity|null,
     *   now?: () => number
     * }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.getOwnerEntity = options.getOwnerEntity || (() => null);
        this.now = options.now || Date.now;

        /** @type {{ key: string, doorPos: {x:number,y:number,z:number}, facing?: string, at: number }[]} */
        this._pending = [];
        /** @type {{
         *   key: string,
         *   doorPos: {x:number,y:number,z:number},
         *   facing?: string,
         *   approachSide: -1|0|1|null,
         *   openedAt: number,
         *   openObserved: boolean
         * }[]} */
        this._tracked = [];
        /** @type {PassageTransaction|null} The single passage under FSM control. */
        this._transaction = null;
        /** @type {Map<string, number>} passage key -> time a new transaction may start */
        this._cooldown = new Map();
        /** True only while this tracker itself is activating a passage. */
        this._operating = false;
        this._lastOwnerSwingAt = 0;

        this._onSwing = (entity) => this._handleSwing(entity);
        this._onBlockUpdate = (oldBlock, newBlock) => this._handleBlockUpdate(oldBlock, newBlock);
        this._onPathUpdate = (result) => this._handlePathUpdate(result);
        this._onPathInvalidated = () => this._dropUnclaimedRoutePassage();
        this._originalActivateBlock = typeof bot.activateBlock === 'function'
            ? bot.activateBlock.bind(bot)
            : null;

        if (this._originalActivateBlock) {
            bot.activateBlock = (...args) => this._wrappedActivateBlock(...args);
        }

        bot.on('entitySwingArm', this._onSwing);
        bot.on('blockUpdate', this._onBlockUpdate);
        bot.on('path_update', this._onPathUpdate);
        bot.on('path_reset', this._onPathInvalidated);
        bot.on('goal_updated', this._onPathInvalidated);
    }

    dispose() {
        this.bot.off('entitySwingArm', this._onSwing);
        this.bot.off('blockUpdate', this._onBlockUpdate);
        this.bot.off('path_update', this._onPathUpdate);
        this.bot.off('path_reset', this._onPathInvalidated);
        this.bot.off('goal_updated', this._onPathInvalidated);
        if (this._originalActivateBlock) {
            this.bot.activateBlock = this._originalActivateBlock;
            this._originalActivateBlock = null;
        }
        this._pending = [];
        this._tracked = [];
        this._transaction = null;
    }

    /** @returns {number} */
    get trackedCount() {
        return this._tracked.length;
    }

    /** True while a passage transaction needs the FSM to own movement. */
    get passagePending() {
        return this._transaction != null;
    }

    /** Read-only view of the transaction for the FSM and diagnostics. */
    get passageTransaction() {
        const transaction = this._transaction;
        if (!transaction) return null;
        return {
            key: transaction.key,
            passagePos: { ...transaction.passagePos },
            facing: transaction.facing,
            stage: transaction.stage,
            source: transaction.source,
            claimed: transaction.claimed
        };
    }

    /**
     * Hand the transaction to the FSM. Stopping normal movement resets the
     * pathfinder, and an acquired transaction must survive that reset.
     */
    claimPassage() {
        if (!this._transaction) return false;
        this._transaction.claimed = true;
        return true;
    }

    /** Start (or resume) the bounded transaction window. */
    resumePassage() {
        const transaction = this._transaction;
        if (transaction && transaction.activeSince == null) {
            transaction.activeSince = this.now();
        }
    }

    /** Safety/combat may suspend a transaction without consuming its timeout. */
    suspendPassage() {
        const transaction = this._transaction;
        if (!transaction || transaction.activeSince == null) return;
        transaction.activeMs += Math.max(0, this.now() - transaction.activeSince);
        transaction.activeSince = null;
    }

    /**
     * End the transaction with a recorded reason and hold off on the same
     * passage briefly so a failing route cannot livelock the FSM.
     * @param {string} reason
     */
    failPassage(reason) {
        const transaction = this._transaction;
        if (!transaction) return false;
        console.warn(`[companion] passage transit failed (${reason}) at ${transaction.key}`);
        this._cooldown.set(transaction.key, this.now() + PASSAGE_RETRY_COOLDOWN_MS);
        this._transaction = null;
        return true;
    }

    /** End the transaction after its final block state was confirmed. */
    finishPassage() {
        if (!this._transaction) return false;
        this._transaction = null;
        return true;
    }

    /**
     * True when an open door or gate separates the bot from the owner.
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {{ x: number, y: number, z: number }} ownerPos
     */
    findSeparatingPassage(botPos, ownerPos) {
        if (!botPos || !ownerPos) return false;

        for (const entry of this._tracked) {
            if (isDoorBetween(botPos, ownerPos, entry.doorPos, entry.facing)) {
                return true;
            }
        }

        const baseX = Math.floor((botPos.x + ownerPos.x) / 2);
        const baseY = Math.floor(botPos.y + 0.001);
        const baseZ = Math.floor((botPos.z + ownerPos.z) / 2);

        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                const block = this._blockAt({ x: baseX + dx, y: baseY, z: baseZ + dz });
                if (!isCloseablePassage(block) || block._properties?.open !== true) continue;
                const lower = block._properties?.half === 'upper'
                    ? this._blockAt({ x: block.position.x, y: block.position.y - 1, z: block.position.z })
                    : block;
                if (!lower?.position) continue;
                if (isDoorBetween(botPos, ownerPos, lower.position, lower._properties?.facing)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Observation only: expire stale entries and request a closing transaction
     * once the bot has crossed a passage somebody else opened.
     */
    async tick() {
        const now = this.now();
        this._pending = this._pending.filter((p) => now - p.at <= SWING_MATCH_MS);
        this._tracked = this._tracked.filter((t) => now - t.openedAt <= TRACK_TTL_MS);
        for (const [key, until] of this._cooldown) {
            if (until <= now) this._cooldown.delete(key);
        }

        const botPos = this.bot.entity?.position;
        if (!botPos) return;

        for (const tracked of [...this._tracked]) {
            const block = this._blockAt(tracked.doorPos);
            if (!block || !isCloseablePassage(block)) {
                this._forget(tracked.key);
                continue;
            }

            if (block._properties?.open !== true) {
                if (tracked.openObserved || now - tracked.openedAt > OPEN_CONFIRM_MS) {
                    this._forget(tracked.key);
                }
                continue;
            }

            tracked.openObserved = true;
            if (this._transaction) continue;

            const crossed = evaluatePassage(tracked, botPos);
            tracked.approachSide = crossed.approachSide;
            if (!crossed.readyToClose) continue;
            if (this._onCooldown(tracked.key, now)) continue;

            // An owner-opened passage the bot already crossed starts at the
            // closing stage of the very same transaction.
            this._transaction = createTransaction({
                key: tracked.key,
                passagePos: tracked.doorPos,
                facing: tracked.facing,
                approachSide: tracked.approachSide,
                exitSide: null,
                approachPoint: null,
                exitPoint: null,
                stage: PASSAGE_STAGE.closing,
                source: 'tracked',
                now
            });
            return;
        }
    }

    /**
     * Advance the transaction and report the single next action the
     * `passage_transit` state has to perform.
     * @param {number} [now]
     * @returns {PassageStep}
     */
    advancePassage(now = this.now()) {
        const transaction = this._transaction;
        if (!transaction) return { action: 'done' };

        const activeMs = transaction.activeMs + (
            transaction.activeSince == null
                ? 0
                : Math.max(0, now - transaction.activeSince)
        );
        if (activeMs > PASSAGE_TIMEOUT_MS) return { action: 'fail', reason: 'timeout' };

        const block = this._blockAt(transaction.passagePos);
        if (!block || !isCloseablePassage(block)) return { action: 'done' };

        const botPos = this.bot.entity?.position;
        if (!botPos) return { action: 'hold' };

        const open = block._properties?.open === true;
        const center = passageCenter(transaction.passagePos);
        const inReach = Math.hypot(botPos.x - center.x, botPos.z - center.z) <= PASSAGE_OPERATE_REACH
            && Math.abs(botPos.y - center.y) <= PASSAGE_VERTICAL_REACH;
        const side = doorSide(botPos, transaction.passagePos, transaction.facing);

        if (transaction.stage === PASSAGE_STAGE.approach) {
            const step = this._advanceApproach(transaction, { now, open, inReach, side });
            if (step) return step;
        }

        if (transaction.stage === PASSAGE_STAGE.crossing) {
            const step = this._advanceCrossing(transaction, { open, side, botPos });
            if (step) return step;
        }

        if (transaction.stage === PASSAGE_STAGE.closing) {
            return this._advanceClosing(transaction, { now, open, inReach, center });
        }

        return { action: 'hold' };
    }

    /**
     * @param {PassageTransaction} transaction
     * @returns {PassageStep|null} null once the stage advanced
     */
    _advanceApproach(transaction, { now, open, inReach, side }) {
        if (open) {
            // Confirmed open: the same transaction now owns the crossing.
            transaction.stage = PASSAGE_STAGE.crossing;
            transaction.openRequestedAt = null;
            transaction.retryAt = 0;
            this._startTracking(
                transaction.passagePos,
                transaction.facing,
                now,
                { openObserved: true }
            );
            return null;
        }

        if (transaction.openRequestedAt != null) {
            // Stay in reach until the world reflects the open, then retry.
            if (now - transaction.openRequestedAt <= OPEN_CONFIRM_MS) return { action: 'hold' };
            transaction.openRequestedAt = null;
            transaction.retryAt = now + OPERATION_RETRY_MS;
            return { action: 'hold' };
        }

        // A stale route can leave the bot already past a closed passage.
        if (transaction.exitSide != null && side !== 0 && side === transaction.exitSide) {
            return { action: 'done' };
        }
        if (!inReach) {
            return {
                action: 'move',
                target: passageApproachTarget(transaction),
                range: APPROACH_GOAL_RANGE
            };
        }
        if (now < transaction.retryAt) return { action: 'hold' };
        return { action: 'open' };
    }

    /**
     * @param {PassageTransaction} transaction
     * @returns {PassageStep|null} null once the stage advanced
     */
    _advanceCrossing(transaction, { open, side, botPos }) {
        if (!open) {
            if (transaction.exitSide != null && side === transaction.exitSide) {
                return { action: 'done' };
            }
            // Closed again before the crossing: reopen from the same transaction.
            transaction.stage = PASSAGE_STAGE.approach;
            transaction.openRequestedAt = null;
            return { action: 'hold' };
        }

        const crossed = evaluatePassage(
            {
                approachSide: transaction.approachSide,
                facing: transaction.facing,
                doorPos: transaction.passagePos
            },
            botPos
        );
        transaction.approachSide = crossed.approachSide;
        if (!crossed.readyToClose) {
            return {
                action: 'move',
                target: passageCrossTarget(transaction),
                range: APPROACH_GOAL_RANGE
            };
        }
        transaction.stage = PASSAGE_STAGE.closing;
        return null;
    }

    /**
     * @param {PassageTransaction} transaction
     * @returns {PassageStep}
     */
    _advanceClosing(transaction, { now, open, inReach, center }) {
        if (!open) return { action: 'done' };

        if (transaction.closeRequestedAt != null) {
            if (now - transaction.closeRequestedAt <= CLOSE_CONFIRM_MS) return { action: 'hold' };
            transaction.closeRequestedAt = null;
            transaction.retryAt = now + OPERATION_RETRY_MS;
            return { action: 'hold' };
        }
        if (!inReach) {
            return { action: 'move', target: center, range: CLOSE_GOAL_RANGE };
        }
        if (now < transaction.retryAt) return { action: 'hold' };
        return { action: 'close' };
    }

    /**
     * Open the transaction's passage. Only `passage_transit` calls this.
     * @returns {Promise<boolean>}
     */
    async openPassage() {
        const transaction = this._transaction;
        if (!transaction) return false;
        const block = this._blockAt(transaction.passagePos);
        if (!block || !isCloseablePassage(block) || block._properties?.open === true) {
            return false;
        }

        transaction.openRequestedAt = this.now();
        const activated = await this._activatePassage(block, 'open');
        if (!activated) {
            transaction.openRequestedAt = null;
            transaction.retryAt = this.now() + OPERATION_RETRY_MS;
        }
        return activated;
    }

    /**
     * Close the transaction's passage. Only `passage_transit` calls this.
     * @returns {Promise<boolean>}
     */
    async closePassage() {
        const transaction = this._transaction;
        if (!transaction) return false;
        const block = this._blockAt(transaction.passagePos);
        if (!block || !isCloseablePassage(block) || block._properties?.open !== true) {
            return false;
        }

        transaction.closeRequestedAt = this.now();
        const activated = await this._activatePassage(block, 'close');
        if (!activated) {
            transaction.closeRequestedAt = null;
            transaction.retryAt = this.now() + OPERATION_RETRY_MS;
        }
        return activated;
    }

    /**
     * @param {import('prismarine-block').Block} block
     * @param {'open'|'close'} kind
     */
    async _activatePassage(block, kind) {
        this._operating = true;
        try {
            await this.bot.activateBlock(block);
            return true;
        } catch (err) {
            console.warn(`[companion] passage ${kind} failed:`, err?.message || err);
            return false;
        } finally {
            this._operating = false;
        }
    }

    /**
     * Request a transaction for the first passage a complete route crosses.
     * @param {{ status?: string, path?: Array<{
     *   x?:number,y?:number,z?:number,
     *   toPlace?: Array<{ x:number,y:number,z:number,useOne?:boolean }>
     * }> }} result
     */
    _handlePathUpdate(result) {
        if (result?.status !== 'success' || !Array.isArray(result.path)) return;

        const endpoint = result.path.at(-1);
        if (!Number.isFinite(endpoint?.x) || !Number.isFinite(endpoint?.y)
            || !Number.isFinite(endpoint?.z)) {
            return;
        }

        const analysis = analyzePassageRoute(this.bot, result.path);
        if (!analysis.valid) return;

        this._removePathfinderPassageActions(result.path);
        this._requestRoutePassage(analysis.passages);
    }

    /**
     * Only a candidate the FSM has not acquired yet may be discarded when a
     * route is invalidated. An acquired transaction outlives `path_reset` and
     * `goal_updated`, including the reset caused by stopping normal movement.
     */
    _dropUnclaimedRoutePassage() {
        const transaction = this._transaction;
        if (!transaction || transaction.claimed) return;
        if (transaction.source !== 'route') return;
        this._transaction = null;
    }

    /**
     * @param {Map<string, import('./passageRoute.js').RoutePassagePlan>} passages
     */
    _requestRoutePassage(passages) {
        if (this._transaction) return;
        // One route contributes one transaction; a later passage is handled
        // after normal work recomputes its route.
        const passage = passages.values().next().value;
        if (!passage) return;

        const now = this.now();
        if (this._onCooldown(passage.key, now)) return;

        const block = this._blockAt(passage.passagePos);
        if (!isCloseablePassage(block) || block._properties?.open === true) return;

        this._transaction = createTransaction({
            key: passage.key,
            passagePos: passage.passagePos,
            facing: passage.facing,
            approachSide: passage.approachSide,
            exitSide: passage.exitSide,
            approachPoint: passage.approachPoint,
            exitPoint: passage.exitPoint,
            stage: PASSAGE_STAGE.approach,
            source: 'route',
            now
        });
    }

    /**
     * @param {string} key
     * @param {number} now
     */
    _onCooldown(key, now) {
        return (this._cooldown.get(key) ?? 0) > now;
    }

    /**
     * Passages are operated by `passage_transit` alone. Silently succeeding on
     * an unowned activation hid a stalled route, so refuse it instead.
     * @param {import('prismarine-block').Block} block
     * @param {...any} args
     */
    _wrappedActivateBlock(block, ...args) {
        if (!isCloseablePassage(block)) {
            return this._originalActivateBlock(block, ...args);
        }
        if (!this._operating) {
            return Promise.reject(new Error(
                `passage activation is owned by passage_transit: ${posKey(normalizeDoorPos(block))}`
            ));
        }
        return Promise.resolve(this._originalActivateBlock(block, ...args));
    }

    /**
     * mineflayer-pathfinder opens doors itself through `useOne` actions, which
     * is exactly the parallel door control the passage transaction replaces.
     * Remove those actions before pathfinder adopts the emitted path.
     * @param {Array<any>} path
     */
    _removePathfinderPassageActions(path) {
        for (const node of path) {
            if (!Array.isArray(node?.toPlace)) continue;
            node.toPlace = node.toPlace.filter((action) => {
                if (action?.useOne !== true) return true;
                return !isCloseablePassage(this._blockAt(action));
            });
        }
    }

    /**
     * @param {import('prismarine-entity').Entity} entity
     */
    _handleSwing(entity) {
        const owner = this.getOwnerEntity();
        if (!owner || !entity || entity.id !== owner.id) return;
        const now = this.now();
        this._lastOwnerSwingAt = now;

        let target = null;
        try {
            target = this.bot.blockAtEntityCursor(owner, OWNER_LOOK_RANGE);
        } catch {
            return;
        }
        if (!target || !isCloseablePassage(target)) return;
        if (target._properties?.open === true) return;

        const doorPos = normalizeDoorPos(target);
        const key = posKey(doorPos);
        this._pending = this._pending.filter((p) => p.key !== key);
        this._pending.push({
            key,
            doorPos,
            facing: target._properties?.facing,
            at: now
        });
    }

    /**
     * @param {import('prismarine-block').Block|null} oldBlock
     * @param {import('prismarine-block').Block|null} newBlock
     */
    _handleBlockUpdate(oldBlock, newBlock) {
        if (!isClosedToOpen(oldBlock, newBlock)) return;

        const doorPos = normalizeDoorPos(newBlock);
        const key = posKey(doorPos);
        const now = this.now();
        const pending = this._pending.find((p) => p.key === key && now - p.at <= SWING_MATCH_MS);
        if (pending) {
            this._pending = this._pending.filter((p) => p.key !== key);
            this._startTracking(
                doorPos,
                newBlock._properties?.facing ?? pending.facing,
                now,
                { openObserved: true }
            );
            return;
        }

        // Owner often looks outward while opening; swing never targets the door.
        // Still track when the owner is standing at the passage.
        const owner = this.getOwnerEntity();
        if (!owner?.position) return;
        const ownerHoriz = Math.hypot(
            owner.position.x - (doorPos.x + 0.5),
            owner.position.z - (doorPos.z + 0.5)
        );
        const ownerAtPassage = ownerHoriz <= APPROACH_DISTANCE;
        const recentOwnerSwing = now - this._lastOwnerSwingAt <= SWING_MATCH_MS;
        if (!ownerAtPassage && (!recentOwnerSwing || ownerHoriz > OWNER_NEAR_DOOR_FOR_TRACK)) return;

        this._startTracking(doorPos, newBlock._properties?.facing, now, { openObserved: true });
    }

    /**
     * @param {{ x: number, y: number, z: number }} doorPos
     * @param {string|undefined} facing
     * @param {number} [openedAt]
     * @param {{ openObserved?: boolean }} [options]
     */
    _startTracking(doorPos, facing, openedAt = this.now(), options = {}) {
        const key = posKey(doorPos);
        const existing = this._tracked.find((t) => t.key === key);
        if (existing) {
            if (!existing.facing && facing) {
                existing.facing = facing;
                const botPos = this.bot.entity?.position;
                existing.approachSide = botPos ? doorSide(botPos, doorPos, facing) || null : null;
            }
            if (options.openObserved) existing.openObserved = true;
            return;
        }

        const botPos = this.bot.entity?.position;
        const approachSide = botPos ? doorSide(botPos, doorPos, facing) : null;
        this._tracked.push({
            key,
            doorPos: { ...doorPos },
            facing,
            approachSide: approachSide || null,
            openedAt,
            openObserved: options.openObserved === true
        });
    }

    /**
     * @param {{ x: number, y: number, z: number }} doorPos
     * @returns {import('prismarine-block').Block|null}
     */
    _blockAt(doorPos) {
        return this.bot.blockAt(new Vec3(
            Math.floor(doorPos.x),
            Math.floor(doorPos.y),
            Math.floor(doorPos.z)
        ));
    }

    /** @param {string} key */
    _forget(key) {
        this._tracked = this._tracked.filter((t) => t.key !== key);
        this._pending = this._pending.filter((p) => p.key !== key);
    }
}

/**
 * @param {{
 *   key: string,
 *   passagePos: { x: number, y: number, z: number },
 *   facing?: string,
 *   approachSide: -1|0|1|null,
 *   exitSide: -1|1|null,
 *   approachPoint: { x: number, y: number, z: number }|null,
 *   exitPoint: { x: number, y: number, z: number }|null,
 *   stage: PassageStage,
 *   source: 'route'|'tracked',
 *   now: number
 * }} init
 * @returns {PassageTransaction}
 */
function createTransaction(init) {
    return {
        key: init.key,
        passagePos: { ...init.passagePos },
        facing: init.facing,
        approachSide: init.approachSide ?? null,
        exitSide: init.exitSide ?? null,
        approachPoint: init.approachPoint ? { ...init.approachPoint } : null,
        exitPoint: init.exitPoint ? { ...init.exitPoint } : null,
        stage: init.stage,
        source: init.source,
        claimed: false,
        createdAt: init.now,
        activeSince: null,
        activeMs: 0,
        openRequestedAt: null,
        closeRequestedAt: null,
        retryAt: 0
    };
}
