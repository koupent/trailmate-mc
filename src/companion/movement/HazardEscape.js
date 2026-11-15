import { Vec3 } from 'vec3';
import { AIR_SECONDS_PER_POINT, AIR_RESERVE_SECONDS, bodyInWater, headInWater, planWaterRoute, steerWaterRoute, waterNodeOpen } from './waterNavigation.js';
import {
    movementControlsTowardBearing,
    threatBearingRad
} from '../../combat/threatArc.js';
import { jumpBlockedByFarmland } from './farmland.js';
import {
    blockAt,
    CONTACT_HAZARD_RADIUS,
    findContactHazards,
    findHazardsAround,
    findSafeEscapePosition,
    isPassableBlock,
    isPassableLiquid,
    isSafeStandPosition
} from './hazardBlocks.js';

const DEFAULT_SEARCH_RADIUS = 5;
const DEFAULT_WATER_SEARCH_RADIUS = 12;
const WATER_DIRECT_APPROACH_RANGE = 3;
const WATER_SEARCH_INTERVAL_MS = 1000;
const SAFE_CONFIRM_TICKS = 2;
const ESCAPE_CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];

/**
 * 息がこの値以下で頭が水中なら、溺れる前に浮上を始める。
 * mineflayer の oxygenLevel は 0〜20 で、0 になるとダメージが入る。
 */
export const SURFACE_OXYGEN = 5;

/** 浮上を始めたあと、息がここまで戻ったら作業へ戻る。 */
export const RESUME_OXYGEN = 20;
export const SURFACE_HEALTH = 8;
export const RESUME_HEALTH = 14;
export const SURFACE_FOOD = 6;
export const RESUME_FOOD = 14;

/**
 * 頭のブロックが水か。足だけ浸かっている浅瀬では浮上しない。
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number } | null | undefined} position
 */
export function isHeadInWater(bot, position = bot?.entity?.position) {
    return headInWater(bot, position);
}

/**
 * 浮上を続けるべきか。
 * 始めていないときは「頭が水中かつ息が SURFACE_OXYGEN 以下」。
 * 始めたあとは、息が RESUME_OXYGEN に戻るまで離さない。
 * 息の値が無いときは動かさない。
 * @param {{ oxygen?: number | null, headInWater?: boolean, surfacing?: boolean }} input
 */
export function shouldSurfaceForAir(input = {}) {
    const oxygen = input.oxygen;
    if (typeof oxygen !== 'number' || !Number.isFinite(oxygen)) return false;
    if (input.surfacing) return oxygen < RESUME_OXYGEN;
    return Boolean(input.headInWater) && oxygen <= SURFACE_OXYGEN;
}

/**
 * 通れる経路の先にある、実際に呼吸できる足元座標。未読込・天井は空気扱いしない。
 * @param {import('mineflayer').Bot} bot
 * @param {{ x: number, y: number, z: number }} position
 */
export function findAirSurfaceTarget(bot, position) {
    return planWaterRoute(bot, { from: position, air: true })?.target ?? null;
}

/** Minecraft shared entity flags: bit 0 means the entity is on fire. */
export function isEntityBurning(entity) {
    if (entity?.isOnFire === true || entity?.onFire === true) return true;
    const flags = Number(entity?.metadata?.[0]);
    return Number.isFinite(flags) && (flags & 0x01) !== 0;
}

/** Find the nearest loaded water cell the bot can physically enter. */
export function findNearestExtinguishingWater(
    bot,
    position = bot?.entity?.position,
    maxDistance = DEFAULT_WATER_SEARCH_RADIUS,
    rejected = new Set()
) {
    if (!position || typeof bot?.blockAt !== 'function') return null;
    const positions = typeof bot.findBlocks === 'function'
        ? bot.findBlocks({
            point: position,
            matching: (block) => isPassableLiquid(block),
            maxDistance,
            count: 32,
            useExtraInfo: true
        })
        : scanWaterPositions(bot, position, maxDistance);

    const nearestFirst = [...positions].sort((a, b) => (
        distanceBetween(a, position) - distanceBetween(b, position)
    ));
    for (const waterPosition of nearestFirst) {
        const key = blockPositionKey(waterPosition);
        if (rejected.has(key)) continue;
        const water = blockAt(bot, waterPosition.x, waterPosition.y, waterPosition.z);
        const above = blockAt(bot, waterPosition.x, waterPosition.y + 1, waterPosition.z);
        if (!isPassableLiquid(water) || !isPassableBlock(above)) continue;
        const target = {
            x: Math.floor(waterPosition.x) + 0.5,
            y: Math.floor(waterPosition.y),
            z: Math.floor(waterPosition.z) + 0.5
        };
        if (findHazardsAround(bot, target, CONTACT_HAZARD_RADIUS).length > 0) continue;
        return target;
    }
    return null;
}

