import { isHostile, getNearestEntityWhere } from '../world/entities.js';
import {
    classifyPlayerCommand,
    detectCombatCommentary,
    detectIdleCommentary,
    detectSituationEvent,
    deriveFollowPhase,
    deriveFollowReplyKey,
    deriveHostileBand,
    renderCommentary
} from './dialogueParse.js';
import { buildOwnerFollowFacts, isPlayerEligible, lockOwner } from './ownerLock.js';
import { giveAllItemsToPlayer, countAllItems } from './utils/giveAllItems.js';
import { countSupplyItems } from './utils/inventorySnapshot.js';
import { tCommand } from '../i18n/index.js';
import { shouldDeferToCombat } from './combatGate.js';
import { DEFAULT_GIVE_SUPPRESS_MS } from './utils/nearbyLootConstants.js';

export const DEFAULT_CHAT_CONFIG = {
    enabled: true,
    min_interval_ms: 45000,
    priority_min_interval_ms: 15000,
    event_cooldown_ms: 120000,
    player_reply_cooldown_ms: 1500,
    spontaneous_chance: 0.85,
    idle_chance: 0.55,
    combat_commentary_chance: 0.6,
    low_health: 8,
    low_food_hunger: 14,
    stuck_seconds: 5,
    hostile_range: 12,
    hostile_approach_distances: [10, 6, 3]
};

/**
 * Keyword commands + snapshot-driven rule-based commentary (no LLM).
 */
export class CompanionDialogue {
    /**
     * @param {import('../host/BotHost.ts').TrailmateHost} agent
     * @param {import('./ModeManager.js').ModeManager} manager
     * @param {object} companionConfig
     */
    constructor(agent, manager, companionConfig = {}) {
        this.agent = agent;
        this.manager = manager;
        this.companionConfig = companionConfig;
        this.config = { ...DEFAULT_CHAT_CONFIG, ...(companionConfig.chat || {}) };
        this.lastChatAt = 0;
        this.lastPlayerChatAt = 0;
        /** @type {Record<string, number>} */
        this.lastEventAt = {};
        this._prev = null;
        this._actionBusy = false;
        console.log('[companion] dialogue ready (keyword commands + rule commentary)');
    }

    get enabled() {
        return this.config.enabled !== false;
    }

    get isActionBusy() {
        return this._actionBusy;
    }

    _isItemTransferActive() {
        return Boolean(this.agent.companion?.ctx?.itemTransfer?.active);
    }

    /**
     * @param {string} username
     * @param {string} message
     */
    async handlePlayerMessage(username, message) {
        if (this.agent.shut_up) return false;
        if (this._actionBusy || this._isItemTransferActive()) return false;
        const now = Date.now();
        if (now - this.lastPlayerChatAt < this.config.player_reply_cooldown_ms) return false;

        const text = String(message || '').trim();
        if (!text) return false;

        const allowedIds = this.manager.getModeCatalog().map((m) => m.id);
        const command = classifyPlayerCommand(text, username, allowedIds);
        if (!command) return false;

        this.lastPlayerChatAt = now;
        await this._applyCommand(command);
        return true;
    }

