import { isHostile } from '../world/entities.js';
import { hasLineOfSight } from '../world/lineOfSight.js';
import {
    classifyPlayerCommand,
    detectSituationEvent,
    deriveFollowPhase,
    deriveFollowReplyKey,
    deriveHostileBand,
    renderCommentary
} from './dialogueParse.js';
import { buildOwnerFollowFacts, isPlayerEligible, lockOwner } from './ownerLock.js';
import { giveAllItemsToPlayer, countAllItems } from './utils/giveAllItems.js';
import { snapshotInventoryFill } from './utils/inventorySnapshot.js';
import {
    DEFAULT_INVENTORY_FILL_REARM_SLOTS,
    DEFAULT_INVENTORY_FILL_THRESHOLDS,
    InventoryFillTracker
} from './utils/InventoryFillTracker.js';
import { listRetentionStock } from './utils/itemRetention.js';
import { SupplyRequestTracker } from './utils/SupplyRequestTracker.js';
import { tCommand } from '../i18n/index.js';
import { shouldDeferToCombat } from './combatGate.js';
import { DEFAULT_GIVE_SUPPRESS_MS } from './utils/nearbyLootConstants.js';
import { generateClaudeLine, isWeatherGrounded } from './claudeChat.js';
import { ClaudeChatBudget } from './ClaudeChatBudget.js';
import { companionMemory, materialGoal, MEMORY_FIELDS, normalizeMemoryNotes } from './memory.js';

/** Repeat window for a capability notice with the same key. */
export const DEFAULT_NOTICE_COOLDOWN_MS = 30000;

export const DEFAULT_CHAT_CONFIG = {
    enabled: true,
    min_interval_ms: 45000,
    priority_min_interval_ms: 15000,
    event_cooldown_ms: 120000,
    player_reply_cooldown_ms: 1500,
    spontaneous_chance: 0.85,
    low_health: 8,
    stuck_seconds: 5,
    hostile_range: 12,
    hostile_approach_distances: [10, 6, 3],
    inventory_fill_thresholds: [...DEFAULT_INVENTORY_FILL_THRESHOLDS],
    inventory_fill_rearm_slots: DEFAULT_INVENTORY_FILL_REARM_SLOTS
};

/**
 * Keyword commands and snapshot-driven commentary, with optional Claude chat.
 */
