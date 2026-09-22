import Vec3 from 'vec3';
import {
    analyzePassageRoute,
    APPROACH_DISTANCE,
    CLEAR_DISTANCE,
    CORRIDOR_HALF_WIDTH,
    isRoutePassage,
    normalizePassagePosition,
    passageCenter,
    passagePositionKey,
    passageSide,
    passageStandPoint,
    routeEntersPassage
} from './passageRoute.js';
import { OwnerDoorWatch } from './ownerDoors.js';

/**
 * Every door and gate the companion meets is described by two facts:
 *
 *   needed — the route the bot is walking still goes through it
 *   owed   — the bot opened it, and it is still open
 *
 * which give two rules:
 *
 *   needed and closed          -> open it
 *   owed and no longer needed  -> close it
 *
 * Nothing here drives the crossing. Once a passage is open, the bot walks
 * through it with ordinary movement, and "the route no longer goes through it"
 * is what having finished the crossing looks like from in here.
 *
 * A door the owner opened is the one passage no route can describe, so
 * `ownerDoors.js` keeps the separate rule it needs and hands back a debt once
 * the bot has actually crossed one.
 */

/** Horizontal distance at which a passage can be activated. */
const OPERATE_REACH = 3.5;
/** Keep activation on the same walkable level as the passage. */
const VERTICAL_REACH = 2.5;
/** GoalNear tolerance used when walking to a job's approach point. */
const APPROACH_GOAL_RANGE = 1;
/** Allow the server this long to publish the state an activation asked for. */
const CONFIRM_MS = 1200;
/** Give up on a passage after this many unconfirmed activations. */
const MAX_ATTEMPTS = 3;
/** Stop owing a close on a passage the bot never got back to. */
const DEBT_TTL_MS = 45000;
/** Past this, walking back to close is not worth interrupting normal work. */
export const CLOSE_MAX_DISTANCE = 10;
/** A job may own movement for this long before normal behavior resumes. */
export const PASSAGE_JOB_TIMEOUT_MS = 8000;
/** After a failure, leave the same passage alone for this long. */
export const PASSAGE_FAIL_COOLDOWN_MS = 2000;
/** After a success, long enough that its own block update cannot restart it. */
export const PASSAGE_DONE_COOLDOWN_MS = 400;

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
    if (Math.hypot(doorX - closestX, doorZ - closestZ) > CORRIDOR_HALF_WIDTH) return false;

    const ownerHoriz = Math.hypot(
        ownerPos.x - (doorPos.x + 0.5),
        ownerPos.z - (doorPos.z + 0.5)
    );
    // Owner must be clearly past the door, not perched on the sill.
    return ownerHoriz >= clearDistance;
}

/**
 * @typedef {{
 *   key: string,
 *   passagePos: { x: number, y: number, z: number },
 *   facing?: string,
 *   approachPoint: { x: number, y: number, z: number }|null,
 *   open: boolean,
 *   needed: boolean,
 *   owed: boolean,
 *   distance: number,
 *   inReach: boolean,
 *   cooldown: boolean
 * }} PassageCandidate
 */

/** @typedef {'crossed'|'needed'|'left-open'} PassageJobReason */

/**
 * The one place the companion decides what to do about a passage.
 *
 * The order is what keeps the bot from ever turning back. `crossed` is a close
 * the bot can perform from where it already stands, so it costs no movement and
 * leads nowhere; taking it first is what makes "walk through, close behind you"
 * fall out. `needed` moves the bot forward. `left-open` is the only rule that
 * walks backwards, so it comes last: a debt is never paid while the bot still
 * has a gate in front of it to open.
 *
 * @param {PassageCandidate[]} candidates
 * @returns {{ key: string, intent: 'open'|'close', reason: PassageJobReason }|null}
 */
