import {
    APPROACH_DISTANCE,
    CLEAR_DISTANCE,
    isRoutePassage,
    normalizePassagePosition,
    passagePositionKey,
    passageSide
} from './passageRoute.js';

/**
 * Doors the owner opened, and the one rule that says when the companion owes
 * one of them a close.
 *
 * Every other passage is judged by the route: the pathfinder asks for a door
 * action, so the bot knows it means to go through. An already-open door emits
 * no such action, so a route can never report that the bot is using one. All
 * that is left is to watch: record which side the bot came from, and treat
 * reaching the far side with clearance as having gone through. Coming back to
 * the same side is not a crossing, so a door the bot only walked up to and
 * turned away from is left exactly as the owner left it.
 */

/** Max reach used when reading what the owner is looking at. */
const OWNER_LOOK_RANGE = 5;
/** After a swing, accept a matching closed-to-open update for this long. */
const SWING_MATCH_MS = 1500;
/** Drop a door the bot never went through. */
const TRACK_TTL_MS = 45000;

/**
 * True when a block update is a closed-to-open transition of a passage.
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} oldBlock
 * @param {{ name?: string, _properties?: { open?: boolean } }|null|undefined} newBlock
 */
export function isClosedToOpen(oldBlock, newBlock) {
    if (!isRoutePassage(newBlock) || !isRoutePassage(oldBlock)) return false;
    return oldBlock._properties?.open !== true && newBlock._properties?.open === true;
}

/**
 * Whether the bot has approached a door and fully crossed it.
 * @param {{
 *   approachSide: -1|0|1|null,
 *   facing?: string,
 *   passagePos: { x: number, y: number, z: number }
 * }} tracked
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{ approachDistance?: number, clearDistance?: number }} [opts]
 * @returns {{ approachSide: -1|0|1|null, readyToClose: boolean }}
 */
export function evaluatePassage(tracked, botPos, opts = {}) {
    const approachDistance = opts.approachDistance ?? APPROACH_DISTANCE;
    const clearDistance = opts.clearDistance ?? CLEAR_DISTANCE;
    const passagePos = tracked.passagePos;
    const horiz = Math.hypot(
        botPos.x - (passagePos.x + 0.5),
        botPos.z - (passagePos.z + 0.5)
    );
    const side = passageSide(botPos, passagePos, tracked.facing);

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
 * @typedef {{
 *   key: string,
 *   passagePos: { x: number, y: number, z: number },
 *   facing?: string,
 *   approachSide: -1|0|1|null,
 *   openedAt: number
 * }} OwnerDoor
 */

/** Watches the owner open doors, and reports the ones the bot then walks through. */
export class OwnerDoorWatch {
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
        /** @type {{ key: string, facing?: string, at: number }[]} */
        this._pending = [];
        /** @type {OwnerDoor[]} */
        this._doors = [];
        this._lastSwingAt = 0;
    }

    /** @returns {OwnerDoor[]} */
    get doors() {
        return this._doors;
    }

    clear() {
        this._pending = [];
        this._doors = [];
    }

    /**
     * The owner swung at something. A swing that lands on a closed passage is
     * the strongest evidence of who is about to open it.
     * @param {import('prismarine-entity').Entity} entity
     */
    handleSwing(entity) {
        const owner = this.getOwnerEntity();
        if (!owner || !entity || entity.id !== owner.id) return;
        const now = this.now();
        this._lastSwingAt = now;

        let target = null;
        try {
            target = this.bot.blockAtEntityCursor(owner, OWNER_LOOK_RANGE);
        } catch {
            return;
        }
        if (!target || !isRoutePassage(target)) return;
        if (target._properties?.open === true) return;

        const key = passagePositionKey(normalizePassagePosition(target));
        this._pending = this._pending.filter((p) => p.key !== key);
        this._pending.push({ key, facing: target._properties?.facing, at: now });
    }

    /**
     * @param {import('prismarine-block').Block|null} oldBlock
     * @param {import('prismarine-block').Block|null} newBlock
     * @returns {boolean} whether the door was attributed to the owner
     */
    handleBlockUpdate(oldBlock, newBlock) {
        if (!isClosedToOpen(oldBlock, newBlock)) return false;

        const passagePos = normalizePassagePosition(newBlock);
        const key = passagePositionKey(passagePos);
        const now = this.now();
        const facing = newBlock._properties?.facing;

        const pending = this._pending.find((p) => p.key === key && now - p.at <= SWING_MATCH_MS);
        if (pending) {
            this._pending = this._pending.filter((p) => p.key !== key);
            this._track(passagePos, facing ?? pending.facing, now);
            return true;
        }

        // The owner often looks outward while opening, so the swing never
        // targets the door. Still attribute it while they stand at the passage.
        const owner = this.getOwnerEntity();
        if (!owner?.position) return false;
        const ownerHoriz = Math.hypot(
            owner.position.x - (passagePos.x + 0.5),
            owner.position.z - (passagePos.z + 0.5)
        );
        const recentSwing = now - this._lastSwingAt <= SWING_MATCH_MS;
        if (ownerHoriz > APPROACH_DISTANCE
            && (!recentSwing || ownerHoriz > OWNER_LOOK_RANGE)) {
            return false;
        }

        this._track(passagePos, facing, now);
        return true;
    }

    /**
     * Expire what closed or timed out, and hand back the doors the bot has now
     * crossed. Each is reported once: it becomes the caller's debt from here.
     * @param {number} now
     * @param {{ x: number, y: number, z: number }|null|undefined} botPos
     * @param {(pos: { x:number, y:number, z:number }) => any} blockAt
     * @returns {OwnerDoor[]}
     */
    collectCrossed(now, botPos, blockAt) {
        this._pending = this._pending.filter((p) => now - p.at <= SWING_MATCH_MS);

        /** @type {OwnerDoor[]} */
        const crossed = [];
        this._doors = this._doors.filter((door) => {
            if (now - door.openedAt > TRACK_TTL_MS) return false;
            const block = blockAt(door.passagePos);
            if (!isRoutePassage(block) || block._properties?.open !== true) return false;
            if (!botPos) return true;

            const state = evaluatePassage(door, botPos);
            door.approachSide = state.approachSide;
            if (!state.readyToClose) return true;
            crossed.push(door);
            return false;
        });
        return crossed;
    }

    /** @param {string} key */
    forget(key) {
        this._doors = this._doors.filter((door) => door.key !== key);
        this._pending = this._pending.filter((p) => p.key !== key);
    }

    /**
     * @param {{ x: number, y: number, z: number }} passagePos
     * @param {string|undefined} facing
     * @param {number} now
     */
    _track(passagePos, facing, now) {
        const key = passagePositionKey(passagePos);
        const existing = this._doors.find((door) => door.key === key);
        if (existing) {
            if (!existing.facing && facing) existing.facing = facing;
            return;
        }

        const botPos = this.bot.entity?.position;
        this._doors.push({
            key,
            passagePos: { ...passagePos },
            facing,
            approachSide: botPos ? passageSide(botPos, passagePos, facing) || null : null,
            openedAt: now
        });
    }
}