export class CompanionDialogue {
    /**
     * @param {import('../host/BotHost.ts').TrailmateHost} agent
     * @param {import('./ModeManager.js').ModeManager} manager
     * @param {object} companionConfig
     */
    constructor(agent, manager, companionConfig = {}, memory = companionMemory) {
        this.agent = agent;
        this.manager = manager;
        this.companionConfig = companionConfig;
        this.memory = memory;
        this.config = { ...DEFAULT_CHAT_CONFIG, ...(companionConfig.chat || {}) };
        this._claudeKey = process.env.ANTHROPIC_API_KEY?.trim();
        this._claudeBudget = this._claudeKey ? new ClaudeChatBudget() : null;
        this._claudeRequest = null;
        this._claudeRetryAt = 0;
        this._lastReplyAt = 0;
        this._lastCommentaryAt = -Infinity;
        this._lastCommentaryAttemptAt = -Infinity;
        this._recentCommentary = [];
        this._conversation = null;
        this.lastChatAt = 0;
        this.lastPlayerChatAt = 0;
        /** @type {Record<string, number>} */
        this.lastEventAt = {};
        this.inventoryFillTracker = new InventoryFillTracker({
            thresholds: this.config.inventory_fill_thresholds,
            rearmSlots: this.config.inventory_fill_rearm_slots
        });
        this.supplyRequestTracker = new SupplyRequestTracker();
        this._lastInventoryFillMessage = '';
        this._prev = null;
        this._actionBusy = false;
        /** @type {Record<string, number>} last time each capability notice was spoken */
        this._lastNoticeAt = {};
        console.log(`[companion] dialogue ready (Claude chat ${this._claudeKey ? 'enabled' : 'disabled'})`);
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

    /** Retention targets shared with the chest / periodic transfers. */
    _retentionPolicy() {
        return this.companionConfig?.item_share || {};
    }

    /** @returns {ReturnType<typeof listRetentionStock>} */
    _readRetentionStock() {
        return listRetentionStock(this.agent.bot, this._retentionPolicy());
    }

    /**
     * Shortage readings are meaningless while a flow that legitimately empties
     * the inventory is running, so the tracker keeps its previous reading.
     */
    _isSupplyObservationHeld() {
        if (!this.agent.bot?.inventory) return true;
        if (this._actionBusy || this._isItemTransferActive()) return true;
        const ctx = this.agent.companion?.ctx;
        return Boolean(
            ctx?.deathRecovery?.pending
            || ctx?.deathRecovery?.active
            || ctx?.graveLoot?.active
        );
    }

    /** Queue newly missing supplies, or keep the queue as-is while held. */
    _observeSupplyRequest() {
        if (this._isSupplyObservationHeld()) return this.supplyRequestTracker.peek();
        return this.supplyRequestTracker.observe(this._readRetentionStock());
    }

    /**
     * @param {string} username
     * @param {string} message
     * @param {boolean} [publicChat]
     */
    async handlePlayerMessage(username, message, publicChat = false) {
        if (this.agent.shut_up) return false;
        if (this._actionBusy || this._isItemTransferActive()) return false;
        const now = Date.now();
        if (now - this.lastPlayerChatAt < this.config.player_reply_cooldown_ms) return false;

        const text = String(message || '').trim();
        if (!text) return false;

        if (publicChat && this.enabled) {
            const addressed = /^@([a-z0-9_]+)[\s:：]+(.+)$/is.exec(text);
            const botName = this.agent.bot?.username || this.agent.name;
            if (addressed && addressed[1].toLowerCase() === botName?.toLowerCase()) {
                const question = addressed[2].trim().slice(0, 300);
                return question ? this._replyToPlayer(username, question, now) : false;
            }
        }

        const allowedIds = this.manager.getModeCatalog().map((m) => m.id);
        const command = classifyPlayerCommand(text, username, allowedIds);
        if (!command) return false;

        this.lastPlayerChatAt = now;
        await this._applyCommand(command);
        return true;
    }

    async _replyToPlayer(username, message, now) {
        this._claudeBudget?.refresh(now);
        const fraction = this._claudeBudget?.speechFraction ?? 1;
        if (!fraction || !this._canSendChat()) return false;
        if (now - this._lastReplyAt < this.config.player_reply_cooldown_ms / fraction) return false;
        this._lastReplyAt = now;
        const { lastPlayerChatAt } = this;
        const history = fraction >= 0.25 && this._conversation?.username === username
            ? this._conversation.history : [];
        const language = this.agent.language || 'ja';
        const fallback = tCommand(language, 'reply_unavailable');
        const plan = materialGoal(message);
        let remembered;
        let proposal;
        if (plan || this._canGenerate(now)) {
            try { remembered = this.memory.get(username); }
            catch { console.warn('[companion] could not read player memory'); }
        }
        const reply = await this._composeLine(this._buildSnapshot(), {
            history, message, recipient: username, required: true,
            memory: remembered?.notes,
            onMemory: update => { proposal = update; }
        }, fallback);
        if (this._claudeBudget?.speechFraction === 0 || this.lastPlayerChatAt !== lastPlayerChatAt
            || !this._canSendChat() || this._lastReplyAt !== now) return false;

        const candidate = proposal && MEMORY_FIELDS.includes(proposal.field)
            ? normalizeMemoryNotes({ [proposal.field]: proposal.note })
            : null;
        let memorySaved = false;
        if (plan || (candidate && Object.keys(candidate).length)) {
            const notes = { ...remembered?.notes, ...(plan && { plans: plan }), ...candidate };
            const revision = remembered?.revision ?? 0;
            try {
                const saved = this.memory.save(username, notes, revision);
                memorySaved = Boolean(saved && saved.revision > revision);
            }
            catch { console.warn('[companion] could not save player memory'); }
        }
        let spokenReply = reply;
        if (memorySaved) {
            const confirmation = tCommand(language, 'memory_saved');
            spokenReply = reply === fallback ? confirmation : reply + ' ' + confirmation;
        }
        await this._say(spokenReply);
        if (reply !== fallback) {
            this._conversation = {
                username,
                history: [...history.slice(-2), { role: 'user', content: message }, { role: 'assistant', content: reply }]
            };
        }
        return true;
    }

    _canSendChat() {
        return this.enabled && !this.agent.shut_up && !this._actionBusy
            && !this._isItemTransferActive() && this.agent.companion?._interval
            && this.agent.bot?.entity && this.agent.bot.health > 0;
    }

    _localRain() {
        return this.agent.companion?.ctx?.worldState?.getLocalRain?.(this.agent.bot);
    }

    _canGenerate(now) {
        return Boolean(this._claudeBudget?.fraction && now >= this._claudeRetryAt);
    }

    async _composeLine(snapshot, input, fallback) {
        const now = Date.now();
        this._claudeBudget?.refresh(now);
        if (this._canGenerate(now) && input.required) {
            while (this._claudeRequest) await this._claudeRequest;
        }
        if (!this._canGenerate(Date.now()) || this._claudeRequest || !this.enabled || this.agent.shut_up) return fallback;

        snapshot ??= this._buildSnapshot();
        const language = this.agent.language || 'ja';
        const maxTokens = Math.round(60 + 60 * this._claudeBudget.fraction);
        this._claudeRequest = generateClaudeLine(this._claudeKey, language, snapshot, { ...input, maxTokens })
            .catch((error) => {
                this._claudeRetryAt = Date.now() + 60000;
                console.warn(`[companion] Claude chat unavailable (${error.name === 'Error' && /^HTTP \d{3}$/.test(error.message) ? error.message : 'request failed'})`);
                return '';
            }).finally(() => {
                this._claudeRequest = null;
            });
        const line = await this._claudeRequest;
        if (line === null) return '';
        const rain = this._localRain();
        return this._claudeBudget.fraction && line
            && isWeatherGrounded(line, language, rain === undefined ? snapshot.isRaining : rain, input.event)
            ? line : fallback;
    }

    async maybeSpeak() {
        if (this.config.enabled === false) return;
        if (this.agent.shut_up) return;
        this._claudeBudget?.refresh(Date.now());

        const now = Date.now();
        const snapshot = this._buildSnapshot(true);
        const world = this.agent.companion?.ctx?.worldState;
        const recent = world?.recentObservations?.(now, true) ?? [];
        const situation = detectSituationEvent(this._prev, snapshot, this.config);
        this._prev = snapshot;

        const incoming = (snapshot.activity?.commentary ?? []).map((entry) => ({ ...entry, priority: 0 }));
        const verifiedDamage = recent.some((entry) => entry.cooldownKey === 'companion_took_damage'
            && now - entry.seenAt < 1000);
        if (snapshot.nearbyPlayers.length && situation && !recent.some((entry) => entry.id === situation.id)
            && !(situation.cooldownKey === 'companion_took_damage' && verifiedDamage)) incoming.push(situation);
        const observations = [...recent, ...incoming.map((entry) => world?.observe?.(entry, now) ?? entry)];
        if (this._actionBusy || this._isItemTransferActive()) return;
        const inventoryFillEvent = this.inventoryFillTracker.observe(snapshot);
        const supplyRequestEvent = this._observeSupplyRequest();
        if (!snapshot.nearbyPlayers.length) return;

        const fraction = this._claudeBudget?.speechFraction ?? 1;
        const quietInterval = this.config.priority_min_interval_ms;
        const lastConversationAt = Math.max(this.lastChatAt, this.lastPlayerChatAt, this._lastReplyAt);
        const useClaude = this._canGenerate(now) && this._canSendChat();
        const minIntervalFor = (event, operational) => event.priority >= 2 ? quietInterval
            : this.config.min_interval_ms / (operational ? 1 : fraction);
        const eligible = (event) => {
            if (!event || event.handled || event.speechPending || !this._isCurrentObservation(event, snapshot)) return false;
            if (event.recipient && !snapshot.nearbyPlayers.some((player) => player.name === event.recipient)) return false;
            if (event.reaction) return true;
            const operational = Boolean(event.inventoryFill || event.supplyCategories);
            if (!operational && event.priority < 2 && !fraction) return false;
            const minInterval = minIntervalFor(event, operational);
            return now - lastConversationAt >= (operational ? minInterval : quietInterval)
                && (operational || now - this._lastCommentaryAt >= minInterval)
                && now - (this.lastEventAt[event.cooldownKey ?? event.id] ?? -Infinity) >= this.config.event_cooldown_ms
                && (!useClaude || (!this._claudeRequest && now - this._lastCommentaryAttemptAt >= minInterval));
        };
        const candidates = observations.filter(eligible)
            .sort((a, b) => Number(Boolean(b.reaction)) - Number(Boolean(a.reaction))
                || b.priority - a.priority || (b.seenAt ?? now) - (a.seenAt ?? now));
        const immediate = candidates.find((entry) => entry.reaction || entry.priority >= 2);
        const event = immediate || [inventoryFillEvent, supplyRequestEvent].find(eligible) || candidates[0];
        if (!event) return;
        const recipient = event.recipient
            ? snapshot.nearbyPlayers.find((player) => player.name === event.recipient)
            : snapshot.nearbyPlayers[0];

        const operational = Boolean(event.inventoryFill || event.supplyCategories);
        const urgent = event.priority >= 2;
        const reaction = event.reaction === true;
        const casual = !urgent && !operational && !reaction;
        const cooldownKey = event.cooldownKey ?? event.id;

        const isStuckEvent = event.id === 'stuck';
        const language = this.agent.language || 'ja';
        const inventoryFill = event.inventoryFill;
        const renderSnapshot = { ...snapshot };
        if (event.target) renderSnapshot.combatTarget = event.target;
        if (inventoryFill) {
            renderSnapshot.inventoryFillPercent = inventoryFill.percent;
            renderSnapshot.inventoryUsedSlots = inventoryFill.usedSlots;
            renderSnapshot.inventoryTotalSlots = inventoryFill.totalSlots;
            renderSnapshot.inventoryEmptySlots = inventoryFill.emptySlots;
        }
        if (event.supplyCategories) {
            renderSnapshot.supplyCategories = event.supplyCategories;
        }
        const message = renderCommentary(language, event.id, renderSnapshot, {
            excludeMessage: inventoryFill ? this._lastInventoryFillMessage : '',
            fallback: false
        });
        const address = !operational ? `@${recipient.name}${language === 'ja' ? '、' : ', '}` : '';
        const deliver = async (reply) => {
            if (!reply) return;
            await this._say(address + reply);
            this.lastEventAt[cooldownKey] = Date.now();
            if (!operational && !reaction) this._lastCommentaryAt = this.lastEventAt[cooldownKey];
            if (!operational) this._recentCommentary = [...this._recentCommentary.slice(-1), reply];
            if (inventoryFill) {
                this._lastInventoryFillMessage = reply;
                this.inventoryFillTracker.markDelivered();
            }
            if (event.supplyCategories) this.supplyRequestTracker.markDelivered();
            if (isStuckEvent && this.agent.companion?.ctx) this.agent.companion.ctx.stuckChat = null;
        };
        if (casual && Math.random() > (event.chance ?? this.config.spontaneous_chance)) {
            event.handled = true;
            return;
        }
        if (useClaude) {
            event.speechPending = true;
            const { lastChatAt, lastPlayerChatAt, _lastReplyAt } = this;
            // Generation never holds movement. A completed action has its own response,
            // while ambient comments can go stale when a newer conversation begins.
            void this._composeLine({ ...renderSnapshot, observations }, {
                event: event.id,
                eventDetail: event.text ?? (operational ? message : undefined),
                required: operational || reaction,
                actionFacts: event.actionFacts,
                actorIsAddressee: event.recipient === recipient.name || undefined,
                recipient: recipient.name,
                recentCommentary: this._recentCommentary
            }, message).then(async (line) => {
                if ((casual && !this._claudeBudget.speechFraction) || !this._canSendChat()) return;
                if (!reaction && (this.lastChatAt !== lastChatAt
                    || this.lastPlayerChatAt !== lastPlayerChatAt || this._lastReplyAt !== _lastReplyAt)) return;
                const nearby = this.agent.companion?.ctx?.worldState?.nearbyPlayers;
                if (!nearby?.some((player) => player.name === recipient.name)) return;
                const observedRain = this._localRain();
                const latest = this._prev || snapshot;
                if (!this._isCurrentObservation(event, observedRain === undefined
                    ? latest : { ...latest, isRaining: observedRain })) return;
                if (!reaction) this._lastCommentaryAttemptAt = now;
                if (reaction) {
                    event.handled = true;
                } else if (!operational) {
                    // Claude has already considered this batch, including when it chose silence.
                    for (const entry of observations) if (!entry.reaction) entry.handled = true;
                }
                await deliver(line);
            }).catch(() => console.warn('[companion] failed to send Claude commentary')).finally(() => {
                event.speechPending = false;
            });
            return;
        }
        if (!operational) event.handled = true;
        await deliver(message);
    }

    _isCurrentObservation(event, snapshot) {
        switch (event.id) {
        case 'rain_started': return snapshot.isRaining === true;
        case 'rain_stopped': return snapshot.isRaining === false;
        case 'night': return snapshot.isNight === true;
        case 'day': return snapshot.isNight === false;
        default: return true;
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
        if (command.mode === 'follow' && command.owner && ctx) {
            lockOwner(ctx, command.owner);
        }

        if (command.mode) {
            await this.manager.switchMode(command.mode);
        }

        if (command.mode === 'wait') {
            await this._speakOutcome('wait');
        } else if (command.mode === 'follow') {
            const snap = this._buildSnapshot();
            await this._speakOutcome(deriveFollowReplyKey(snap.followPhase));
        }
    }

    /**
     * @param {{ action: string, owner: string|null, message: string, replies?: object }} command
     */
    async _applyAction(command) {
        if (command.action === 'set_spawnpoint') {
            await this._applySetSpawnpoint();
            return;
        }
        if (command.action !== 'give_all_items') return;

        const ctx = this.agent.companion?.ctx;
        if (!ctx || !command.owner || !isPlayerEligible(ctx, command.owner)) {
            await this._speakOutcome('give_all_unavailable');
            return;
        }
        if (ctx.deathRecovery?.active || shouldDeferToCombat(ctx)) {
            await this._speakOutcome('give_all_unavailable');
            return;
        }

        if (Object.keys(countAllItems(ctx.bot)).length === 0) {
            await this._speakOutcome('give_all_empty');
            return;
        }

        this._actionBusy = true;
        this.manager.pause();
        this.agent.companion?.autoEquip?.pause?.();
        ctx.movement?.stop?.();

        const acknowledgement = this._speakOutcome('give_all_ok')
            .catch(() => console.warn('[companion] item transfer acknowledgement failed'));
        let result;
        try {
            result = await giveAllItemsToPlayer(ctx, command.owner, {
                shouldAbort: () => ctx.deathRecovery?.active || shouldDeferToCombat(ctx)
            });
        } finally {
            // Whatever the sweep handed over is expected, not a shortage to report.
            if (this.agent.bot?.inventory) {
                this.supplyRequestTracker.acknowledge(this._readRetentionStock());
            }
            const ms = ctx.config?.nearby_loot?.give_suppress_ms ?? DEFAULT_GIVE_SUPPRESS_MS;
            ctx.nearbyLoot = ctx.nearbyLoot || { active: false, suppressUntil: 0 };
            ctx.nearbyLoot.suppressUntil = Date.now() + ms;
            this.agent.companion?.autoEquip?.resume?.();
            this.manager.resume();
            this._actionBusy = false;
        }
        await acknowledgement;
        if (result === 'empty') {
            await this._speakOutcome('give_all_empty');
        } else if (result === 'unavailable' || result === 'deferred') {
            await this._speakOutcome('give_all_unavailable');
        } else if (result === 'failed') {
            await this._speakOutcome('give_all_failed');
        }
    }

    async _applySetSpawnpoint() {
        const bot = this.agent.bot;
        const pos = bot?.entity?.position;
        if (!pos || typeof pos.x !== 'number') {
            await this._speakOutcome('spawnpoint_failed');
            return;
        }

        const x = Math.floor(pos.x);
        const y = Math.floor(pos.y);
        const z = Math.floor(pos.z);
        const cmd = `/spawnpoint @s ${x} ${y} ${z}`;
        try {
            bot.chat(cmd);
            console.log(`[companion] set spawnpoint: ${cmd}`);
        } catch (err) {
            console.warn('[companion] spawnpoint command failed:', err.message || err);
            await this._speakOutcome('spawnpoint_failed');
            return;
        }
        await this._speakOutcome('spawnpoint_ok');
    }

    /**
     * Speak on behalf of another capability (chest transfer, ...). Capabilities
     * report outcomes that can repeat for as long as their cause lasts, so the
     * same key is held back until its cooldown passes.
     *
     * @param {string} key command locale key
     * @param {import('../i18n/index.js').CommentaryVars} [vars]
     * @param {{ now?: number, cooldownMs?: number }} [options]
     * @returns {Promise<boolean>} whether the line was spoken
     */
    async speakNotice(key, vars = {}, options = {}) {
        if (!this.enabled || this.agent.shut_up) return false;
        const now = options.now ?? Date.now();
        const cooldownMs = options.cooldownMs ?? DEFAULT_NOTICE_COOLDOWN_MS;
        const lastAt = this._lastNoticeAt[key];
        if (lastAt != null && now - lastAt < cooldownMs) return false;

        this._lastNoticeAt[key] = now;
        return this._speakOutcome(key, vars);
    }

    async _speakOutcome(key, vars = {}) {
        if (!this.enabled || this.agent.shut_up) return false;
        const fallback = tCommand(this.agent.language || 'ja', key, vars);
        if (!fallback || fallback === key) return false;
        const line = await this._composeLine(null, { event: key, eventDetail: fallback, required: true }, fallback);
        if (!this.enabled || this.agent.shut_up || !line) return false;
        await this._say(line);
        return true;
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
            inventoryUsedSlots: 0,
            inventoryTotalSlots: 36,
            inventoryEmptySlots: 36,
            inventoryFillPercent: 0,
            timeOfDay: null,
            isNight: null,
            isRaining: null,
            stuckSeconds: 0,
            stuckAlert: false,
            hostile: null,
            hostileBand: null,
            combatTarget: null,
            lastDamageTaken: 0,
            lastDamageAgeMs: null
        };
    }

    _buildSnapshot(consumeCommentary = false) {
        const ctx = this.agent.companion?.ctx;
        const bot = this.agent.bot;
        const mode = this.manager.getCurrentModeId();

        if (!ctx || !bot?.entity) {
            return this._emptySnapshot(mode);
        }

        const nearbyPlayers = (ctx.worldState.nearbyPlayers || []).map((p) => ({
            name: p.name,
            distance: Number(p.distance.toFixed(1))
        }));

        let hostile = null;
        try {
            const enemy = bot.nearestEntity((e) => isHostile(e)
                && bot.entity.position.distanceTo(e.position) <= this.config.hostile_range && hasLineOfSight(bot, e));
            if (enemy) {
                hostile = {
                    name: enemy.name,
                    distance: Number(bot.entity.position.distanceTo(enemy.position).toFixed(1))
                };
            }
        } catch {
            hostile = null;
        }

        const timeOfDay = bot.time?.timeOfDay ?? null;
        const isNight = timeOfDay == null ? null : timeOfDay >= 13000 && timeOfDay < 23000;
        const lastDamageAgeMs = bot.lastDamageTime
            ? Date.now() - bot.lastDamageTime
            : null;

        const inventoryFill = snapshotInventoryFill(bot);
        const combatTarget = bot.pvp?.target?.name || null;
        const hostileBand = hostile
            ? deriveHostileBand(
                hostile.distance,
                this.config.hostile_approach_distances
            )
            : null;

        const snap = {
            ...buildOwnerFollowFacts(ctx, mode),
            activity: consumeCommentary ? this.manager.describeDialogueActivity?.({ consumeCommentary }) : undefined,
            observations: ctx.worldState.recentObservations?.(Date.now(), !consumeCommentary) ?? [],
            location: ctx.worldState.describeLocation?.(bot),
            nearbyPlayers,
            health: bot.health,
            hunger: bot.food,
            ...inventoryFill,
            timeOfDay,
            isNight,
            isRaining: this._localRain() ?? null,
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
