/**
 * Transition predicates mirroring ControlPriority + combatGate.
 */

import {
    hasProtectThreats,
    needsGearRecovery,
    shouldDeferRecoveryForCombat,
    shouldDeferToCombat
} from '../combatGate.js';
import { findOwnGravesNear } from '../../world/graves.js';

/**
 * Interrupt work grouped into states. Interrupts listed earlier in
 * `targets.interrupts` still win, whichever state they belong to.
 */
export const DUTY_STATES = [
    { id: 'loot', label: 'アイテム回収', interrupts: ['nearby_loot'] },
    { id: 'death_recovery', label: '死亡からの復帰', interrupts: ['own_grave', 'death_return'] },
    { id: 'stuck_recovery', label: 'スタック復帰', interrupts: ['recovery'] }
];

export const DUTY_STATE_IDS = new Set(DUTY_STATES.map((state) => state.id));

/** @param {string} interruptName */
export function dutyStateOf(interruptName) {
    return DUTY_STATES.find((state) => state.interrupts.includes(interruptName))?.id ?? null;
}

/**
 * The duty state the first pending interrupt belongs to.
 * @param {object} targets
 * @returns {string|null}
 */
export function pendingDutyState(targets) {
    const next = (targets.interrupts || []).find((interrupt) => interrupt._lastShouldRun === true);
    return next ? dutyStateOf(next.name) : null;
}

/** Recompute the pending flag after an interrupt turned out to be stale. */
export function refreshDutyPending(targets) {
    targets._dutyPending = (targets.interrupts || []).some(
        (interrupt) => interrupt._lastShouldRun === true
    );
}

/**
 * @param {object} targets
 */
export function anyDutyShouldRun(targets) {
    for (const interrupt of targets.interrupts) {
        if (interrupt._lastShouldRun === true) return true;
    }
    return false;
}

/**
 * @param {object} targets
 */
export async function refreshDutyFlags(targets) {
    const ctx = targets.ctx;
    let any = false;
    for (const interrupt of targets.interrupts) {
        try {
            const ok = await interrupt.shouldRun(ctx);
            interrupt._lastShouldRun = Boolean(ok);
            if (ok) any = true;
        } catch {
            interrupt._lastShouldRun = false;
        }
    }
    targets._dutyPending = any;
    return any;
}

/**
 * @param {object} targets
 */
export function dutyPending(targets) {
    return Boolean(targets._dutyPending);
}

/** @param {object} targets */
export function passagePending(targets) {
    return Boolean(targets._passagePending);
}

/** Recovery work keeps its safety priority over a passage transaction. */
export function safetyDutyPending(targets) {
    if (targets.ctx?.deathRecovery?.active) return true;
    const next = (targets.interrupts || []).find((interrupt) => (
        interrupt._lastShouldRun === true
    ));
    return Boolean(next && next.name !== 'nearby_loot');
}

/**
 * @param {object} targets
 */
export function preferGearRecovery(targets) {
    const ctx = targets.ctx;
    const bot = ctx?.bot;
    if (!bot || ctx.deathRecovery?.active) return false;
    if (!needsGearRecovery(bot)) return false;
    const graveRadius = ctx.config?.own_grave?.scan_radius ?? 10;
    try {
        return findOwnGravesNear(bot, bot.username, graveRadius).length > 0;
    } catch {
        return false;
    }
}

/**
 * Enter combat when threats or tactical ownership demand it.
 * Gear recovery near own grave suppresses combat entry.
 * @param {object} targets
 */
export function shouldEnterCombat(targets) {
    const ctx = targets.ctx;
    if (!ctx?.bot?.entity) return false;
    if (preferGearRecovery(targets)) return false;
    if (ctx.deathRecovery?.active && !shouldDeferRecoveryForCombat(ctx)) {
        return false;
    }
    return shouldDeferToCombat(ctx) || hasProtectThreats(ctx);
}

/**
 * Stay in combat while tactical control or fresh threats remain.
 * @param {object} targets
 */
export function shouldStayInCombat(targets) {
    return shouldEnterCombat(targets);
}

/**
 * @param {object} targets
 */
export function shouldEnterDuty(targets) {
    if (shouldEnterCombat(targets)) return false;
    return dutyPending(targets);
}

/** @param {object} targets */
export function shouldEnterPassageTransit(targets) {
    if (!passagePending(targets)) return false;
    if (shouldEnterCombat(targets)) return false;
    return !safetyDutyPending(targets);
}
