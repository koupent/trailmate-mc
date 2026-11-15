/** Coalesce movement at 20 Hz without losing position when a look follows it.
 * Mineflayer reuses its lastSent object, so queued data must be copied. */
export function createMovementPacketLimiter(send, { now = Date.now, intervalMs = 50 } = {}) {
    let sentAt = -Infinity;
    let pending = null;
    function merge(name, data) {
        const position = name !== 'look';
        const look = name !== 'position';
        pending ??= { position: false, look: false, data: {} };
        pending.position ||= position;
        pending.look ||= look;
        if (position) for (const key of ['x', 'y', 'z']) pending.data[key] = data[key];
        if (look) for (const key of ['yaw', 'pitch']) pending.data[key] = data[key];
        if ('onGround' in data) pending.data.onGround = data.onGround;
        if ('flags' in data) pending.data.flags = typeof data.flags === 'object' ? { ...data.flags } : data.flags;
    }
    function flush() {
        if (!pending || now() - sentAt < intervalMs) return;
        const packet = pending;
        pending = null;
        sentAt = now();
        send(packet.position ? (packet.look ? 'position_look' : 'position') : 'look', packet.data);
    }
    return {
        write(name, data) {
            if (!['position', 'position_look', 'look'].includes(name)) return send(name, data);
            merge(name, data);
            if (now() - sentAt >= intervalMs) flush();
        },
        flush
    };
}

export function installMovementPacketLimiter(bot) {
    const original = bot._client.write.bind(bot._client);
    let ticks = 0, lastPhysicsAt = null, lastPositionAt = null;
    const corrections = [];
    const onPhysics = () => { ticks++; lastPhysicsAt = Date.now(); };
    const onCorrection = () => {
        const now = Date.now();
        while (corrections.length && corrections[0] < now - 5000) corrections.shift();
        corrections.push(now);
    };
    bot.on('physicsTick', onPhysics);
    bot.on('forcedMove', onCorrection);
    bot._trailmateMovementDiagnostics = {
        snapshot() {
            const now = Date.now();
            while (corrections.length && corrections[0] < now - 5000) corrections.shift();
            return { physicsEnabled: bot.physicsEnabled !== false, physicsTicks: ticks,
                physicsAgeMs: lastPhysicsAt == null ? null : Math.max(0, now - lastPhysicsAt),
                positionPacketAgeMs: lastPositionAt == null ? null : Math.max(0, now - lastPositionAt),
                serverCorrections5s: corrections.length,
                controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump'].map(key => [key, Boolean(bot.getControlState?.(key))])) };
        }
    };
    const limiter = createMovementPacketLimiter((name, data) => {
        if (name === 'position' || name === 'position_look') lastPositionAt = Date.now();
        return original(name, data);
    });
    bot._client.write = limiter.write;
    const timer = setInterval(limiter.flush, 50);
    timer.unref?.();
    bot.once('end', () => {
        clearInterval(timer);
        bot.removeListener('physicsTick', onPhysics);
        bot.removeListener('forcedMove', onCorrection);
        bot._client.write = original;
    });
    return limiter;
}
