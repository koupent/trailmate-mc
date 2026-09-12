import http from 'node:http';
import dotenv from 'dotenv';
import type { AppConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { bootHost, type TrailmateHost } from '../host/BotHost.js';

export type ControlState = {
  host: TrailmateHost | null;
  spawning: boolean;
  lastError: string | null;
};

export function createControlState(): ControlState {
  return {
    host: null,
    spawning: false,
    lastError: null
  };
}

export function startControlServer(
  state: ControlState,
  options: { port?: number; host?: string } = {}
): http.Server {
  const port = Number(options.port ?? process.env.CONTROL_PORT ?? 8790);
  const bindHost = options.host ?? process.env.CONTROL_BIND ?? '127.0.0.1';

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return json(response, 200, buildStatus(state));
      }
      if (request.method === 'POST' && url.pathname === '/spawn') {
        const result = await spawnCompanion(state);
        return json(response, result.ok ? 200 : 409, result);
      }
      if (request.method === 'POST' && url.pathname === '/despawn') {
        const result = await despawnCompanion(state);
        return json(response, result.ok ? 200 : 409, result);
      }
      json(response, 404, { error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      json(response, 500, { ok: false, error: message });
    }
  });

  server.listen(port, bindHost, () => {
    console.log(`[trailmate] control API http://${bindHost}:${port} (parked until /spawn)`);
  });

  return server;
}

export async function spawnCompanion(
  state: ControlState,
  config?: AppConfig
): Promise<{ ok: boolean; error?: string; status: ReturnType<typeof buildStatus> }> {
  if (state.spawning) {
    return { ok: false, error: 'already spawning', status: buildStatus(state) };
  }
  if (state.host) {
    return { ok: false, error: 'already spawned', status: buildStatus(state) };
  }

  state.spawning = true;
  state.lastError = null;
  try {
    // Pick up dashboard edits to .env / config.json without recreating the container.
    dotenv.config({ override: true });
    const resolved = config ?? loadConfig();
    console.log(`[trailmate] spawning to ${resolved.host}:${resolved.port} as ${resolved.botName}`);
    const host = await bootHost(resolved);
    state.host = host;
    host.bot.on('end', (reason) => {
      console.log(`[trailmate] bot ended: ${reason}`);
      if (state.host === host) {
        cleanupHost(host);
        state.host = null;
        state.lastError = `disconnected: ${reason}`;
      }
    });
    return { ok: true, status: buildStatus(state) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    console.error('[trailmate] spawn failed:', message);
    return { ok: false, error: message, status: buildStatus(state) };
  } finally {
    state.spawning = false;
  }
}

export async function despawnCompanion(
  state: ControlState
): Promise<{ ok: boolean; error?: string; status: ReturnType<typeof buildStatus> }> {
  if (state.spawning) {
    return { ok: false, error: 'spawn in progress', status: buildStatus(state) };
  }
  if (!state.host) {
    return { ok: true, status: buildStatus(state) };
  }

  const host = state.host;
  state.host = null;
  try {
    cleanupHost(host);
    try {
      host.bot.quit('trailmate despawn');
    } catch {
      /* ignore */
    }
    return { ok: true, status: buildStatus(state) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    return { ok: false, error: message, status: buildStatus(state) };
  }
}

export function buildStatus(state: ControlState) {
  const host = state.host;
  if (!host?.bot) {
    return {
      spawned: false,
      spawning: state.spawning,
      lastError: state.lastError,
      botName: process.env.BOT_NAME || 'Trailmate'
    };
  }

  const bot = host.bot;
  const entity = bot.entity;
  const companion = host.companion;
  const manager = companion?.manager || companion?.orchestrator;
  const items = collectInventory(bot);

  return {
    spawned: true,
    spawning: state.spawning,
    lastError: state.lastError,
    botName: host.name || bot.username,
    username: bot.username,
    health: bot.health ?? null,
    food: bot.food ?? null,
    position: entity?.position
      ? {
          x: roundCoord(entity.position.x),
          y: roundCoord(entity.position.y),
          z: roundCoord(entity.position.z)
        }
      : null,
    dimension: (bot as any).game?.dimension ?? null,
    ownerName: companion?.ctx?.ownerName ?? null,
    preferredMode: manager?.getCurrentModeId?.() ?? null,
    activeFsm: manager?.getActiveFsmId?.() ?? null,
    inventory: items
  };
}

function collectInventory(bot: TrailmateHost['bot']): Array<{ name: string; count: number }> {
  try {
    const raw = bot.inventory?.items?.() || [];
    const merged = new Map<string, number>();
    for (const item of raw) {
      const name = String(item?.name || 'unknown');
      const count = Number(item?.count) || 0;
      merged.set(name, (merged.get(name) || 0) + count);
    }
    return [...merged.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function cleanupHost(host: TrailmateHost): void {
  try {
    host.reflexes?.flushLearning?.();
  } catch {
    /* ignore */
  }
  try {
    if (host.companion?._interval) {
      clearInterval(host.companion._interval);
      host.companion._interval = null;
    }
  } catch {
    /* ignore */
  }
}

function roundCoord(value: number): number {
  return Math.round(value * 10) / 10;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}