export function selectPassageJob(candidates) {
    /** @type {Record<PassageJobReason, PassageCandidate|null>} */
    const best = { crossed: null, needed: null, 'left-open': null };

    for (const candidate of candidates || []) {
        if (!candidate || candidate.cooldown) continue;
        const reason = classifyPassage(candidate);
        if (!reason) continue;
        if (!best[reason] || candidate.distance < best[reason].distance) {
            best[reason] = candidate;
        }
    }

    for (const reason of /** @type {PassageJobReason[]} */ (['crossed', 'needed', 'left-open'])) {
        const pick = best[reason];
        if (!pick) continue;
        return { key: pick.key, intent: reason === 'needed' ? 'open' : 'close', reason };
    }
    return null;
}

/**
 * @param {PassageCandidate} candidate
 * @returns {PassageJobReason|null}
 */
function classifyPassage(candidate) {
    // A passage the route still goes through is never closed, whoever opened
    // it. This alone is what stops the bot shutting a gate in its own face.
    if (candidate.needed) return candidate.open ? null : 'needed';
    if (!candidate.owed || !candidate.open) return null;
    // Standing in the doorway, or too far for the walk back to be worth it.
    if (candidate.distance < CLEAR_DISTANCE) return null;
    if (candidate.distance > CLOSE_MAX_DISTANCE) return null;
    return candidate.inReach ? 'crossed' : 'left-open';
}

/**
 * @typedef {{
 *   key: string,
 *   intent: 'open'|'close',
 *   reason: PassageJobReason,
 *   passagePos: { x: number, y: number, z: number },
 *   facing?: string,
 *   approachPoint: { x: number, y: number, z: number }|null,
 *   requestedAt: number|null,
 *   attempts: number,
 *   activeSince: number|null,
 *   activeMs: number
 * }} PassageJob
 */

/**
 * @typedef {{
 *   action: 'move'|'activate'|'hold'|'done'|'fail',
 *   target?: { x: number, y: number, z: number },
 *   range?: number,
 *   reason?: string
 * }} PassageStep
 */

