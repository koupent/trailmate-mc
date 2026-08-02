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

/**
 * @param {object} targets
 * @returns {'follow'|'wait'}
 */
export function resumeUpperMode(targets) {
    return targets.preferredMode === 'wait' ? 'wait' : 'follow';
}
