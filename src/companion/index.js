import { CompanionContext } from './CompanionContext.js';
import { WorldState } from './WorldState.js';
import { ModeManager } from './ModeManager.js';
import { FollowMode } from './modes/FollowMode.js';
import { WaitMode } from './modes/WaitMode.js';
import { RecoveryInterrupt } from './interrupts/RecoveryInterrupt.js';
import { AutoEquip } from './utils/AutoEquip.js';
import { CompanionDialogue, DEFAULT_CHAT_CONFIG } from './CompanionDialogue.js';
import { applyJumpHitboxFix } from './hitboxFix.js';
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
        }
    };

    enableCompanionBlockProtection({
        torchLightThreshold: config.torch_light_threshold
    });

    const worldState = new WorldState();
    const ctx = new CompanionContext(agent, worldState, config);
    const modes = createCompanionModes();
    const interrupts = [new RecoveryInterrupt()];
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

    console.log('[companion] started (follow + wait + recovery + auto-equip + dialogue)');

    const loop = async () => {
        if (!agent.bot || agent.bot.entity == null) return;
        await manager.tick();
        await autoEquip.maybeRun(ctx);
        try {
            await agent.reflexes?.tick?.({
                movementHeld: !!ctx.movement?.isHeld,
                isIdleish: manager.getCurrentModeId() === 'follow' || manager.getCurrentModeId() === 'wait'
            });
        } catch (err) {
            console.error('[companion] reflexes error:', err);
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