/**
 * Detects passages, selects the single job the FSM runs, and confirms block state.
 *
 * It never operates a door on its own: the `passage_transit` FSM state performs
 * every activation through `activatePassage()`, so no door handling ever runs
 * beside a normal behavior.
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
        this.now = options.now || Date.now;
        this.ownerDoors = new OwnerDoorWatch(bot, options);

        /**
         * Passages the bot owes a close on.
         * @type {Map<string, {
         *   key: string,
         *   passagePos: {x:number,y:number,z:number},
         *   facing?: string,
         *   openedAt: number,
         *   openObserved: boolean,
         *   awaitingRoute: boolean,
         *   via: 'bot'|'owner'
         * }>}
         */
        this._owed = new Map();
        /**
         * The live remaining path. mineflayer-pathfinder shifts nodes off this
         * very array as the bot walks it, so holding the reference keeps saying
         * what is still ahead without anything here tracking progress.
         * @type {Array<any>}
         */
        this._route = [];
        /** @type {Map<string, import('./passageRoute.js').RoutePassagePlan>} */
        this._routePlans = new Map();
        /** @type {PassageJob|null} The single job under FSM control. */
        this._job = null;
        /** @type {Map<string, number>} passage key -> time a new job may start */
        this._cooldown = new Map();
        /** True only while this tracker itself is activating a passage. */
        this._operating = false;

        this._onSwing = (entity) => this.ownerDoors.handleSwing(entity);
        this._onBlockUpdate = (oldBlock, newBlock) => this._handleBlockUpdate(oldBlock, newBlock);
        this._onPathUpdate = (result) => this._handlePathUpdate(result);
        this._originalActivateBlock = typeof bot.activateBlock === 'function'
            ? bot.activateBlock.bind(bot)
            : null;

        if (this._originalActivateBlock) {
            bot.activateBlock = (...args) => this._wrappedActivateBlock(...args);
        }

        bot.on('entitySwingArm', this._onSwing);
        bot.on('blockUpdate', this._onBlockUpdate);
        bot.on('path_update', this._onPathUpdate);
    }

    dispose() {
        this.bot.off('entitySwingArm', this._onSwing);
        this.bot.off('blockUpdate', this._onBlockUpdate);
        this.bot.off('path_update', this._onPathUpdate);
        if (this._originalActivateBlock) {
            this.bot.activateBlock = this._originalActivateBlock;
            this._originalActivateBlock = null;
        }
        this.ownerDoors.clear();
        this._owed.clear();
        this._routePlans.clear();
        this._route = [];
        this._job = null;
    }

    /** @returns {number} */
    get trackedCount() {
        return this._owed.size + this.ownerDoors.doors.length;
    }

    /**
     * Read-only view of what is tracked and who opened it, for diagnostics.
     * @returns {{ key: string, openedByBot: boolean, openObserved: boolean }[]}
     */
    get trackedPassages() {
        return [
            ...[...this._owed.values()].map((debt) => ({
                key: debt.key,
                openedByBot: debt.via === 'bot',
                openObserved: debt.openObserved === true
            })),
            ...this.ownerDoors.doors.map((door) => ({
                key: door.key,
                openedByBot: false,
                openObserved: true
            }))
        ];
    }

    /**
     * Keys of every passage the current route still goes through. The route's
     * door actions are stripped wholesale, so this is also the set the
     * companion has to be willing to handle: anything missing here is a wall.
     * @returns {string[]}
     */
    get neededPassages() {
        const keys = new Set();
        for (const plan of this._routePlans.values()) {
            if (this._isNeeded(plan.key, plan.passagePos)) keys.add(plan.key);
        }
        for (const debt of this._owed.values()) {
            if (this._isNeeded(debt.key, debt.passagePos)) keys.add(debt.key);
        }
        return [...keys];
    }

    /** True while a passage job needs the FSM to own movement. */
    get passagePending() {
        return this._job != null;
    }

    /** Read-only view of the job for the FSM and diagnostics. */
    get passageJob() {
        const job = this._job;
        if (!job) return null;
        return {
            key: job.key,
            intent: job.intent,
            reason: job.reason,
            passagePos: { ...job.passagePos },
            facing: job.facing
        };
    }

    /** Start (or resume) the bounded job window. */
    resumePassage() {
        const job = this._job;
        if (job && job.activeSince == null) job.activeSince = this.now();
    }

    /** Safety/combat may suspend a job without consuming its window. */
    suspendPassage() {
        const job = this._job;
        if (!job || job.activeSince == null) return;
        job.activeMs += Math.max(0, this.now() - job.activeSince);
        job.activeSince = null;
    }

    /**
     * End the job with a recorded reason and hold off on the same passage
     * briefly, so a failing passage cannot livelock the FSM.
     * @param {string} reason
     */
    failPassage(reason) {
        const job = this._job;
        if (!job) return false;
        // Failing an open is the only exit that hands back a passage the bot is
        // responsible for, so say so: the next report should be readable from
        // the log alone.
        const block = this._blockAt(job.passagePos);
        const leftOpen = isCloseablePassage(block) && block._properties?.open === true;
        console.warn(
            `[companion] passage ${job.intent} failed (${reason}) at ${job.key}`
            + (leftOpen ? ', left open' : '')
        );
        this._cooldown.set(job.key, this.now() + PASSAGE_FAIL_COOLDOWN_MS);
        this._job = null;
        return true;
    }

    /** End the job after the block state it asked for was confirmed. */
    finishPassage() {
        const job = this._job;
        if (!job) return false;
        const block = this._blockAt(job.passagePos);
        const open = isCloseablePassage(block) && block._properties?.open === true;
        // The debt recorded at the activation may already have expired while the
        // open went unconfirmed, so restate what this job established.
        if (job.intent === 'open' && open) this._oweClose(job, this.now(), true);
        if (job.intent === 'close') {
            this._owed.delete(job.key);
            // Closing publishes a block update, which resets the pathfinder and
            // can put the very same door action back on the next route. A short
            // pause is what keeps that from becoming an open/close oscillation.
            // An open needs no such pause, and must not have one: the close that
            // pays for it comes due a stride later, while the bot is still in
            // reach of the passage it just walked through.
            this._cooldown.set(job.key, this.now() + PASSAGE_DONE_COOLDOWN_MS);
        }
        console.log(`[companion] passage ${job.intent} done at ${job.key} (${job.reason})`);
        this._job = null;
        return true;
    }

    /**
     * True when an open door or gate separates the bot from the owner.
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {{ x: number, y: number, z: number }} ownerPos
     */
    findSeparatingPassage(botPos, ownerPos) {
        if (!botPos || !ownerPos) return false;

        for (const entry of [...this._owed.values(), ...this.ownerDoors.doors]) {
            if (isDoorBetween(botPos, ownerPos, entry.passagePos, entry.facing)) return true;
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
     * Observation and job selection only. Every activation belongs to the
     * `passage_transit` FSM state.
     */
    async tick() {
        const now = this.now();
        for (const [key, until] of this._cooldown) {
            if (until <= now) this._cooldown.delete(key);
        }

        const botPos = this.bot.entity?.position;
        this._expireDebts(now);
        for (const door of this.ownerDoors.collectCrossed(now, botPos, (pos) => this._blockAt(pos))) {
            if (this._owed.has(door.key)) continue;
            this._owed.set(door.key, {
                key: door.key,
                passagePos: { ...door.passagePos },
                facing: door.facing,
                openedAt: now,
                openObserved: true,
                awaitingRoute: false,
                via: 'owner'
            });
        }
        if (botPos) this._selectJob(botPos, now);
    }

    /**
     * Report the single next action the `passage_transit` state has to perform.
     *
     * Three outcomes describe the whole job: not in reach, walk; wrong state,
     * activate; right state, done. The rest is waiting for the server.
     * @param {number} [now]
     * @returns {PassageStep}
     */
    advancePassage(now = this.now()) {
        const job = this._job;
        if (!job) return { action: 'done' };

        const activeMs = job.activeMs + (
            job.activeSince == null ? 0 : Math.max(0, now - job.activeSince)
        );
        if (activeMs > PASSAGE_JOB_TIMEOUT_MS) return { action: 'fail', reason: 'timeout' };

        const block = this._blockAt(job.passagePos);
        if (!block || !isCloseablePassage(block)) return { action: 'done' };

        const botPos = this.bot.entity?.position;
        if (!botPos) return { action: 'hold' };

        const open = block._properties?.open === true;
        if (open === (job.intent === 'open')) return { action: 'done' };

        if (job.requestedAt != null) {
            if (now - job.requestedAt <= CONFIRM_MS) return { action: 'hold' };
            // The window closed without the state changing; try again from here.
            job.requestedAt = null;
        }

        const center = passageCenter(job.passagePos);
        const inReach = Math.hypot(botPos.x - center.x, botPos.z - center.z) <= OPERATE_REACH
            && Math.abs(botPos.y - center.y) <= VERTICAL_REACH;
        if (!inReach) {
            return {
                action: 'move',
                target: this._approachTarget(job, botPos),
                range: APPROACH_GOAL_RANGE
            };
        }
        // Counted here rather than per confirmation window, so an activation
        // that throws is just as bounded as one the world never reflects.
        if (job.attempts >= MAX_ATTEMPTS) return { action: 'fail', reason: 'unconfirmed' };
        return { action: 'activate' };
    }

    /**
     * Operate the job's passage. Only `passage_transit` calls this.
     * @returns {Promise<boolean>}
     */
    async activatePassage() {
        const job = this._job;
        if (!job) return false;
        const block = this._blockAt(job.passagePos);
        if (!block || !isCloseablePassage(block)) return false;
        const open = block._properties?.open === true;
        if (open === (job.intent === 'open')) return false;

        const requestedAt = this.now();
        job.requestedAt = requestedAt;
        job.attempts += 1;
        // Record the debt before the await, not when the open is confirmed.
        // Failing right after the activation must still leave a record saying
        // the bot opened this passage, and starting here beats the blockUpdate
        // that would otherwise credit an owner standing next to the door.
        if (job.intent === 'open') this._oweClose(job, requestedAt);

        this._operating = true;
        try {
            await this.bot.activateBlock(block);
            return true;
        } catch (err) {
            console.warn(`[companion] passage ${job.intent} failed:`, err?.message || err);
            job.requestedAt = null;
            return false;
        } finally {
            this._operating = false;
        }
    }

    /**
     * Where to stand while operating this passage.
     * @param {PassageJob} job
     * @param {{ x: number, y: number, z: number }} botPos
     */
    _approachTarget(job, botPos) {
        // Squarely in front of the doorway, on the side the bot is already on.
        // A close must never aim at the route's own point: that one lies before
        // the passage, so walking to it would lead back through the gate the bot
        // came to shut, and anything else drifts sideways along the fence into
        // ground no route describes.
        const side = doorSide(botPos, job.passagePos, job.facing) || 1;
        const standPoint = passageStandPoint(job.passagePos, job.facing, side, APPROACH_DISTANCE);
        if (job.intent !== 'open' || !job.approachPoint) return standPoint;

        const toRoutePoint = Math.hypot(
            botPos.x - job.approachPoint.x,
            botPos.z - job.approachPoint.z
        );
        // Far away, walk the point A* already proved reachable. Standing on it
        // and still out of reach means it cannot bring the bot any closer, and
        // re-issuing an arrived goal every tick is how a bot freezes at a gate.
        return toRoutePoint > APPROACH_DISTANCE ? { ...job.approachPoint } : standPoint;
    }

    /**
     * Drop debts that are settled, and forget the ones nobody can pay any more.
     * @param {number} now
     */
    _expireDebts(now) {
        for (const debt of [...this._owed.values()]) {
            const block = this._blockAt(debt.passagePos);
            if (!block || !isCloseablePassage(block)) {
                this._owed.delete(debt.key);
                continue;
            }
            if (block._properties?.open === true) {
                debt.openObserved = true;
                if (now - debt.openedAt > DEBT_TTL_MS) this._owed.delete(debt.key);
                continue;
            }
            // Closed: either somebody else closed it, or the open this debt was
            // recorded for never took effect.
            if (debt.openObserved || now - debt.openedAt > CONFIRM_MS) {
                this._owed.delete(debt.key);
            }
        }
    }

    /**
     * @param {PassageJob|{ key: string, passagePos: any, facing?: string }} job
     * @param {number} now
     * @param {boolean} [openObserved]
     */
    _oweClose(job, now, openObserved = false) {
        const existing = this._owed.get(job.key);
        if (existing) {
            existing.awaitingRoute = true;
            if (openObserved) existing.openObserved = true;
            return;
        }
        this._owed.set(job.key, {
            key: job.key,
            passagePos: { ...job.passagePos },
            facing: job.facing,
            openedAt: now,
            openObserved,
            // The route that asked for this passage stopped on its near side, so
            // it cannot say whether the bot has been through yet. Hold the debt
            // as needed until a route emitted after the open answers that.
            awaitingRoute: true,
            via: 'bot'
        });
    }

    /**
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {number} now
     */
    _selectJob(botPos, now) {
        const running = this._job;
        if (running?.intent === 'close' && this._isNeeded(running.key, running.passagePos)) {
            // The route came back through it: closing now would shut a gate the
            // bot is about to walk through.
            this._job = null;
        }

        const candidates = this._candidates(botPos, now);
        const pick = selectPassageJob(candidates);
        // An empty selection never cancels work in flight; only a finished or
        // failed job releases the FSM.
        if (!pick) return;

        const current = this._job;
        if (current) {
            if (current.key === pick.key && current.intent === pick.intent) return;
            // Never walk away from an activation whose result has not landed.
            if (current.requestedAt != null) return;
        }

        const candidate = candidates.find((entry) => entry.key === pick.key);
        if (!candidate) return;
        this._job = {
            key: candidate.key,
            intent: pick.intent,
            reason: pick.reason,
            passagePos: { ...candidate.passagePos },
            facing: candidate.facing,
            approachPoint: candidate.approachPoint ? { ...candidate.approachPoint } : null,
            requestedAt: null,
            attempts: 0,
            activeSince: null,
            activeMs: 0
        };
        console.log(`[companion] passage job ${pick.intent} at ${pick.key} (${pick.reason})`);
    }

    /**
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {number} now
     * @returns {PassageCandidate[]}
     */
    _candidates(botPos, now) {
        /** @type {Map<string, PassageCandidate>} */
        const byKey = new Map();

        for (const plan of this._routePlans.values()) {
            const candidate = this._describe(plan, botPos, now);
            if (candidate) byKey.set(plan.key, candidate);
        }
        for (const debt of this._owed.values()) {
            const candidate = byKey.get(debt.key) || this._describe(debt, botPos, now);
            if (!candidate) continue;
            candidate.owed = true;
            byKey.set(debt.key, candidate);
        }

        return [...byKey.values()];
    }

    /**
     * @param {{
     *   key: string,
     *   passagePos: { x: number, y: number, z: number },
     *   facing?: string,
     *   approachPoint?: { x: number, y: number, z: number }|null
     * }} source
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {number} now
     * @returns {PassageCandidate|null}
     */
    _describe(source, botPos, now) {
        const block = this._blockAt(source.passagePos);
        if (!block || !isCloseablePassage(block)) return null;
        const center = passageCenter(source.passagePos);
        const distance = Math.hypot(botPos.x - center.x, botPos.z - center.z);
        return {
            key: source.key,
            passagePos: source.passagePos,
            facing: source.facing,
            approachPoint: source.approachPoint ?? null,
            open: block._properties?.open === true,
            needed: this._isNeeded(source.key, source.passagePos),
            owed: false,
            distance,
            inReach: distance <= OPERATE_REACH
                && Math.abs(botPos.y - center.y) <= VERTICAL_REACH,
            cooldown: (this._cooldown.get(source.key) ?? 0) > now
        };
    }

    /**
     * @param {string} key
     * @param {{ x: number, y: number, z: number }} passagePos
     */
    _isNeeded(key, passagePos) {
        if (this._owed.get(key)?.awaitingRoute === true) return true;
        // A route that never walks through its own door action cannot report
        // progress past it either, so the action stands until the next route.
        if (this._routePlans.get(key)?.onPath === false) return true;
        return routeEntersPassage(this._route, passagePos);
    }

    /**
     * Adopt a freshly planned route: it names every passage the bot has to get
     * through, and the array itself keeps reporting which ones are still ahead.
     * @param {{ status?: string, path?: Array<any> }} result
     */
    _handlePathUpdate(result) {
        if (!Array.isArray(result?.path)) return;
        if (result.status !== 'success' && result.status !== 'partial') return;

        this._routePlans = analyzePassageRoute(this.bot, result.path);
        this._removePathfinderPassageActions(result.path);
        this._route = result.path;
        for (const debt of this._owed.values()) debt.awaitingRoute = false;
    }

    /**
     * @param {import('prismarine-block').Block|null} oldBlock
     * @param {import('prismarine-block').Block|null} newBlock
     */
    _handleBlockUpdate(oldBlock, newBlock) {
        if (!isCloseablePassage(newBlock)) return;
        const key = posKey(normalizeDoorPos(newBlock));
        const debt = this._owed.get(key);
        // A passage the bot opened is already owed; an owner standing next to it
        // while the server update lands must not take that debt away.
        if (debt) {
            if (newBlock._properties?.open === true) debt.openObserved = true;
            return;
        }
        // The owner opening a passage is new information about it, so whatever
        // the bot failed at, or just finished, no longer governs.
        if (this.ownerDoors.handleBlockUpdate(oldBlock, newBlock)) {
            this._cooldown.delete(key);
        }
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
     * is exactly the parallel door control the passage job replaces. Every
     * passage on the route is stripped, and every passage on the route becomes a
     * candidate: one stripped but left unhandled would simply be a wall.
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
     * @param {{ x: number, y: number, z: number }} pos
     * @returns {import('prismarine-block').Block|null}
     */
    _blockAt(pos) {
        return this.bot.blockAt(new Vec3(
            Math.floor(pos.x),
            Math.floor(pos.y),
            Math.floor(pos.z)
        ));
    }
}
