import Vec3 from 'vec3';
import { isDoorPassableName } from '../blockProtection.js';

/** Max reach used when reading what the owner is looking at. */
const OWNER_LOOK_RANGE = 5;
/**
 * If the owner opens a door while looking past it (common when exiting),
 * still track when they are this close to the door.
 */
const OWNER_NEAR_DOOR_FOR_TRACK = 4;
/** After a swing, accept a matching closed→open update for this long. */
const SWING_MATCH_MS = 1500;
/** Drop a tracked door if the bot never finishes passing through. */
const TRACK_TTL_MS = 45000;
/** Record which side the bot approached from once this close. */
const APPROACH_DISTANCE = 2.25;
/** Require this clearance past the door before closing. */
const CLEAR_DISTANCE = 1.35;
/** Avoid double-activate toggle (open then immediately close). */
const OPEN_COOLDOWN_MS = 1200;
/**
 * Block state can lag behind our own activation, so a door we just toggled may
 * still read as closed. Never touch the same door again inside this window.
 */
const REOPEN_GUARD_MS = 2500;
/** Allow the server time to publish the open state after our activation. */
const OPEN_CONFIRM_MS = 2500;
/** Allow the server time to publish the closed state after our activation. */
const CLOSE_CONFIRM_MS = 1200;
/** Back off briefly before retrying a failed or unconfirmed close. */
const CLOSE_RETRY_MS = 600;

/**
 * Wooden doors and fence gates the companion may close after passing through.
 * Iron doors and trapdoors are excluded.
 * @param {{ name?: string }|null|undefined} block
 * @returns {boolean}
 */
export function isCloseablePassage(block) {
    return isDoorPassableName(block?.name);
}

/**
 * Always track the lower half of a two-block door.
 * @param {{ position: { x: number, y: number, z: number }, _properties?: { half?: string } }} block
 * @returns {{ x: number, y: number, z: number }}
 */
export function normalizeDoorPos(block) {
    const pos = block.position;
    if (block._properties?.half === 'upper') {
        return { x: pos.x, y: pos.y - 1, z: pos.z };
    }
    return { x: pos.x, y: pos.y, z: pos.z };
}

/**
 * @param {{ x: number, y: number, z: number }} pos
 * @returns {string}
 */
export function posKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

/**
 * Which side of the door the position is on, using facing when available.
 * @param {{ x: number, z: number }} pos
 * @param {{ x: number, z: number }} doorPos
 * @param {string|undefined} facing
 * @returns {-1|0|1}
 */
export function doorSide(pos, doorPos, facing) {
    const cx = doorPos.x + 0.5;
    const cz = doorPos.z + 0.5;
    if (facing === 'east' || facing === 'west') {
        return /** @type {-1|0|1} */ (Math.sign(pos.x - cx));
    }
    return /** @type {-1|0|1} */ (Math.sign(pos.z - cz));
}

/**
 * Whether the door truly separates bot from owner.
 * Owner standing on the threshold (a few cm past the door plane) must not count —
 * that was opening doors while both were still sheltering inside.
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
 * True when a block update is a closed → open transition of a closeable passage.
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} oldBlock
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} newBlock
 */
export function isClosedToOpen(oldBlock, newBlock) {
    if (!isCloseablePassage(newBlock) || !isCloseablePassage(oldBlock)) return false;
    return oldBlock._properties?.open !== true && newBlock._properties?.open === true;
}

