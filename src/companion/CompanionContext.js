import { MovementController } from './movement/MovementController.js';
import { StuckMonitor } from './movement/StuckMonitor.js';
import { DoorTracker } from './movement/DoorTracker.js';

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
        this.stuck = new StuckMonitor();
        this.doors = new DoorTracker(agent.bot, {
            getOwnerEntity: () => this.ownerEntity
        });
        /** @type {string|null} locked follow target username */
        this.ownerName = null;
    }

    get ownerEntity() {
        if (!this.ownerName) return null;
        return this.bot.players[this.ownerName]?.entity || null;
    }
}
