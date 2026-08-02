/**
 * Follow-time torch support (exploration). Extracted from Reflexes.maybeTorch
 * with a slightly wider dark-spot sample (feet + owner forward).
 */

import { Vec3 } from 'vec3';
import {
    estimateBrightness,
    nearestTorchDistance,
    torchScanRadius,
    TORCH_PLACE_COOLDOWN_MS
} from '../../reflexes/torchPlacement.js';

/** @type {WeakMap<object, number>} */
const lastTorchAtByCtx = new WeakMap();

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {{ x: number, y: number, z: number }} pos
 */
function sampleBrightnessAt(ctx, pos) {
    const bot = ctx.bot;
    const block = bot.blockAt(pos);
    if (!block) return null;
    const timeOfDay = bot.time?.timeOfDay ?? 0;
    const isNight = timeOfDay >= 13000 && timeOfDay < 23000;
    const threshold = ctx.config?.torch_light_threshold ?? 7;
    return estimateBrightness({
        skyLight: block.skyLight ?? null,
        isNight,
        torchDistance: nearestTorchDistance(
            (x, y, z) => bot.blockAt(new Vec3(x, y, z)),
            pos,
            torchScanRadius(threshold)
        )
    });
}

/**
 * Place a torch when standing (and optionally owner-forward) is too dark.
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @param {import('../../host/BotHost.ts').TrailmateHost} [_agent]
 */
export async function maybePlaceSupportTorch(ctx, _agent) {
    if (ctx.config?.torch_placing === false) return;
    if (ctx.holdReflexes) return;

    const bot = ctx.bot;
    const pos = bot?.entity?.position;
    if (!pos) return;

    const now = Date.now();
    const last = lastTorchAtByCtx.get(ctx) || 0;
    if (now - last < TORCH_PLACE_COOLDOWN_MS) return;

    const torch = bot.inventory.items().find((i) => i.name === 'torch');
    if (!torch) return;

    const threshold = ctx.config?.torch_light_threshold ?? 7;
    const feet = bot.blockAt(pos);
    if (!feet || feet.name !== 'air') return;

    const samples = [pos];
    const owner = ctx.ownerEntity;
    if (owner?.position) {
        const ox = owner.position.x - pos.x;
        const oz = owner.position.z - pos.z;
        const len = Math.hypot(ox, oz);
        if (len > 0.2) {
            samples.push({
                x: pos.x + (ox / len) * 1.5,
                y: pos.y,
                z: pos.z + (oz / len) * 1.5
            });
        }
    }

    let needsTorch = false;
    for (const sample of samples) {
        const brightness = sampleBrightnessAt(ctx, sample);
        if (brightness != null && brightness <= threshold) {
            needsTorch = true;
            break;
        }
    }
    if (!needsTorch) return;

    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || !below.name || below.name === 'air' || below.name === 'water') return;

    lastTorchAtByCtx.set(ctx, now);
    try {
        await bot.equip(torch, 'hand');
        await bot.placeBlock(below, new Vec3(0, 1, 0));
    } catch {
        /* placement often fails in motion; ignore */
    }
}
