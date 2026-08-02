import { CompanionContext } from './CompanionContext.js';
import { WorldState } from './WorldState.js';
import { ModeManager } from './ModeManager.js';
import { FollowMode } from './modes/FollowMode.js';
import { WaitMode } from './modes/WaitMode.js';
import { OwnGraveInterrupt } from './interrupts/OwnGraveInterrupt.js';
import { DeathReturnInterrupt } from './interrupts/DeathReturnInterrupt.js';
import { NearbyLootInterrupt } from './interrupts/NearbyLootInterrupt.js';
import { RecoveryInterrupt } from './interrupts/RecoveryInterrupt.js';
import { AutoEquip } from './utils/AutoEquip.js';
import { PeriodicItemTransfer, createItemShareConfig } from './utils/PeriodicItemTransfer.js';
import { CompanionDialogue, DEFAULT_CHAT_CONFIG } from './CompanionDialogue.js';
import { applyJumpHitboxFix } from './hitboxFix.js';
import { findOwnGravesNear } from '../world/graves.js';
import {
    beginDeathReturnAfterSpawn,
    captureDeathState
} from './deathRecovery.js';
import { needsGearRecovery, shouldDeferRecoveryForCombat } from './combatGate.js';
import {
    DEFAULT_TORCH_LIGHT_THRESHOLD,
    enableCompanionBlockProtection
} from './blockProtection.js';
import { attachOwnerWorkTracker } from './ownerWorkTracker.js';
import { tCommand } from '../i18n/index.js';
import { attachOwnerThreatTracker, getActiveOwnerThreat } from './ownerThreatTracker.js';

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
        fov_degrees: 100,
        swing_idle_ms: 1000,
        post_work_cooldown_ms: 4000
    },
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
    item_share: createItemShareConfig(),
    chat: { ...DEFAULT_CHAT_CONFIG }
};

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
export async function startCompanion(agent, companionConfig = {}) {
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
        item_share: createItemShareConfig(companionConfig.item_share)
    };

    enableCompanionBlockProtection({
        torchLightThreshold: config.torch_light_threshold
    });

    const worldState = new WorldState();
    const ctx = new CompanionContext(agent, worldState, config);
    attachOwnerWorkTracker(ctx);
    attachOwnerThreatTracker(ctx);
    const modes = createCompanionModes();
    // 通常ドロップは先に回収し、Recoveryの墓フェーズでは墓処理へ譲る。
    const interrupts = [
        new NearbyLootInterrupt(),
        new OwnGraveInterrupt(),
        new DeathReturnInterrupt(),
        new RecoveryInterrupt()
    ];
    const manager = new ModeManager(ctx, modes, interrupts, 'follow');
    const autoEquip = new AutoEquip(agent);
    const dialogue = new CompanionDialogue(agent, manager, config);
    const itemTransfer = new PeriodicItemTransfer(config.item_share, {
        manager,
        autoEquip,
        dialogue
    });
    autoEquip.start();

    agent.companion = {
        ctx,
        manager,
        autoEquip,
        dialogue,
        itemTransfer,
        _loopBusy: false
    };

    await manager.start();
    await applyJumpHitboxFix(agent.bot);
    wireDeathRecovery(agent, ctx, config);

    console.log('[companion] started (follow + wait + death-return + own-grave + nearby-loot + recovery + auto-equip + item-share + dialogue)');

    const loop = async () => {
        if (!agent.bot || agent.bot.entity == null) return;

        const graveRadius = config.own_grave?.scan_radius ?? 10;
        const recoveryActive = Boolean(ctx.deathRecovery?.active);
        const recoveryDeferCombat = recoveryActive && shouldDeferRecoveryForCombat(ctx);
        const preferGearRecovery = !recoveryActive && needsGearRecovery(agent.bot)
            && findOwnGravesNear(agent.bot, agent.bot.username, graveRadius).length > 0;

        // 回収・墓割り込みが他処理を止めていても、戦闘tickは必ず実行する。
        try {
            await agent.reflexes?.tick?.({
                movementHeld: !!ctx.movement?.isHeld,
                isIdleish: manager.getCurrentModeId() === 'follow' || manager.getCurrentModeId() === 'wait',
                nonCombatHeld: !!ctx.holdReflexes || preferGearRecovery,
                preferGearRecovery,
                recoveryDeferCombat,
                recovery: ctx.deathRecovery,
                owner: ctx.ownerEntity ?? null,
                ownerThreat: getActiveOwnerThreat(ctx),
                movement: ctx.movement
            });
        } catch (err) {
            console.error('[companion] reflexes error:', err);
        }

        if (agent.companion._loopBusy) return;
        agent.companion._loopBusy = true;
        try {
            await manager.tick();
            await autoEquip.maybeRun(ctx);
            try {
                await itemTransfer.maybeRun(ctx);
            } catch (err) {
                console.error('[companion] item-share error:', err);
            }
            try {
                await dialogue.maybeSpeak();
            } catch (err) {
                console.error('[companion] dialogue loop error:', err);
            }
        } finally {
            agent.companion._loopBusy = false;
        }
    };

    agent.companion._interval = setInterval(() => {
        loop().catch((err) => console.error('[companion] loop error:', err));
    }, config.tick_ms);

    await autoEquip.equipBest();
}

/**
 * Record death coordinates and resume return-to-death after respawn.
 * startCompanion runs after the first spawn, so later `spawn` events are respawns.
 * @param {import('../host/BotHost.ts').TrailmateHost} agent
 * @param {import('./CompanionContext.js').CompanionContext} ctx
 * @param {object} config
 */
function wireDeathRecovery(agent, ctx, config) {
    const bot = agent.bot;

    bot.on('death', () => {
        try {
            captureDeathState(ctx);
            const pos = ctx.deathRecovery.deathPos;
            console.log(
                '[companion] death recorded',
                pos
                    ? `at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
                    : '(no position)'
            );
        } catch (err) {
            console.error('[companion] death handler error:', err);
        }
    });

    bot.on('spawn', () => {
        void (async () => {
            try {
                if (ctx.stuck?.reset && bot.entity?.position) {
                    ctx.stuck.reset(bot.entity.position);
                }
                beginDeathReturnAfterSpawn(ctx, config);
                if (ctx.deathRecovery?.active) {
                    console.log('[companion] death return started after respawn');
                    try {
                        const pos = ctx.deathRecovery.deathPos;
                        await agent.openChat?.(
                            tCommand(agent.language || 'ja', 'death_return_start', {
                                x: Math.floor(pos.x),
                                y: Math.floor(pos.y),
                                z: Math.floor(pos.z)
                            })
                        );
                    } catch {
                        /* ignore */
                    }
                }
                await applyJumpHitboxFix(bot);
            } catch (err) {
                console.error('[companion] respawn handler error:', err);
            }
        })();
    });
}
