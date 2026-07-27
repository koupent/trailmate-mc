import Vec3 from 'vec3';

/** Vanilla jump impulse (approx). Used only as a Via fallback. */
const JUMP_IMPULSE = 0.42;
const FORWARD_IMPULSE = 0.22;
/** Step back from the lip before jumping so the hitbox is not glued to the face. */
const BACK_SECONDS = 0.2;

/**
 * Force a step-up when pathfinder alone is wedged against a lip.
 * Backs off first, waits for onGround, then jumps forward onto the step top.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} stepTop
 * @returns {Promise<boolean>}
 */
export async function jumpOntoStep(bot, stepTop) {
    bot.clearControlStates();
    stopPathfinder(bot);

    if (!(await waitUntilGrounded(bot, 1200))) {
        return false;
    }

    const start = bot.entity.position.clone();
    await lookLevelAt(bot, stepTop);

    const dx = stepTop.x - start.x;
    const dz = stepTop.z - start.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;

    // Ease off the face so the next jump is not cancelled by contact float-error.
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    await sleep(Math.floor(BACK_SECONDS * 1000));
    bot.setControlState('back', false);
    await sleep(80);

    if (!bot.entity.onGround) {
        await waitUntilGrounded(bot, 800);
    }

    bot.setControlState('sprint', false);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    bot.entity.velocity.x = nx * FORWARD_IMPULSE;
    bot.entity.velocity.z = nz * FORWARD_IMPULSE;
    bot.entity.velocity.y = JUMP_IMPULSE;

    await sleep(550);
    bot.setControlState('jump', false);
    bot.setControlState('forward', true);
    await sleep(350);
    bot.clearControlStates();

    return bot.entity.position.y - start.y >= 0.6;
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {number} timeoutMs
 */
async function waitUntilGrounded(bot, timeoutMs) {
    if (bot.entity.onGround) return true;
    bot.clearControlStates();
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        await sleep(40);
        if (bot.entity.onGround) return true;
    }
    return !!bot.entity.onGround;
}

function stopPathfinder(bot) {
    try {
        bot.pathfinder?.setGoal?.(null);
    } catch {
        // ignore
    }
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{x: number, z: number}} target
 */
export async function lookLevelAt(bot, target) {
    const eyeY = bot.entity.position.y + (bot.entity.eyeHeight || 1.62);
    try {
        await bot.lookAt(new Vec3(target.x, eyeY, target.z), true);
    } catch {
        // look can fail while the chunk reloads; the next tick retries
    }
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