    async maybeSpeak() {
        if (this.config.enabled === false) return;
        if (this.agent.shut_up) return;
        if (this._actionBusy || this._isItemTransferActive()) return;

        const snapshot = this._buildSnapshot();
        const dialogueConfig = this._dialogueConfig();
        let event = detectSituationEvent(this._prev, snapshot, this.config);
        this._prev = snapshot;

        if (!event) {
            event = detectCombatCommentary(snapshot);
            if (!event) event = detectIdleCommentary(snapshot, dialogueConfig);
            if (!event) return;
            const chance = event.id === 'combat_fighting'
                ? (this.config.combat_commentary_chance ?? 0.6)
                : this.config.idle_chance;
            if (Math.random() > chance) return;
        } else if (event.priority < 2 && Math.random() > this.config.spontaneous_chance) {
            return;
        }

        const now = Date.now();
        const minInterval = event.priority >= 2
            ? (this.config.priority_min_interval_ms ?? 15000)
            : this.config.min_interval_ms;
        if (now - this.lastChatAt < minInterval) return;
        if (now - this.lastPlayerChatAt < minInterval) return;
        if (now - (this.lastEventAt[event.id] || 0) < this.config.event_cooldown_ms) return;

        const isStuckEvent = event.id === 'stuck';
        if (!isStuckEvent) {
            const recovery = this.manager.interrupts?.find((i) => i.name === 'recovery');
            if (recovery && Date.now() < (recovery.cooldownUntil || 0)) return;
            if (this.agent.companion?.ctx?.movement?.isHeld) return;
        }

        this.lastEventAt[event.id] = now;

        const language = this.agent.language || 'ja';
        const message = renderCommentary(language, event.id, snapshot);
        if (!message) return;
        await this._say(message);
        if (isStuckEvent) {
            const ctx = this.agent.companion?.ctx;
            if (ctx) ctx.stuckChat = null;
        }
    }

    _dialogueConfig() {
        const cfg = this.companionConfig || {};
        return {
            follow_distance: cfg.follow_distance,
            owner_near_radius: cfg.owner_near_radius
        };
    }

    /**
     * @param {{ kind?: string, mode?: string, action?: string, owner: string|null, message: string, replies?: object }} command
     */
    async _applyCommand(command) {
        if (command.kind === 'action') {
            await this._applyAction(command);
            return;
        }

        const ctx = this.agent.companion?.ctx;
        const language = this.agent.language || 'ja';

        if (command.mode === 'follow' && command.owner && ctx) {
            lockOwner(ctx, command.owner);
        }

        if (command.mode) {
            await this.manager.switchMode(command.mode);
        }

        let message = command.message;
        if (command.mode === 'wait') {
            message = tCommand(language, 'wait');
        } else if (command.mode === 'follow') {
            const snap = this._buildSnapshot();
            message = tCommand(language, deriveFollowReplyKey(snap.followPhase));
        }

        if (message && !this.agent.shut_up) {
            await this._say(message);
        }
    }

    /**
     * @param {{ action: string, owner: string|null, message: string, replies?: object }} command
     */
    async _applyAction(command) {
        const language = this.agent.language || 'ja';
        if (command.action === 'set_spawnpoint') {
            await this._applySetSpawnpoint(command, language);
            return;
        }
        if (command.action !== 'give_all_items') return;

        const ctx = this.agent.companion?.ctx;
        if (!ctx || !command.owner || !isPlayerEligible(ctx, command.owner)) {
            await this._say(tCommand(language, 'give_all_unavailable'));
            return;
        }
        if (ctx.deathRecovery?.active || shouldDeferToCombat(ctx)) {
            await this._say(tCommand(language, 'give_all_unavailable'));
            return;
        }

        if (Object.keys(countAllItems(ctx.bot)).length === 0) {
            await this._say(tCommand(language, 'give_all_empty'));
            return;
        }

        this._actionBusy = true;
        this.manager.pause();
        this.agent.companion?.autoEquip?.pause?.();
        ctx.movement?.stop?.();

        try {
            await this._say(tCommand(language, 'give_all_ok'));
            const result = await giveAllItemsToPlayer(ctx, command.owner, {
                shouldAbort: () => ctx.deathRecovery?.active || shouldDeferToCombat(ctx)
            });
            if (result === 'empty') {
                await this._say(tCommand(language, 'give_all_empty'));
            } else if (result === 'unavailable' || result === 'deferred') {
                await this._say(tCommand(language, 'give_all_unavailable'));
            } else if (result === 'failed') {
                await this._say(tCommand(language, 'give_all_failed'));
            }
        } finally {
            const ms = ctx.config?.nearby_loot?.give_suppress_ms ?? DEFAULT_GIVE_SUPPRESS_MS;
            ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
            ctx.nearbyLoot.suppressUntil = Date.now() + ms;
            this.agent.companion?.autoEquip?.resume?.();
            this.manager.resume();
            this._actionBusy = false;
        }
    }