/**
 * Highest-priority local movement used while the bot is touching a damage block.
 * It intentionally bypasses pathfinder so escape starts in the same companion tick.
 */
export class HazardEscapeController {
    constructor(bot, movement, options = {}) {
        this.bot = bot;
        this.movement = movement;
        this.maxRadius = options.maxRadius ?? DEFAULT_SEARCH_RADIUS;
        this.waterSearchRadius = options.waterSearchRadius ?? DEFAULT_WATER_SEARCH_RADIUS;
        this.safeConfirmTicks = options.safeConfirmTicks ?? SAFE_CONFIRM_TICKS;
        this.now = options.now ?? Date.now;
        this.active = false;
        this.target = null;
        this._safeTicks = 0;
        this._hazardNames = [];
        this._extinguishing = false;
        this._surfacing = false;
        this._recoveringVitals = false;
        this._usingPathfinder = false;
        this._lastWaterSearchAt = 0;
        this._rejectedWater = new Set();
        this._airPlan = null;
        this._airCell = null;
        this._airProgressPos = null;
        this._airProgressAt = 0;
        this.lastBreathable = null;
        this.airStatus = null;
        this._airReturnRequested = false;
    }

    /** A proposed dive is unaffordable: return along the known air route. */
    requestAirReturn() {
        this._airReturnRequested = true;
    }

    /** @returns {boolean} true while ordinary companion behavior must yield */
    tick() {
        const position = this.bot?.entity?.position;
        if (!position) {
            this._release();
            return false;
        }

        const hazards = findContactHazards(this.bot, position);
        if (hazards.length > 0) {
            if (!this.active) this._takeControl(hazards, false);
            this._extinguishing = false;
            this._safeTicks = 0;
            if (!this.target || !isSafeStandPosition(this.bot, this.target)) {
                this.target = findSafeEscapePosition(
                    this.bot,
                    position,
                    hazards,
                    this.maxRadius
                ) || fallbackEscapeTarget(this.bot, position, hazards);
            }
            this._moveTowardTarget(hazards);
            return true;
        }

        if (isEntityBurning(this.bot.entity)) {
            const extinguishing = this._seekExtinguishingWater(position);
            if (extinguishing) return true;
        } else if (this._extinguishing) {
            this._release();
            return false;
        }

        if (this._tickBreath(position)) return true;

        if (!this.active) return false;
        if (!isSafeStandPosition(this.bot, position)) {
            this._safeTicks = 0;
            this._moveTowardTarget([]);
            return true;
        }

        this._safeTicks += 1;
        if (this._safeTicks < this.safeConfirmTicks) {
            this._moveTowardTarget([]);
            return true;
        }

        this._release();
        return false;
    }

    _takeControl(hazards, extinguishing, names = null) {
        this.active = true;
        this._extinguishing = extinguishing;
        this._surfacing = false;
        this._hazardNames = names
            ?? (extinguishing
                ? ['burning']
                : [...new Set(hazards.map((hazard) => hazard.block.name))]);
        this.movement?.stop?.();
        try {
            this.bot.pvp?.forceStop?.();
        } catch {
            /* ignore */
        }
        clearEscapeControls(this.bot);
        console.warn(
            '[companion] hazard escape started',
            JSON.stringify({ hazards: this._hazardNames })
        );
    }

    _seekExtinguishingWater(position) {
        if (isInsideWater(this.bot, position)) {
            if (!this.active) this._takeControl([], true);
            this._extinguishing = true;
            this._stopWaterPathfinder();
            clearEscapeControls(this.bot);
            return true;
        }

        if (this.movement?.isBlocked || this.movement?.isUnreachable) {
            if (this.target) this._rejectedWater.add(blockPositionKey(this.target));
            this.target = null;
            this._lastWaterSearchAt = 0;
            this._stopWaterPathfinder();
        }

        if (this.target && !isWaterTarget(this.bot, this.target)) {
            this.target = null;
        }
        if (!this.target) {
            const now = this.now();
            if (now - this._lastWaterSearchAt < WATER_SEARCH_INTERVAL_MS) return false;
            this._lastWaterSearchAt = now;
            this.target = findNearestExtinguishingWater(
                this.bot,
                position,
                this.waterSearchRadius,
                this._rejectedWater
            );
        }

        if (!this.target) {
            this._stopWaterPathfinder();
            this._extinguishing = false;
            clearEscapeControls(this.bot);
            return false;
        }
        if (!this.active) this._takeControl([], true);
        this._extinguishing = true;
        const distance = Math.hypot(
            this.target.x - position.x,
            this.target.y - position.y,
            this.target.z - position.z
        );
        if (distance > WATER_DIRECT_APPROACH_RANGE && this.movement?.goToward) {
            clearEscapeControls(this.bot);
            this.movement.setSprintAllowed?.(true);
            this.movement.goToward(this.target, 0);
            this._usingPathfinder = true;
            return true;
        }

        this._stopWaterPathfinder();
        this._moveTowardTarget([], true);
        return true;
    }

