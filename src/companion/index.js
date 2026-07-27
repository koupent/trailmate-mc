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
import { CompanionDialogue, DEFAULT_CHAT_CONFIG } from './CompanionDialogue.js';
import { applyJumpHitboxFix } from './hitboxFix.js';
import {
    beginDeathReturnAfterSpawn,
    captureDeathState
} from './deathRecovery.js';
import {
    DEFAULT_TORCH_LIGHT_THRESHOLD,
    enableCompanionBlockProtection
} from './blockProtection.js';

const DEFAULT_CONFIG = {
    scan_radius: 48,
    fov_degrees: 120,
    follow_distance: 3,
    follow_min_distance: 2,
    owner_near_radius: 12,
    stuck_detect_seconds: 1.5,
    tick_ms: 250,
    torch_light_threshold: DEFAULT_TORCH_LIGHT_THRESHOLD,
    death_return: {
        enabled: true,
        arrive_range: 3,
        timeout_ms: 90000
    },
    own_grave: {
        enabled: true,
        scan_radius: 10,
        dig_range: 3.5
    },
    nearby_loot: {
        enabled: true,
        radius: 8,
        max_ms: 15000,
        quiet_ms: 1500,
        grace_ms: 2500,
        owner_clearance: 8,
        give_suppress_ms: 12000
    },
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
        }
    };

    enableCompanionBlockProtection({
        torchLightThreshold: config.torch_light_threshold
    });

    const worldState = new WorldState();
    const ctx = new CompanionContext(agent, worldState, config);
    const modes = createCompanionModes();
    // Nearby loot before grave dig so scattered drops are not abandoned for the next grave.
    const interrupts = [
        new NearbyLootInterrupt(),
        new OwnGraveInterrupt(),
        new DeathReturnInterrupt(),
        new RecoveryInterrupt()
    ];
    const manager = new ModeManager(ctx, modes, interrupts, 'follow');
    const autoEquip = new AutoEquip(agent);
    const dialogue = new CompanionDialogue(agent, manager, config);
    autoEquip.start();

    agent.companion = {
        ctx,
        manager,
        autoEquip,
        dialogue
    };

    await manager.start();
    await applyJumpHitboxFix(agent.bot);
    wireDeathRecovery(agent, ctx, config);

    console.log('[companion] started (follow + wait + death-return + own-grave + nearby-loot + recovery + auto-equip + dialogue)');

    const loop = async () => {
        if (!agent.bot || agent.bot.entity == null) return;
        await manager.tick();
        await autoEquip.maybeRun(ctx);
        if (!ctx.holdReflexes) {
            try {
                await agent.reflexes?.tick?.({
                    movementHeld: !!ctx.movement?.isHeld,
                    isIdleish: manager.getCurrentModeId() === 'follow' || manager.getCurrentModeId() === 'wait',
                    owner: ctx.ownerEntity ?? null
                });
            } catch (err) {
                console.error('[companion] reflexes error:', err);
            }
        }
        try {
            await dialogue.maybeSpeak();
        } catch (err) {
            console.error('[companion] dialogue loop error:', err);
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
                        await agent.openChat?.(
                            `死亡地点へ戻るよ (${Math.floor(ctx.deathRecovery.deathPos.x)}, ${Math.floor(ctx.deathRecovery.deathPos.y)}, ${Math.floor(ctx.deathRecovery.deathPos.z)})`
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