    /**
     * @param {{ message: string }} command
     * @param {string} language
     */
    async _applySetSpawnpoint(command, language) {
        const bot = this.agent.bot;
        const pos = bot?.entity?.position;
        if (!pos || typeof pos.x !== 'number') {
            await this._say(tCommand(language, 'spawnpoint_failed'));
            return;
        }

        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        const cmd = `/spawnpoint @s ${x} ${y} ${z}`;
        try {
            bot.chat(cmd);
            console.log(`[companion] set spawnpoint: ${cmd}`);
            await this._say(tCommand(language, 'spawnpoint_ok'));
        } catch (err) {
            console.warn('[companion] spawnpoint command failed:', err.message || err);
            await this._say(tCommand(language, 'spawnpoint_failed'));
        }
    }

    /**
     * @param {string} message
     */
    async _say(message) {
        const text = String(message || '').trim();
        if (!text || this.agent.shut_up) return;
        await this.agent.openChat(text);
        this.lastChatAt = Date.now();
    }

    _emptySnapshot(modeId) {
        return {
            mode: modeId,
            controlOwner: modeId === 'wait' ? 'wait' : 'follow',
            followPhase: null,
            owner: null,
            ownerVisible: false,
            ownerDistance: null,
            ownerEntityMissing: false,
            ownerHasLos: false,
            botPos: null,
            ownerPos: null,
            nearbyPlayers: [],
            health: null,
            hunger: null,
            foodCount: 0,
            torchCount: 0,
            timeOfDay: null,
            isNight: false,
            stuckSeconds: 0,
            stuckAlert: false,
            hostile: null,
            hostileBand: null,
            combatTarget: null,
            lastDamageTaken: 0,
            lastDamageAgeMs: null
        };
    }

    _buildSnapshot() {
        const ctx = this.agent.companion?.ctx;
        const bot = this.agent.bot;
        const mode = this.manager.getCurrentModeId();

        if (!ctx || !bot?.entity) {
            return this._emptySnapshot(mode);
        }

        const nearbyPlayers = (ctx.worldState.visiblePlayers || []).map((p) => ({
            name: p.name,
            distance: Number(p.distance.toFixed(1))
        }));

        let hostile = null;
        try {
            const enemy = getNearestEntityWhere(bot, (e) => isHostile(e), this.config.hostile_range);
            if (enemy) {
                hostile = {
                    name: enemy.name,
                    distance: Number(bot.entity.position.distanceTo(enemy.position).toFixed(1))
                };
            }
        } catch {
            hostile = null;
        }

        const timeOfDay = bot.time?.timeOfDay ?? 0;
        const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
        const lastDamageAgeMs = bot.lastDamageTime
            ? Date.now() - bot.lastDamageTime
            : null;

        const { foodCount, torchCount } = countSupplyItems(bot);
        const combatTarget = bot.pvp?.target?.name || hostile?.name || null;
        const hostileBand = hostile
            ? deriveHostileBand(
                hostile.distance,
                this.config.hostile_approach_distances
            )
            : null;

        const snap = {
            ...buildOwnerFollowFacts(ctx, mode),
            nearbyPlayers,
            health: bot.health,
            hunger: bot.food,
            foodCount,
            torchCount,
            timeOfDay,
            isNight,
            stuckSeconds: Number(
                (ctx.stuckChat?.seconds ?? ctx.stuck?.seconds ?? 0).toFixed(1)
            ),
            stuckAlert: Boolean(ctx.stuckChat),
            hostile,
            hostileBand,
            combatTarget,
            lastDamageTaken: bot.lastDamageTaken || 0,
            lastDamageAgeMs
        };

        const dialogueConfig = this._dialogueConfig();
        snap.followPhase = mode === 'follow'
            ? deriveFollowPhase(snap, dialogueConfig)
            : null;

        return snap;
    }
}
