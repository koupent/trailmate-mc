import Vec3 from 'vec3';

/** Max reach used when reading what the owner is looking at. */
const OWNER_LOOK_RANGE = 5;
/** After a swing, accept a matching closed→open update for this long. */
const SWING_MATCH_MS = 450;
/** Drop a tracked door if the bot never finishes passing through. */
const TRACK_TTL_MS = 20000;
/** Record which side the bot approached from once this close. */
const APPROACH_DISTANCE = 2.25;
/** Require this clearance past the door before closing. */
const CLEAR_DISTANCE = 1.35;

/**
 * Wooden doors and fence gates the companion may close after passing through.
 * Iron doors and trapdoors are excluded.
 * @param {{ name?: string }|null|undefined} block
 * @returns {boolean}
 */
export function isCloseablePassage(block) {
    if (!block?.name) return false;
    const name = block.name.toLowerCase();
    if (name.includes('iron') || name.includes('trapdoor')) return false;
    return name.includes('door') || name.includes('fence_gate');
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
 * Owner opens: swing + look + closed→open blockUpdate.
 * Bot opens: pathfinder activateBlock on a closed passage.
 */
export class DoorTracker {
    /**
     * @param {import('mineflayer').Bot} bot
     * @param {{ getOwnerEntity?: () => import('prismarine-entity').Entity|null }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.getOwnerEntity = options.getOwnerEntity || (() => null);

        /** @type {{ key: string, doorPos: {x:number,y:number,z:number}, facing?: string, at: number }[]} */
        this._pending = [];
        /** @type {{ key: string, doorPos: {x:number,y:number,z:number}, facing?: string, approachSide: -1|0|1|null, openedAt: number }[]} */
        this._tracked = [];
        this._closing = false;

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
     * Expire stale entries and close doors the bot has finished passing through.
     */
    async tick() {
        const now = Date.now();
        this._pending = this._pending.filter((p) => now - p.at <= SWING_MATCH_MS);
        this._tracked = this._tracked.filter((t) => now - t.openedAt <= TRACK_TTL_MS);

        if (this._closing || this._tracked.length === 0) return;

        const botPos = this.bot.entity?.position;
        if (!botPos) return;

        for (const tracked of [...this._tracked]) {
            const block = this._blockAt(tracked.doorPos);
            if (!block || !isCloseablePassage(block) || block._properties?.open !== true) {
                this._forget(tracked.key);
                continue;
            }

            const result = evaluatePassage(tracked, botPos);
            tracked.approachSide = result.approachSide;
            if (!result.readyToClose) continue;

            await this._closeTracked(tracked, block);
            return;
        }
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
        return this._originalActivateBlock(block, ...args);
    }

    /**
     * @param {import('prismarine-block').Block|null|undefined} block
     */
    _noteBotOpened(block) {
        if (!block || !isCloseablePassage(block)) return;
        if (block._properties?.open === true) return;
        this._startTracking(normalizeDoorPos(block), block._properties?.facing);
    }

    /**
     * @param {import('prismarine-entity').Entity} entity
     */
    _handleSwing(entity) {
        const owner = this.getOwnerEntity();
        if (!owner || !entity || entity.id !== owner.id) return;

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
            at: Date.now()
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
        const now = Date.now();
        const pending = this._pending.find((p) => p.key === key && now - p.at <= SWING_MATCH_MS);
        if (!pending) return;

        this._pending = this._pending.filter((p) => p.key !== key);
        this._startTracking(doorPos, newBlock._properties?.facing ?? pending.facing, now);
    }

    /**
     * @param {{ x: number, y: number, z: number }} doorPos
     * @param {string|undefined} facing
     * @param {number} [openedAt]
     */
    _startTracking(doorPos, facing, openedAt = Date.now()) {
        const key = posKey(doorPos);
        if (this._tracked.some((t) => t.key === key)) return;
        this._tracked.push({
            key,
            doorPos,
            facing,
            approachSide: null,
            openedAt
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
            await this.bot.activateBlock(current);
        } catch (err) {
            console.warn('[companion] door close failed:', err?.message || err);
        } finally {
            this._forget(tracked.key);
            this._closing = false;
        }
    }

    /** @param {string} key */
    _forget(key) {
        this._tracked = this._tracked.filter((t) => t.key !== key);
        this._pending = this._pending.filter((p) => p.key !== key);
    }
}