    /**
     * 息が足りなくなる前に水面まで上がり、息が戻るまで作業の経路を止めて待つ。
     * 炎の消火と接触ダメージより後に見るので、そちらの移動は変えない。
     * @returns {boolean}
     */
    _tickBreath(position) {
        const wet = bodyInWater(this.bot, position);
        const submerged = isHeadInWater(this.bot, position);
        const oxygen = this.bot.oxygenLevel;
        if (!wet) this._recoveringVitals = false;
        else if (!this._recoveringVitals) {
            this._recoveringVitals = this.bot.health <= SURFACE_HEALTH || this.bot.food <= SURFACE_FOOD;
        } else if ((this.bot.health == null || this.bot.health >= RESUME_HEALTH)
            && (this.bot.food == null || this.bot.food >= RESUME_FOOD)) {
            this._recoveringVitals = false;
        }

        // Record real breathable positions. A roof, unloaded chunk or solid
        // ceiling must never be mistaken for the surface.
        if (!submerged && waterNodeOpen(this.bot, position)) this.lastBreathable = { ...position };
        if (this._surfacing && !submerged && !this._recoveringVitals
            && (!Number.isFinite(oxygen) || oxygen >= RESUME_OXYGEN)) {
            this._release();
            this._airPlan = null;
            return false;
        }
        if (!wet && !this._surfacing) return false;

        const cell = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
        // Lock the return endpoint and follow its waypoints. Replan when a
        // block changes or progress stalls, never chase a new surface each tick.
        const now = this.now();
        const stalled = this._airProgressPos && Math.hypot(
            position.x - this._airProgressPos.x, position.y - this._airProgressPos.y,
            position.z - this._airProgressPos.z) < 0.2 && now - this._airProgressAt > 1500;
        if (!this._airProgressPos || positionDistance(position, this._airProgressPos) >= 0.2) {
            this._airProgressPos = { ...position }; this._airProgressAt = now;
        }
        if (!this._airPlan || (!this._surfacing && cell !== this._airCell)
            || stalled || this._airPlan.points.some(point => !waterNodeOpen(this.bot, point))) {
            this._airPlan = planWaterRoute(this.bot, { air: true });
            this._airCell = cell;
            if (!this._airPlan && this.lastBreathable) {
                this._airPlan = planWaterRoute(this.bot, { target: this.lastBreathable, range: 0 });
            }
        }
        const airSeconds = Number.isFinite(oxygen) ? Math.max(0, oxygen - 0.5) * AIR_SECONDS_PER_POINT : 0;
        const mustReturn = this._airReturnRequested || this._surfacing || this._recoveringVitals || (submerged && (
            !this._airPlan || oxygen <= SURFACE_OXYGEN
            || airSeconds <= this._airPlan.seconds + AIR_RESERVE_SECONDS
        ));
        if (!mustReturn) return false;
        const reason = this._recoveringVitals ? 'low-vitals' : 'low-air';
        if (!this.active) this._takeControl([], false, [reason]);
        this._surfacing = true;
        this._extinguishing = false;
        this._hazardNames = [reason];
        this._stopWaterPathfinder();
        this.target = this._airPlan?.target ?? this.lastBreathable ?? null;
        if (this._airPlan) {
            steerWaterRoute(this.bot, this._airPlan);
        } else {
            // Refuse further diving if no loaded route is known. No path to a
            // verified air cell is different from a successful surface plan.
            clearEscapeControls(this.bot);
            this.bot.setControlState?.('jump', submerged);
        }
        this.airStatus = { phase: submerged ? 'returning' : 'recovering',
            target: this.target, availableSeconds: airSeconds,
            returnSeconds: this._airPlan?.seconds ?? null, reserveSeconds: AIR_RESERVE_SECONDS };
        return true;
    }

