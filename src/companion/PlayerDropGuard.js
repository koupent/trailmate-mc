import { isGroundItem } from '../world/entities.js';

export const PLAYER_DROP_PROTECTION_MS = 2000;

/**
 * Break-animation packets identify the player mining a block. Item spawns
 * close to a block recently mined by a player are therefore the only
 * drops protected by this guard; unrelated ground items remain eligible.
 */
const BREAK_TO_DROP_WINDOW_MS = 1500;
const BREAK_TO_DROP_DISTANCE = 1.75;

export class PlayerDropGuard {
    /**
     * @param {import('mineflayer').Bot} bot
     * @param {{
     *   now?: () => number,
     *   protectionMs?: number
     * }} [options]
     */
    constructor(bot, options = {}) {
        this.bot = bot;
        this.now = options.now || Date.now;
        this.protectionMs = options.protectionMs ?? PLAYER_DROP_PROTECTION_MS;
        /** @type {Map<string, { position: { x: number, y: number, z: number }, observedAt: number }>} */
        this.recentPlayerBreaks = new Map();
        /** @type {Map<number, number>} */
        this.protectedUntilByEntityId = new Map();
        this.attached = false;

        this.onBreakProgress = (block, _stage, entity) => this.recordPlayerBreak(block, entity);
        this.onBreakEnd = (block, entity) => this.recordPlayerBreak(block, entity);
        this.onEntitySpawn = (entity) => this.protectMatchingDrop(entity);
        this.onEntityGone = (entity) => this.forgetEntity(entity);
    }

    attach() {
        if (this.attached) return;
        this.attached = true;
        this.bot.on('blockBreakProgressObserved', this.onBreakProgress);
        this.bot.on('blockBreakProgressEnd', this.onBreakEnd);
        this.bot.on('entitySpawn', this.onEntitySpawn);
        this.bot.on('entityGone', this.onEntityGone);
    }

    detach() {
        if (!this.attached) return;
        this.attached = false;
        this.bot.off('blockBreakProgressObserved', this.onBreakProgress);
        this.bot.off('blockBreakProgressEnd', this.onBreakEnd);
        this.bot.off('entitySpawn', this.onEntitySpawn);
        this.bot.off('entityGone', this.onEntityGone);
        this.recentPlayerBreaks.clear();
        this.protectedUntilByEntityId.clear();
    }

    /** @param {{ id?: number }|null|undefined} entity @param {number} [now] */
    isProtected(entity, now = this.now()) {
        if (entity?.id == null) return false;
        const protectedUntil = this.protectedUntilByEntityId.get(entity.id);
        if (protectedUntil == null) return false;
        if (now < protectedUntil) return true;
        this.protectedUntilByEntityId.delete(entity.id);
        return false;
    }

    /**
     * @param {{ position?: { x: number, y: number, z: number }}|null} block
     * @param {{ id?: number }|null} entity
     */
    recordPlayerBreak(block, entity) {
        if (!isObservedPlayer(this.bot, entity) || !block?.position) return;

        const now = this.now();
        this.prune(now);
        const position = copyPosition(block.position);
        this.recentPlayerBreaks.set(positionKey(position), { position, observedAt: now });
    }

    /** @param {{ id?: number, position?: { x: number, y: number, z: number }}|null} entity */
    protectMatchingDrop(entity) {
        if (entity?.id == null || !entity.position || !isGroundItem(entity)) return;

        const now = this.now();
        this.prune(now);
        let matchesPlayerBreak = false;
        for (const { position } of this.recentPlayerBreaks.values()) {
            if (distanceToBlockCenter(entity.position, position) <= BREAK_TO_DROP_DISTANCE) {
                matchesPlayerBreak = true;
                break;
            }
        }
        if (!matchesPlayerBreak) return;

        this.protectedUntilByEntityId.set(entity.id, now + this.protectionMs);
    }

    /** @param {{ id?: number }|null|undefined} entity */
    forgetEntity(entity) {
        if (entity?.id != null) this.protectedUntilByEntityId.delete(entity.id);
    }

    /** @param {number} now */
    prune(now) {
        for (const [key, entry] of this.recentPlayerBreaks) {
            if (now - entry.observedAt > BREAK_TO_DROP_WINDOW_MS) {
                this.recentPlayerBreaks.delete(key);
            }
        }
        for (const [entityId, protectedUntil] of this.protectedUntilByEntityId) {
            if (now >= protectedUntil) this.protectedUntilByEntityId.delete(entityId);
        }
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ id?: number, type?: string, name?: string }|null|undefined} entity
 */
function isObservedPlayer(bot, entity) {
    if (entity?.id == null || entity.id === bot.entity?.id) return false;
    if (entity.type === 'player' || entity.name === 'player') return true;
    return Object.values(bot.players || {}).some((player) => player?.entity?.id === entity.id);
}

/** @param {{ x: number, y: number, z: number }} position */
function copyPosition(position) {
    return { x: position.x, y: position.y, z: position.z };
}

/** @param {{ x: number, y: number, z: number }} position */
function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

/**
 * @param {{ x: number, y: number, z: number }} itemPosition
 * @param {{ x: number, y: number, z: number }} blockPosition
 */
function distanceToBlockCenter(itemPosition, blockPosition) {
    return Math.hypot(
        itemPosition.x - (blockPosition.x + 0.5),
        itemPosition.y - (blockPosition.y + 0.5),
        itemPosition.z - (blockPosition.z + 0.5)
    );
}
