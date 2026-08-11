/** Maximum survival interaction reach measured to the boat hitbox. */
export const BOAT_MOUNT_RANGE = 3;
/** Avoid sending the same mount/dismount interaction every companion tick. */
export const BOAT_ACTION_RETRY_MS = 1000;

const DEFAULT_PLAYER_EYE_HEIGHT = 1.62;
const DEFAULT_BOAT_WIDTH = 1.375;
const DEFAULT_BOAT_HEIGHT = 0.5625;

/**
 * Minecraft 1.21.6 regular boats and bamboo rafts have two passenger seats.
 * Chest variants have only one usable seat and must never be selected.
 * @param {{ name?: string }|null|undefined} entity
 */
export function isTwoSeatBoat(entity) {
    const name = String(entity?.name || '');
    return (name.endsWith('_boat') || name.endsWith('_raft'))
        && !name.includes('_chest_');
}

/**
 * Keeps the owner first in the server-provided passenger order. The first
 * passenger is the controlling seat, so Trailmate only ever boards second.
 */
export class BoatPassengerController {
    /**
     * @param {import('mineflayer').Bot} bot
     * @param {{ stop?: () => void }} movement
     * @param {{ now?: () => number, mountRange?: number, retryMs?: number }} [options]
     */
    constructor(bot, movement, options = {}) {
        this.bot = bot;
        this.movement = movement;
        this.now = options.now || Date.now;
        this.mountRange = options.mountRange ?? BOAT_MOUNT_RANGE;
        this.retryMs = options.retryMs ?? BOAT_ACTION_RETRY_MS;
        /** @type {{ kind:'mount'|'dismount', vehicleId:number, at:number }|null} */
        this._pendingAction = null;
    }

    /**
     * Board only a reachable, owner-driven boat with exactly one free seat.
     * @param {import('prismarine-entity').Entity|null|undefined} owner
     * @returns {boolean} true when boat boarding owns this tick
     */
    tryBoard(owner) {
        if (this.maintain(owner)) return true;

        const boat = owner?.vehicle;
        if (!isBoardableOwnerBoat(boat, owner)
            || distanceToEntityBounds(this.bot.entity, boat) > this.mountRange) {
            this._clearStaleMountRequest(boat);
            return false;
        }

        this._holdMovement();
        if (!this._canSendAction('mount', boat.id)) return true;

        this._pendingAction = { kind: 'mount', vehicleId: boat.id, at: this.now() };
        try {
            this.bot.mount(boat);
            return true;
        } catch {
            this._pendingAction = null;
            return false;
        }
    }

    /**
     * Hold still as a non-controlling passenger. If the owner leaves, the boat
     * disappears from their state, or the owner is no longer first, dismount.
     * @param {import('prismarine-entity').Entity|null|undefined} owner
     * @returns {boolean} true while mounted or waiting for dismount confirmation
     */
    maintain(owner) {
        const vehicle = this.bot.vehicle;
        if (!vehicle) {
            if (this._pendingAction?.kind === 'dismount') this._pendingAction = null;
            this._clearStaleMountRequest(owner?.vehicle);
            return false;
        }

        this._holdMovement();
        if (isTwoSeatBoat(vehicle)
            && isSameEntity(vehicle, owner?.vehicle)
            && ownerHasDriverSeat(vehicle, owner)) {
            this._pendingAction = null;
            return true;
        }

        if (this._canSendAction('dismount', vehicle.id)) {
            this._pendingAction = { kind: 'dismount', vehicleId: vehicle.id, at: this.now() };
            try {
                this.bot.dismount();
            } catch {
                this._pendingAction = null;
            }
        }
        return true;
    }

    _holdMovement() {
        this.movement?.stop?.();
        this.bot.clearControlStates?.();
    }

    _canSendAction(kind, vehicleId) {
        const pending = this._pendingAction;
        return !pending
            || pending.kind !== kind
            || pending.vehicleId !== vehicleId
            || this.now() - pending.at >= this.retryMs;
    }

    _clearStaleMountRequest(ownerVehicle) {
        if (this._pendingAction?.kind !== 'mount') return;
        if (!isSameEntityId(this._pendingAction.vehicleId, ownerVehicle?.id)) {
            this._pendingAction = null;
        }
    }
}

function isBoardableOwnerBoat(boat, owner) {
    return isTwoSeatBoat(boat)
        && ownerHasDriverSeat(boat, owner)
        && Array.isArray(boat.passengers)
        && boat.passengers.length === 1;
}

function ownerHasDriverSeat(boat, owner) {
    return Array.isArray(boat?.passengers)
        && isSameEntity(boat.passengers[0], owner);
}

function isSameEntity(left, right) {
    return left === right
        || isSameEntityId(left?.id, right?.id);
}

function isSameEntityId(leftId, rightId) {
    return Number.isInteger(leftId)
        && Number.isInteger(rightId)
        && leftId === rightId;
}

/**
 * Vanilla interaction reach is checked from the player's eyes to the target
 * hitbox, not between entity origins. A boat can therefore be interactable
 * when its centre is slightly farther than the configured reach.
 */
function distanceToEntityBounds(viewer, target) {
    const viewerPos = viewer?.position;
    const targetPos = target?.position;
    if (!viewerPos || !targetPos) return Infinity;

    const eyeY = viewerPos.y + (viewer.eyeHeight ?? DEFAULT_PLAYER_EYE_HEIGHT);
    const radius = (target.width ?? DEFAULT_BOAT_WIDTH) / 2;
    const height = target.height ?? DEFAULT_BOAT_HEIGHT;
    const dx = distanceToInterval(viewerPos.x, targetPos.x - radius, targetPos.x + radius);
    const dy = distanceToInterval(eyeY, targetPos.y, targetPos.y + height);
    const dz = distanceToInterval(viewerPos.z, targetPos.z - radius, targetPos.z + radius);
    return Math.hypot(dx, dy, dz);
}

function distanceToInterval(value, min, max) {
    if (value < min) return min - value;
    if (value > max) return value - max;
    return 0;
}
