/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 */
export function horizontalDistanceBetween(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Shortest horizontal distance from point P to segment AB.
 * @param {{ x: number, z: number }} p
 * @param {{ x: number, z: number }} a
 * @param {{ x: number, z: number }} b
 */
export function horizontalPointToSegmentDistance(p, a, b) {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lenSq = abx * abx + abz * abz;
    if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);

    let t = ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    return Math.hypot(p.x - cx, p.z - cz);
}
