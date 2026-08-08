import { MovementController } from './movement/MovementController.js';
import { StuckMonitor } from './movement/StuckMonitor.js';
import { DoorTracker } from './movement/DoorTracker.js';
import { HazardEscapeController } from './movement/HazardEscape.js';
import { createDeathRecoveryState } from './deathRecovery.js';
import { scanCompanionAwareness } from '../world/companionAwareness.js';
import { resolvePickupRadius } from './utils/pickupItems.js';

/**
 * Shared context passed to modes and interrupts.
 */
export class CompanionContext {
    /**
     * @param {import('../agent.js').Agent} agent
     * @param {import('./WorldState.js').WorldState} worldState
     * @param {object} config
     */
    constructor(agent, worldState, config) {
        this.agent = agent;
        this.bot = agent.bot;
        this.worldState = worldState;
        this.config = config;
        this.movement = new MovementController(agent.bot);
        this.hazardEscape = new HazardEscapeController(agent.bot, this.movement);
        this.stuck = new StuckMonitor();
        /** @type {{ seconds: number, at: number }|null} sticky stuck signal for chat (survives stuck.reset) */
        this.stuckChat = null;
        this.doors = new DoorTracker(agent.bot, {
            getOwnerEntity: () => this.ownerEntity,
            getMode: () => agent.companion?.manager?.getActiveFsmId?.() || null
        });
        /** @type {string|null} locked follow target username */
        this.ownerName = null;
        /** @type {import('./deathRecovery.js').DeathRecoveryState} */
        this.deathRecovery = createDeathRecoveryState();
        /** @type {{ active: boolean, targetKey: string|null }} */
        this.graveLoot = { active: false, targetKey: null };
        /** @type {{ active: boolean, suppressUntil: number, priorityUntil?: number, priorityOrigin?: { x: number, y: number, z: number } | null }} nearby ground-item scavenging */
        this.nearbyLoot = { active: false, suppressUntil: 0, priorityUntil: 0, priorityOrigin: null };
        /** @type {{ active: boolean }} surplus transfer into an owner-placed chest */
        this.itemTransfer = { active: false };
        /** @type {Map<number, import('./ownerWorkTracker.js').OwnerWorkState>} */
        this.playerWorkById = new Map();
        /** When true, companion loop skips combat reflexes. */
        this.holdReflexes = false;
        /** @type {import('../world/companionAwareness.js').CompanionAwarenessSnapshot|null} */
        this._awareness = null;
    }

    get ownerEntity() {
        if (!this.ownerName) return null;
        return this.bot.players[this.ownerName]?.entity || null;
    }

    /** Clear the per-tick awareness cache so the next read rescans. */
    invalidateCompanionAwareness() {
        this._awareness = null;
    }

    /**
     * Companion awareness snapshot for the current tick (cached).
     * @returns {import('../world/companionAwareness.js').CompanionAwarenessSnapshot}
     */
    getCompanionAwareness() {
        if (this._awareness) return this._awareness;
        const radius = resolvePickupRadius(this);
        this._awareness = scanCompanionAwareness(this.bot, radius, this.bot?.entity?.position);
        return this._awareness;
    }
}
