import { computeOutOfSightAnchor, isBotInOwnerFov } from '../followPosition.js';
import { horizontalDistanceBetween } from './followGeometry.js';

/** Minimum perpendicular distance from the mining look-axis to count as a side lane. */
const LATERAL_LANE_MIN = 0.5;

/**
 * Horizontal distance from `point` to the worker's mining look-axis.
 * @param {{ position: { x: number, z: number }, yaw?: number }} worker
 * @param {{ x: number, z: number }} point
 */
export function lateralDistanceFromMiningLane(worker, point) {
    const yaw = worker.yaw || 0;
    // Mineflayer yaw 0 faces -Z → forward = (-sin, -cos)
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dx = point.x - worker.position.x;
    const dz = point.z - worker.position.z;
    return Math.abs(fx * dz - fz * dx);
}

/**
 * Candidate yield points: laterals first, then away-from-owner, then behind.
 * @param {{ position: { x: number, y: number, z: number }, yaw?: number }} worker
 * @param {{ x: number, y: number, z: number }|null|undefined} botPos
 * @param {number} distance
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function buildWorkYieldCandidates(worker, botPos, distance) {
    const pos = worker.position;
    const yaw = worker.yaw || 0;
    /** @type {{ x: number, y: number, z: number }[]} */
    const candidates = [
        {
            x: pos.x + Math.sin(yaw + Math.PI / 2) * distance,
            y: pos.y,
            z: pos.z + Math.cos(yaw + Math.PI / 2) * distance
        },
        {
            x: pos.x + Math.sin(yaw - Math.PI / 2) * distance,
            y: pos.y,
            z: pos.z + Math.cos(yaw - Math.PI / 2) * distance
        }
    ];

    if (botPos) {
        const dx = botPos.x - pos.x;
        const dz = botPos.z - pos.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.05) {
            candidates.push({
                x: pos.x + (dx / len) * distance,
                y: pos.y,
                z: pos.z + (dz / len) * distance
            });
        }
    }

    candidates.push(computeOutOfSightAnchor(worker, distance));
    return candidates;
}

/**
 * Pick a yield target that clears the mining lane (prefer clear lateral, FOV-out).
 * Blocked laterals are never selected; falls back to the behind anchor when none remain.
 *
 * @param {{ position: { x: number, y: number, z: number }, yaw?: number }} worker
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{
 *   distance: number,
 *   fovDegrees: number,
 *   isPathBlocked?: (target: { x: number, y: number, z: number }) => boolean
 * }} opts
 * @returns {{
 *   target: { x: number, y: number, z: number },
 *   hasLateralAlternative: boolean
 * }}
 */
export function computeWorkYieldTarget(worker, botPos, opts) {
    const distance = opts.distance;
    const fovDegrees = opts.fovDegrees;
    const isPathBlocked = opts.isPathBlocked;

    let best = null;
    let bestScore = Infinity;
    let hasLateralAlternative = false;

    for (const candidate of buildWorkYieldCandidates(worker, botPos, distance)) {
        if (isBotInOwnerFov(worker, candidate, fovDegrees)) continue;

        const lateral = lateralDistanceFromMiningLane(worker, candidate);
        const isLateral = lateral >= LATERAL_LANE_MIN;
        if (!isLateral) continue;

        const blocked = isPathBlocked?.(candidate) ?? false;
        if (blocked) continue;

        hasLateralAlternative = true;
        const dist = horizontalDistanceBetween(botPos, candidate);
        if (dist < bestScore) {
            bestScore = dist;
            best = candidate;
        }
    }

    const target = best || computeOutOfSightAnchor(worker, distance);
    return { target, hasLateralAlternative };
}

/**
 * Pick the nearest position that clears every active worker at once.
 * Candidate rings cover cases where the lateral escape from one worker enters
 * another worker's mining cone.
 *
 * @param {Array<{ position: { x: number, y: number, z: number }, yaw?: number }>} workers
 * @param {{ x: number, y: number, z: number }} botPos
 * @param {{
 *   distance: number,
 *   fovDegrees: number,
 *   isPathBlocked?: (target: { x: number, y: number, z: number }) => boolean
 * }} opts
 * @returns {{ x: number, y: number, z: number }|null}
 */
export function computeSharedWorkYieldTarget(workers, botPos, opts) {
    const activeWorkers = workers.filter((worker) => worker?.position);
    if (activeWorkers.length === 0) return null;

    const distance = Math.max(0.5, opts.distance);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
        const key = `${candidate.x.toFixed(3)}:${candidate.z.toFixed(3)}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
    };

    for (const worker of activeWorkers) {
        for (const candidate of buildWorkYieldCandidates(worker, botPos, distance)) {
            addCandidate(candidate);
        }

        // Sample complete rings so overlapping work cones can escape to a
        // shared clear sector instead of oscillating between two workers.
        for (const multiplier of [1, 1.5, 2]) {
            const radius = distance * multiplier;
            for (let step = 0; step < 16; step += 1) {
                const angle = (step / 16) * Math.PI * 2;
                addCandidate({
                    x: worker.position.x + Math.sin(angle) * radius,
                    y: worker.position.y,
                    z: worker.position.z + Math.cos(angle) * radius
                });
            }
        }
    }

    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        if (!isClearOfAllWorkers(activeWorkers, candidate, opts)) continue;
        if (opts.isPathBlocked?.(candidate)) continue;
        const candidateDistance = horizontalDistanceBetween(botPos, candidate);
        if (candidateDistance < bestDistance) {
            bestDistance = candidateDistance;
            best = candidate;
        }
    }
    return best;
}

/**
 * @param {Array<{ position: { x: number, z: number }, yaw?: number }>} workers
 * @param {{ x: number, z: number }} position
 * @param {{ distance: number, fovDegrees: number }} opts
 */
export function isClearOfAllWorkers(workers, position, opts) {
    return workers.every((worker) => (
        horizontalDistanceBetween(worker.position, position) >= opts.distance
        && !isBotInOwnerFov(worker, position, opts.fovDegrees)
    ));
}
