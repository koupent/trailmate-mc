import { approachPosition } from './approachPosition.js';
import { jumpOntoStep, sleep, MANUAL_JUMP_DISTANCE, CLIMB_HOLD_MS } from '../movement/climb.js';
import { scanSurroundings } from '../movement/surroundings.js';

const DEFAULT_POLL_MS = 250;
/** Extra slack beyond dig_range for center-to-center reach checks. */
const DIG_REACH_SLACK = 1;

/**
 * @param {{ x: number, y: number, z: number }} blockPos
 */
function graveBlockCenter(blockPos) {
    return {
        x: blockPos.x + 0.5,
        y: blockPos.y + 0.5,
        z: blockPos.z + 0.5
    };
}

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
function distance3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} blockPos
 * @param {number} digRange
 */
export function isGraveWithinDigReach(bot, blockPos, digRange) {
    const feet = bot?.entity?.position;
    if (!feet || !blockPos) return false;

    const center = graveBlockCenter(blockPos);
    const horizontal = Math.hypot(feet.x - center.x, feet.z - center.z);
    if (horizontal > digRange + 0.5) return false;

    const eyeY = feet.y + 1.62;
    const vertical = center.y - eyeY;
    if (vertical > digRange + 0.25 || vertical < -(digRange + 0.25)) return false;

    return distance3(feet, center) <= digRange + DIG_REACH_SLACK;
}

/**
 * Walk or climb until the grave block is within dig reach.
 * Uses horizontal arrival plus step-up assist when the grave sits on a ledge.
 *
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} blockPos
 * @param {{ digRange?: number, timeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function approachGraveForDig(ctx, blockPos, options = {}) {
    const bot = ctx?.bot;
    if (!bot?.entity || !blockPos) return false;

    const digRange = options.digRange ?? 3.5;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const blockCenter = graveBlockCenter(blockPos);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (bot.interrupt_code || !bot.entity) {
            ctx.movement?.stop?.();
            return false;
        }
        if (isGraveWithinDigReach(bot, blockPos, digRange)) {
            ctx.movement?.stop?.();
            return true;
        }

        const dy = blockCenter.y - bot.entity.position.y;
        if (dy > 0.45) {
            const climbed = await tryClimbTowardGrave(ctx, blockCenter, pollMs);
            if (climbed) continue;
        }

        await approachPosition(ctx, blockCenter, {
            range: digRange,
            pathRange: Math.max(2, digRange - 1),
            timeoutMs: pollMs * 2,
            pollMs,
            horizontalArrival: true,
            arrivalSlack: 0.75
        });
        await sleep(pollMs);
    }

    ctx.movement?.stop?.();
    return isGraveWithinDigReach(bot, blockPos, digRange);
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} blockCenter
 * @param {number} pollMs
 */
async function tryClimbTowardGrave(ctx, blockCenter, pollMs) {
    const bot = ctx.bot;
    const scan = scanSurroundings(bot, blockCenter);
    const step = scan.stepUps[0];
    if (step) {
        const distToStep = Math.hypot(
            step.center.x - bot.entity.position.x,
            step.center.z - bot.entity.position.z
        );
        if (distToStep <= MANUAL_JUMP_DISTANCE) {
            ctx.movement.stop();
            bot.clearControlStates();
            await jumpOntoStep(bot, step.center);
            return true;
        }
        ctx.movement.climbTo(step.center, CLIMB_HOLD_MS);
        await sleep(pollMs);
        return true;
    }

    ctx.movement.climbTo(blockCenter, CLIMB_HOLD_MS);
    await sleep(pollMs);
    return true;
}