/**
 * Closes wooden doors / fence gates after the bot passes through.
 * Owner opens: swing + look + closed→open, or closed→open while owner is near the door.
 * Bot opens: pathfinder / DoorTracker activateBlock on a closed passage.
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
         *   openObserved: boolean,
         *   closeRequestedAt: number|null,
         *   retryCloseAt: number
         * }[]} */
        this._tracked = [];
        this._closing = false;
        this._opening = false;
        this._openCooldownUntil = 0;
        /** @type {Map<string, number>} door key -> last activation time */
        this._recentOpens = new Map();
        this._lastOwnerSwingAt = 0;

        this._onSwing = (entity) => this._handleSwing(entity);
        this._onBlockUpdate = (oldBlock, newBlock) => this._handleBlockUpdate(oldBlock, newBlock);
        this._originalActivateBlock = typeof bot.activateBlock === 'function'
            ? bot.activateBlock.bind(bot)
            : null;

        if (this._originalActivateBlock) {
            bot.activateBlock = (...args) => this._wrappedActivateBlock(...args);
        }

        bot.on('entitySwingArm', this._onSwing);
        bot.on('blockUpdate', this._onBlockUpdate);
    }

    dispose() {
        this.bot.off('entitySwingArm', this._onSwing);
        this.bot.off('blockUpdate', this._onBlockUpdate);
        if (this._originalActivateBlock) {
            this.bot.activateBlock = this._originalActivateBlock;
            this._originalActivateBlock = null;
        }
        this._pending = [];
        this._tracked = [];
    }

    /** @returns {number} */
    get trackedCount() {
        return this._tracked.length;
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
     * Expire stale entries, open a closed door blocking the path, and close after passage.
     */
    async tick() {
        const now = this.now();
        this._pending = this._pending.filter((p) => now - p.at <= SWING_MATCH_MS);
        this._tracked = this._tracked.filter((t) => now - t.openedAt <= TRACK_TTL_MS);

        if (this._closing) return;

        await this.openBlockingDoorIfNeeded();

        if (this._tracked.length === 0) return;

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
            if (tracked.closeRequestedAt != null) {
                if (now - tracked.closeRequestedAt <= CLOSE_CONFIRM_MS) continue;
                tracked.closeRequestedAt = null;
                tracked.retryCloseAt = now + CLOSE_RETRY_MS;
            }

            const result = evaluatePassage(tracked, botPos);
            tracked.approachSide = result.approachSide;
            if (!result.readyToClose || now < tracked.retryCloseAt) continue;

            await this._closeTracked(tracked, block);
            return;
        }
    }

    /**
     * Open one closed door between the bot and owner. Shared entry point for recovery.
     * @returns {Promise<boolean>} true if an open was attempted
     */
    async openBlockingDoorIfNeeded() {
        if (this._opening || this._closing) return false;
        const now = this.now();
        if (now < this._openCooldownUntil) return false;

        const botPos = this.bot.entity?.position;
        const owner = this.getOwnerEntity();
        if (!botPos || !owner?.position) return false;

        for (const [key, at] of this._recentOpens) {
            if (now - at > REOPEN_GUARD_MS) this._recentOpens.delete(key);
        }

        const door = this._findBlockingClosedDoor(botPos, owner.position);
        if (!door) return false;

        // Re-read right before activate to avoid toggling an already-open door.
        const current = this._blockAt(door.position) || door;
        if (!isCloseablePassage(current) || current._properties?.open === true) return false;

        this._opening = true;
        this._openCooldownUntil = now + OPEN_COOLDOWN_MS;
        this._recentOpens.set(posKey(current.position), now);
        try {
            await this.bot.activateBlock(current);
            return true;
        } catch (err) {
            console.warn('[companion] door open failed:', err?.message || err);
            return false;
        } finally {
            this._opening = false;
        }
    }

    /**
     * @param {{ x: number, y: number, z: number }} botPos
     * @param {{ x: number, y: number, z: number }} ownerPos
     * @returns {import('prismarine-block').Block|null}
     */
    _findBlockingClosedDoor(botPos, ownerPos) {
        const baseX = Math.floor(botPos.x);
        const baseY = Math.floor(botPos.y);
        const baseZ = Math.floor(botPos.z);
        const towardX = ownerPos.x - botPos.x;
        const towardZ = ownerPos.z - botPos.z;
        const towardLen = Math.hypot(towardX, towardZ) || 1;
        const ux = towardX / towardLen;
        const uz = towardZ / towardLen;

        /** @type {{ block: import('prismarine-block').Block, score: number }[]} */
        const candidates = [];
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (dx === 0 && dz === 0) continue;
                const block = this._blockAt({ x: baseX + dx, y: baseY, z: baseZ + dz });
                if (!block || !isCloseablePassage(block)) continue;
                if (block._properties?.open === true) continue;

                // Prefer the lower half so activateBlock toggles the full door.
                const lower = block._properties?.half === 'upper'
                    ? this._blockAt({ x: block.position.x, y: block.position.y - 1, z: block.position.z })
                    : block;
                if (!lower || !isCloseablePassage(lower) || lower._properties?.open === true) continue;

                const cx = lower.position.x + 0.5 - botPos.x;
                const cz = lower.position.z + 0.5 - botPos.z;
                const dist = Math.hypot(cx, cz);
                if (dist > 2.6) continue;
                const alignment = (cx * ux + cz * uz) / (dist || 1);
                if (alignment < 0.15) continue;

                if (this._openSkipReason(lower)) continue;

                // Same room / threshold: door is toward the owner but they have not
                // actually gone through it — do not open and let mobs in.
                if (!isDoorBetween(botPos, ownerPos, lower.position, lower._properties?.facing)) {
                    continue;
                }

                candidates.push({ block: lower, score: alignment * 2 - dist });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.block || null;
    }

    /**
     * Why this closed door must be left alone, or null when it may be opened.
     * @param {import('prismarine-block').Block} door lower half
     * @returns {'recently-toggled'|'other-leaf-open'|null}
     */
    _openSkipReason(door) {
        const lastOpen = this._recentOpens.get(posKey(door.position));
        if (lastOpen != null && this.now() - lastOpen < REOPEN_GUARD_MS) return 'recently-toggled';

        // Double doors: the leaf the owner already opened is the passage to use.
        const pos = door.position;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const neighbour = this._blockAt({ x: pos.x + dx, y: pos.y, z: pos.z + dz });
            if (isCloseablePassage(neighbour) && neighbour._properties?.open === true) {
                return 'other-leaf-open';
            }
        }
        return null;
    }

    /**
     * pathfinder opens doors via activateBlock; record closed passages we open.
     * @param {import('prismarine-block').Block} block
     * @param {...any} args
     */
    _wrappedActivateBlock(block, ...args) {
        if (!this._closing) {
            this._noteBotOpened(block);
        }
        if (isCloseablePassage(block)) {
            this._recentOpens.set(posKey(normalizeDoorPos(block)), this.now());
        }
        return this._originalActivateBlock(block, ...args);
    }

    /**
     * @param {import('prismarine-block').Block|null|undefined} block
     */
    _noteBotOpened(block) {
        if (!block || !isCloseablePassage(block)) return;
        if (block._properties?.open === true) return;
        this._startTracking(
            normalizeDoorPos(block),
            block._properties?.facing,
            this.now(),
            { openObserved: false }
        );
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
            doorPos,
            facing,
            approachSide: approachSide || null,
            openedAt,
            openObserved: options.openObserved === true,
            closeRequestedAt: null,
            retryCloseAt: 0
        });
    }

    /**
     * @param {{ x: number, y: number, z: number }} doorPos
     * @returns {import('prismarine-block').Block|null}
     */
    _blockAt(doorPos) {
        return this.bot.blockAt(new Vec3(doorPos.x, doorPos.y, doorPos.z));
    }

    /**
     * @param {{ key: string, doorPos: {x:number,y:number,z:number} }} tracked
     * @param {import('prismarine-block').Block} block
     */
    async _closeTracked(tracked, block) {
        this._closing = true;
        try {
            const current = this._blockAt(tracked.doorPos) || block;
            if (!current || !isCloseablePassage(current) || current._properties?.open !== true) {
                return;
            }
            tracked.closeRequestedAt = this.now();
            await this.bot.activateBlock(current);
        } catch (err) {
            tracked.closeRequestedAt = null;
            tracked.retryCloseAt = this.now() + CLOSE_RETRY_MS;
            console.warn('[companion] door close failed:', err?.message || err);
        } finally {
            this._closing = false;
        }
    }

    /** @param {string} key */
    _forget(key) {
        this._tracked = this._tracked.filter((t) => t.key !== key);
        this._pending = this._pending.filter((p) => p.key !== key);
    }
}