    _moveTowardTarget(hazards, forceJump = false) {
        const position = this.bot?.entity?.position;
        if (!position || !this.target) return;
        const bearing = threatBearingRad(position, this.target);
        const controls = movementControlsTowardBearing(
            bearing,
            this.bot.entity.yaw ?? 0,
            0.15
        );
        if (Math.hypot(this.target.x - position.x, this.target.z - position.z) < 0.2) {
            for (const key of ['forward', 'back', 'left', 'right']) controls[key] = false;
        }
        this.bot.setControlState?.('forward', controls.forward);
        this.bot.setControlState?.('back', controls.back);
        this.bot.setControlState?.('left', controls.left);
        this.bot.setControlState?.('right', controls.right);
        this.bot.setControlState?.('sprint', true);
        const wantsJump = forceJump
            || hazards.some((hazard) => hazard.block.name === 'lava')
            || this.target.y > position.y + 0.4
            || hasObstacleAhead(this.bot, position, bearing);
        // Farmland outranks the escape jump, with no exception for lava or
        // burning: the bot keeps walking toward the same escape target and
        // simply never leaves the ground over a field.
        this.bot.setControlState?.(
            'jump',
            wantsJump && !jumpBlockedByFarmland(this.bot, position, this.target)
        );
    }

    _stopWaterPathfinder() {
        if (!this._usingPathfinder) return;
        this.movement?.stop?.();
        this._usingPathfinder = false;
    }

    _release() {
        if (!this.active) return;
        this._stopWaterPathfinder();
        clearEscapeControls(this.bot);
        this.movement?.setSprintAllowed?.(false);
        console.log(
            '[companion] hazard escape complete',
            JSON.stringify({ hazards: this._hazardNames })
        );
        this.active = false;
        this.target = null;
        this._safeTicks = 0;
        this._hazardNames = [];
        this._extinguishing = false;
        this._surfacing = false;
        this._recoveringVitals = false;
        this._lastWaterSearchAt = 0;
        this._rejectedWater.clear();
        this._airPlan = null;
        this._airCell = null;
        this._airProgressPos = null;
        this.airStatus = null;
        this._airReturnRequested = false;
    }
}

function fallbackEscapeTarget(bot, position, hazards) {
    const center = hazardCenter(hazards);
    let dx = center ? position.x - center.x : 0;
    let dz = center ? position.z - center.z : 0;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) {
        const yaw = bot.entity?.yaw ?? 0;
        dx = -Math.sin(yaw);
        dz = -Math.cos(yaw);
    } else {
        dx /= length;
        dz /= length;
    }
    return { x: position.x + dx * 3, y: position.y, z: position.z + dz * 3 };
}

function hazardCenter(hazards) {
    if (hazards.length === 0) return null;
    const sum = hazards.reduce((acc, hazard) => ({
        x: acc.x + hazard.position.x + 0.5,
        z: acc.z + hazard.position.z + 0.5
    }), { x: 0, z: 0 });
    return { x: sum.x / hazards.length, z: sum.z / hazards.length };
}

function hasObstacleAhead(bot, position, bearing) {
    const x = position.x + Math.sin(bearing) * 0.65;
    const z = position.z + Math.cos(bearing) * 0.65;
    const block = blockAt(bot, x, position.y, z);
    const above = blockAt(bot, x, position.y + 1, z);
    return block?.boundingBox === 'block' && isPassableBlock(above);
}

function clearEscapeControls(bot) {
    for (const control of ESCAPE_CONTROLS) {
        bot?.setControlState?.(control, false);
    }
}

function distanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isInsideWater(bot, position) {
    const feet = blockAt(bot, position.x, position.y, position.z);
    const body = blockAt(bot, position.x, position.y + 1, position.z);
    return isPassableLiquid(feet) || isPassableLiquid(body);
}

function isWaterTarget(bot, target) {
    return isPassableLiquid(blockAt(bot, target.x, target.y, target.z));
}

function scanWaterPositions(bot, position, maxDistance) {
    const found = [];
    const radius = Math.floor(maxDistance);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (Math.hypot(dx, dy, dz) > maxDistance) continue;
                const candidate = new Vec3(
                    Math.floor(position.x) + dx,
                    Math.floor(position.y) + dy,
                    Math.floor(position.z) + dz
                );
                if (isPassableLiquid(bot.blockAt(candidate))) found.push(candidate);
            }
        }
    }
    return found.sort((a, b) => a.distanceTo(position) - b.distanceTo(position));
}

function blockPositionKey(position) {
    return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function positionDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
