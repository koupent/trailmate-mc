import { CompanionContext } from './CompanionContext.js';
import { WorldState } from './WorldState.js';
import { CompanionOrchestrator } from './stateMachine/CompanionOrchestrator.js';
import { FollowMode } from './modes/FollowMode.js';
import { WaitMode } from './modes/WaitMode.js';
import { OwnGraveInterrupt } from './interrupts/OwnGraveInterrupt.js';
import { DeathReturnInterrupt } from './interrupts/DeathReturnInterrupt.js';
import { NearbyLootInterrupt } from './interrupts/NearbyLootInterrupt.js';
import { RecoveryInterrupt } from './interrupts/RecoveryInterrupt.js';
import { AutoEquip } from './utils/AutoEquip.js';
import {
    ChestItemTransfer,
    createChestTransferConfig
} from './utils/ChestItemTransfer.js';
import { CompanionDialogue, DEFAULT_CHAT_CONFIG } from './CompanionDialogue.js';
import {
    DEFAULT_TORCH_LIGHT_THRESHOLD,
    enableCompanionBlockProtection
} from './blockProtection.js';
import { attachOwnerWorkTracker } from './ownerWorkTracker.js';
import { attachOwnerThreatTracker } from './ownerThreatTracker.js';
import {
    DEFAULT_EYE_CONTACT_CONFIG,
    EyeContactReaction
} from './eyeContact.js';

const DEFAULT_CONFIG = {
    scan_radius: 48,
    fov_degrees: 120,
    follow_distance: 3,
    follow_min_distance: 2,
    owner_near_radius: 12,
    stuck_detect_seconds: 1.5,
    tick_ms: 250,
    torch_light_threshold: DEFAULT_TORCH_LIGHT_THRESHOLD,
    awareness_radius: 12,
    owner_work: {
        enabled: true,
        all_players: true,
        fov_degrees: 100
    },
    eye_contact: { ...DEFAULT_EYE_CONTACT_CONFIG },
    death_return: {
        enabled: true,
        arrive_range: 3,
        timeout_ms: 90000,
        grave_wait_ms: 2500
    },
    own_grave: {
        enabled: true,
        interact_range: 3.5
    },
    nearby_loot: {
        enabled: true,
        radius: 12,
        recovery_radius: 12,
        recovery_capture_ms: 1000,
        recovery_deadline_ms: 12000,
        recovery_quiet_ms: 750,
        max_ms: 4000,
        quiet_ms: 400,
        grace_ms: 500,
        give_suppress_ms: 12000,
        collector_radius: 4,
        collector_enabled: true
    },
    item_share: createChestTransferConfig(),
    chat: { ...DEFAULT_CHAT_CONFIG }
};

/**
 * Swap the retention rules of a companion that is already in the world.
 *
 * Two copies of `item_share` exist once `startCompanion` has run: the one the
 * chest transfer reads when it plans a deposit, and the one on the context that
 * the dialogue reads when it decides what to ask the owner for. Both are live
 * objects, so replacing the `retention` block on each is the whole of "apply
 * without a respawn" — the next chest is planned under the new rules.
 *
 * @param {{ itemTransfer?: { config?: object }, ctx?: { config?: { item_share?: object } } }|null|undefined} companion
 * @param {import('./utils/retentionPolicy.js').RetentionPolicy} retention
 * @returns {boolean} whether a live companion took the change
 */
export function applyRetentionConfig(companion, retention) {
    if (!companion) return false;
    let applied = false;
    if (companion.itemTransfer?.config) {
        companion.itemTransfer.config.retention = retention;
        applied = true;
    }
    if (companion.ctx?.config?.item_share) {
        companion.ctx.config.item_share.retention = retention;
        applied = true;
    }
    return applied;
}

/**
 * @returns {import('./Mode.js').Mode[]}
 */
export function createCompanionModes() {
    return [
        new FollowMode(),
        new WaitMode()
    ];
}

/**
 * Boot the rule-based companion controller.
 * @param {import('../host/BotHost.ts').TrailmateHost} agent
 * @param {object} companionConfig
 */
export async function startCompanion(agent, companionConfig = {}, worldState = new WorldState()) {
    const config = {
        ...DEFAULT_CONFIG,
        ...companionConfig,
        chat: {
            ...DEFAULT_CONFIG.chat,
            ...(companionConfig.chat || {})
        },
        death_return: {
            ...DEFAULT_CONFIG.death_return,
            ...(companionConfig.death_return || {})
        },
        own_grave: {
            ...DEFAULT_CONFIG.own_grave,
            ...(companionConfig.own_grave || {})
        },
        nearby_loot: {
            ...DEFAULT_CONFIG.nearby_loot,
            ...(companionConfig.nearby_loot || {})
        },
        owner_work: {
            ...DEFAULT_CONFIG.owner_work,
            ...(companionConfig.owner_work || {})
        },
        eye_contact: {
            ...DEFAULT_CONFIG.eye_contact,
            ...(companionConfig.eye_contact || {})
        },
        item_share: createChestTransferConfig(companionConfig.item_share)
    };

    enableCompanionBlockProtection({
        torchLightThreshold: config.torch_light_threshold
    });

    const ctx = new CompanionContext(agent, worldState, config);
    worldState.observeActivities(ctx);
    attachOwnerWorkTracker(ctx);
    attachOwnerThreatTracker(ctx);
    // 通常ドロップは先に回収し、Recoveryの墓フェーズでは墓処理へ譲る。
    const interrupts = [
        new NearbyLootInterrupt(),
        new OwnGraveInterrupt(),
        new DeathReturnInterrupt(),
        new RecoveryInterrupt()
    ];
    const manager = new CompanionOrchestrator(ctx, agent, interrupts, 'follow');
    const autoEquip = new AutoEquip(agent);
    const dialogue = new CompanionDialogue(agent, manager, config);
    const eyeContact = new EyeContactReaction(config.eye_contact, {
        manager,
        dialogue
    });
    const itemTransfer = new ChestItemTransfer(config.item_share, {
        manager,
        autoEquip,
        dialogue
    });
    autoEquip.start();

    agent.companion = {
        ctx,
        manager,
        orchestrator: manager,
        autoEquip,
        dialogue,
        eyeContact,
        itemTransfer
    };
    itemTransfer.attach(ctx);

    const runLifecycle = (event) => manager.handleLifecycle(event).catch((err) => {
        console.error(`[companion] ${event} handler error:`, err);
    });
    ctx.bot.on('death', () => { void runLifecycle('death'); });
    ctx.bot.on('spawn', () => { void runLifecycle('respawn'); });
    await manager.handleLifecycle('spawn');

    console.log('[companion] started (fsm: follow/wait/combat/duty + auto-equip + chest-share + dialogue)');

    agent.companion._interval = setInterval(() => {
        if (agent.bot?.entity) void manager.tick();
    }, config.tick_ms);
}
