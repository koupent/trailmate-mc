/** Maximum survival interaction reach measured to the boat hitbox. */
export const BOAT_MOUNT_RANGE = 3;
/** Avoid sending the same mount/dismount interaction every companion tick. */
export const BOAT_ACTION_RETRY_MS = 1000;
/** Give the server a bounded window to confirm the passenger update. */
export const BOAT_MOUNT_TIMEOUT_MS = 3000;

const DEFAULT_PLAYER_EYE_HEIGHT = 1.62;
const DEFAULT_BOAT_WIDTH = 1.375;
const DEFAULT_BOAT_HEIGHT = 0.5625;
const BOAT_LOOK_RESEND_MS = 250;
const BOAT_TRACE_PREFIX = '[boat-trace]';

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
     * @param {{
     *   now?: () => number,
     *   mountRange?: number,
     *   retryMs?: number,
     *   mountTimeoutMs?: number,
     *   logger?: Pick<Console, 'log'|'warn'>
     * }} [options]
     */
    constructor(bot, movement, options = {}) {
        this.bot = bot;
        this.movement = movement;
        this.now = options.now || Date.now;
        this.mountRange = options.mountRange ?? BOAT_MOUNT_RANGE;
        this.retryMs = options.retryMs ?? BOAT_ACTION_RETRY_MS;
        this.mountTimeoutMs = options.mountTimeoutMs ?? BOAT_MOUNT_TIMEOUT_MS;
        this.logger = options.logger || console;
        /** @type {{ kind:'mount'|'dismount', vehicleId:number, at:number, startedAt:number }|null} */
        this._pendingAction = null;
        /** @type {number|null} */
        this._blockedMountVehicleId = null;
        /** @type {Map<string, string>} */
        this._traceStates = new Map();
        /** @type {Map<number, number[]>} */
        this._passengerIdsByVehicle = new Map();
        /** @type {number|null} */
        this._ownerId = null;
        /** @type {number|null} */
        this._ownerVehicleId = null;
        /** @type {{ yaw:number, pitch:number, at:number }|null} */
        this._lastLookSync = null;
        this._registerPassengerTracking();
    }

    /**
     * Board only a reachable, owner-driven boat with exactly one free seat.
     * @param {import('prismarine-entity').Entity|null|undefined} owner
     * @returns {boolean} true when boat boarding owns this tick
     */
    tryBoard(owner) {
        this._rememberOwner(owner);
        if (this.maintain(owner)) return true;

        const boat = owner?.vehicle;
        const trace = boardingTrace(this.bot, boat, owner, this.mountRange);
        this._traceBoardingState('boarding_evaluated', trace);
        if (!trace.boardable) {
            this._clearStaleMountRequest(boat);
            return false;
        }

        const pending = this._pendingAction;
        if (pending?.kind === 'mount'
            && pending.vehicleId === boat.id
            && this.now() - pending.startedAt >= this.mountTimeoutMs) {
            this._pendingAction = null;
            this._blockedMountVehicleId = boat.id;
            this._traceAction('mount_timed_out', trace, true);
            return false;
        }
        if (this._blockedMountVehicleId === boat.id) {
            this._traceState('mount_suppressed', trace);
            return false;
        }

        this._holdMovement();
        if (!this._canSendAction('mount', boat.id)) return true;

        const requestedAt = this.now();
        this._pendingAction = {
            kind: 'mount',
            vehicleId: boat.id,
            at: requestedAt,
            startedAt: pending?.kind === 'mount' && pending.vehicleId === boat.id
                ? pending.startedAt
                : requestedAt
        };
        const method = typeof this.bot?._client?.write === 'function'
            && typeof this.bot.lookAt === 'function'
            ? 'interactAtThenInteract'
            : typeof this.bot.activateEntity === 'function'
                ? 'activateEntity'
                : 'mount';
        this._traceAction('mount_requested', { ...trace, method });
        try {
            const request = method === 'interactAtThenInteract'
                ? sendBoatInteraction(this.bot, boat)
                : method === 'activateEntity'
                    ? this.bot.activateEntity(boat)
                    : this.bot.mount(boat);
            if (request && typeof request.catch === 'function') {
                void request.catch((error) => this._failMountRequest(boat.id, trace, error));
            }
            return true;
        } catch (error) {
            this._failMountRequest(boat.id, trace, error);
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
        this._rememberOwner(owner);
        const vehicle = this.bot.vehicle;
        if (!vehicle) {
            this._lastLookSync = null;
            if (owner?.vehicle) {
                this._traceBoardingState(
                    'owner_vehicle_seen',
                    boardingTrace(this.bot, owner.vehicle, owner, this.mountRange)
                );
            }
            if (this._pendingAction?.kind === 'dismount') this._pendingAction = null;
            this._clearStaleMountRequest(owner?.vehicle);
            return false;
        }

        this._holdMovement();
        if (isTwoSeatBoat(vehicle)
            && isSameEntity(vehicle, owner?.vehicle)
            && ownerHasDriverSeat(vehicle, owner)) {
            this._pendingAction = null;
            this._matchOwnerLook(owner);
            this._traceState('mounted', vehicleTrace(this.bot, vehicle, owner));
            return true;
        }

        if (this._canSendAction('dismount', vehicle.id)) {
            const requestedAt = this.now();
            this._pendingAction = {
                kind: 'dismount',
                vehicleId: vehicle.id,
                at: requestedAt,
                startedAt: requestedAt
            };
            const trace = vehicleTrace(this.bot, vehicle, owner);
            this._traceAction('dismount_requested', trace);
            try {
                this.bot.dismount();
            } catch (error) {
                this._traceAction('dismount_request_failed', {
                    ...trace,
                    error: error instanceof Error ? error.message : String(error)
                }, true);
                this._pendingAction = null;
            }
        }
        return true;
    }

    _holdMovement() {
        this.movement?.stop?.();
        this.bot.clearControlStates?.();
    }

    _matchOwnerLook(owner) {
        const yaw = Number.isFinite(owner?.headYaw) ? owner.headYaw : owner?.yaw;
        if (!Number.isFinite(yaw)
            || !Number.isFinite(owner?.pitch)
            || typeof this.bot.look !== 'function') return;
        const now = this.now();
        const previous = this._lastLookSync;
        const directionChanged = !previous
            || angleDistance(yaw, previous.yaw) >= 0.001
            || Math.abs(owner.pitch - previous.pitch) >= 0.001;
        if (!directionChanged && now - previous.at < BOAT_LOOK_RESEND_MS) return;

        const packet = lookPacket(this.bot, yaw, owner.pitch);
        try {
            const look = this.bot.look(yaw, owner.pitch, true);
            if (look && typeof look.catch === 'function') {
                void look.catch((error) => this._traceState('look_sync_failed', {
                    error: error instanceof Error ? error.message : String(error)
                }));
            }
            this.bot._client?.write?.('look', packet);
            if (this.bot.entity) this.bot.entity.headYaw = yaw;
            this._lastLookSync = { yaw, pitch: owner.pitch, at: now };
            this._traceState('look_sync', {
                source: Number.isFinite(owner?.headYaw) ? 'headYaw' : 'yaw',
                ownerYawDeg: roundedDegrees(owner?.yaw),
                ownerHeadYawDeg: roundedDegrees(owner?.headYaw),
                ownerPitchDeg: roundedDegrees(owner?.pitch),
                sentYawDeg: roundedNumber(packet.yaw),
                sentPitchDeg: roundedNumber(packet.pitch)
            });
        } catch (error) {
            this._traceState('look_sync_failed', {
                error: error instanceof Error ? error.message : String(error)
            });
        }
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

    _failMountRequest(vehicleId, trace, error) {
        this._traceAction('mount_request_failed', {
            ...trace,
            error: error instanceof Error ? error.message : String(error)
        }, true);
        if (this._pendingAction?.kind === 'mount'
            && this._pendingAction.vehicleId === vehicleId) {
            this._pendingAction = null;
            this._blockedMountVehicleId = vehicleId;
        }
    }

    _rememberOwner(owner) {
        if (Number.isInteger(owner?.id)) this._ownerId = owner.id;
        const vehicleId = Number.isInteger(owner?.vehicle?.id) ? owner.vehicle.id : null;
        if (vehicleId !== this._ownerVehicleId) {
            if (vehicleId !== this._blockedMountVehicleId) {
                this._blockedMountVehicleId = null;
            }
            this._ownerVehicleId = vehicleId;
        }
    }

    _registerPassengerTracking() {
        this.bot?._client?.on?.('set_passengers', (packet) => {
            const passengerIds = Array.isArray(packet?.passengers) ? packet.passengers : [];
            const botId = this.bot.entity?.id;
            const trackedVehicle = packet?.entityId === this._ownerVehicleId
                || packet?.entityId === this._pendingAction?.vehicleId
                || packet?.entityId === this._blockedMountVehicleId;
            if (!trackedVehicle
                && !passengerIds.includes(this._ownerId)
                && !passengerIds.includes(botId)) return;
            const vehicle = this.bot.entities?.[packet.entityId];
            if (vehicle) reconcilePassengerState(this.bot, vehicle, passengerIds);

            const previousPassengerIds = this._passengerIdsByVehicle.get(packet.entityId) || [];
            if (passengerIds.length > 0) {
                this._passengerIdsByVehicle.set(packet.entityId, [...passengerIds]);
            } else {
                this._passengerIdsByVehicle.delete(packet.entityId);
            }
            const ownerWasPassenger = previousPassengerIds.includes(this._ownerId);
            const ownerIsPassenger = passengerIds.includes(this._ownerId);
            const botIsPassenger = passengerIds.includes(botId);
            if (!ownerIsPassenger || (!ownerWasPassenger && ownerIsPassenger)) {
                if (this._blockedMountVehicleId === packet.entityId) {
                    this._blockedMountVehicleId = null;
                }
                if (this._pendingAction?.kind === 'mount'
                    && this._pendingAction.vehicleId === packet.entityId
                    && !ownerIsPassenger) {
                    this._pendingAction = null;
                }
            }
            if (!ownerIsPassenger && this._ownerVehicleId === packet.entityId) {
                this._ownerVehicleId = null;
            }
            if (botIsPassenger) {
                this._pendingAction = null;
                this._blockedMountVehicleId = null;
            }
            this._traceState('passenger_packet', {
                botVersion: this.bot.version ?? null,
                protocolVersion: this.bot.protocolVersion ?? null,
                vehicleId: packet.entityId ?? null,
                vehicleName: vehicle?.name ?? null,
                passengerIds
            });
        });
    }

    _traceState(event, details) {
        this._traceStateWithKey(event, details, details);
    }

    _traceBoardingState(event, details) {
        this._traceStateWithKey(event, details, {
            vehicleId: details.vehicleId,
            passengerIds: details.passengerIds,
            boardable: details.boardable,
            rejection: details.rejection
        });
    }

    _traceStateWithKey(event, details, key) {
        const serialized = JSON.stringify(key);
        if (this._traceStates.get(event) === serialized) return;
        this._traceStates.set(event, serialized);
        this._writeTrace(event, details, false);
    }

    _traceAction(event, details, warning = false) {
        this._writeTrace(event, details, warning);
    }

    _writeTrace(event, details, warning) {
        const message = `${BOAT_TRACE_PREFIX} ${JSON.stringify({ event, ...details })}`;
        if (warning) this.logger.warn?.(message);
        else this.logger.log?.(message);
    }
}

function sendBoatInteraction(bot, boat) {
    bot.deactivateItem?.();
    const relativeHitY = (boat.height ?? DEFAULT_BOAT_HEIGHT) / 2;
    const target = offsetPosition(
        boat.position,
        0,
        relativeHitY,
        0
    );
    const send = () => {
        bot._client.write('use_entity', {
            target: boat.id,
            mouse: 2,
            x: 0,
            y: relativeHitY,
            z: 0,
            hand: 0,
            sneaking: false
        });
        bot._client.write('use_entity', {
            target: boat.id,
            mouse: 0,
            hand: 0,
            sneaking: false
        });
    };
    const look = bot.lookAt(target, true);
    if (look && typeof look.then === 'function') return look.then(send);
    send();
    return undefined;
}

function offsetPosition(position, x, y, z) {
    if (typeof position?.offset === 'function') return position.offset(x, y, z);
    return {
        x: position.x + x,
        y: position.y + y,
        z: position.z + z
    };
}

function lookPacket(bot, yaw, pitch) {
    return {
        yaw: Math.fround((Math.PI - yaw) * 180 / Math.PI),
        pitch: Math.fround(-pitch * 180 / Math.PI),
        flags: {
            onGround: Boolean(bot.entity?.onGround),
            hasHorizontalCollision: undefined
        }
    };
}

function angleDistance(left, right) {
    const difference = Math.abs(left - right) % (Math.PI * 2);
    return Math.min(difference, Math.PI * 2 - difference);
}

function reconcilePassengerState(bot, vehicle, passengerIds) {
    const previousPassengers = Array.isArray(vehicle.passengers) ? vehicle.passengers : [];
    const previousById = new Map(
        previousPassengers
            .filter((passenger) => Number.isInteger(passenger?.id))
            .map((passenger) => [passenger.id, passenger])
    );
    const nextPassengers = passengerIds
        .map((id) => bot.entities?.[id]
            || (id === bot.entity?.id ? bot.entity : previousById.get(id)))
        .filter(Boolean);
    const nextIds = new Set(passengerIds);

    for (const passenger of previousPassengers) {
        if (!nextIds.has(passenger?.id) && isSameEntity(passenger?.vehicle, vehicle)) {
            passenger.vehicle = null;
        }
    }
    for (const passenger of nextPassengers) passenger.vehicle = vehicle;
    vehicle.passengers = nextPassengers;

    const botId = bot.entity?.id;
    if (passengerIds.includes(botId)) {
        bot.vehicle = vehicle;
    } else if (isSameEntity(bot.vehicle, vehicle)) {
        const previousVehicle = bot.vehicle;
        bot.vehicle = null;
        bot.emit?.('dismount', previousVehicle);
    }
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

function boardingTrace(bot, boat, owner, mountRange) {
    const hitboxDistance = distanceToEntityBounds(bot.entity, boat);
    const trace = vehicleTrace(bot, boat, owner);
    const rejection = !isTwoSeatBoat(boat) ? 'unsupported_vehicle'
        : !ownerHasDriverSeat(boat, owner) ? 'owner_not_driver'
            : !Array.isArray(boat?.passengers) || boat.passengers.length !== 1 ? 'no_free_second_seat'
                : hitboxDistance > mountRange ? 'out_of_reach'
                    : null;
    return {
        ...trace,
        centerDistance: roundedDistance(bot.entity?.position, boat?.position),
        hitboxDistance: roundedNumber(hitboxDistance),
        mountRange,
        boardable: rejection === null,
        rejection
    };
}

function vehicleTrace(bot, vehicle, owner) {
    return {
        botVersion: bot.version ?? null,
        protocolVersion: bot.protocolVersion ?? null,
        ownerId: owner?.id ?? null,
        ownerVehicleId: owner?.vehicle?.id ?? null,
        botVehicleId: bot.vehicle?.id ?? null,
        vehicleId: vehicle?.id ?? null,
        vehicleName: vehicle?.name ?? null,
        vehicleDisplayName: vehicle?.displayName ?? null,
        vehicleWidth: vehicle?.width ?? null,
        vehicleHeight: vehicle?.height ?? null,
        passengerIds: Array.isArray(vehicle?.passengers)
            ? vehicle.passengers.map((passenger) => passenger?.id ?? null)
            : null,
        ownerIsDriver: ownerHasDriverSeat(vehicle, owner),
        twoSeatBoat: isTwoSeatBoat(vehicle)
    };
}

function roundedDistance(left, right) {
    if (!left || !right) return null;
    return roundedNumber(Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z));
}

function roundedNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function roundedDegrees(value) {
    return Number.isFinite(value) ? roundedNumber(value * 180 / Math.PI) : null;
}
