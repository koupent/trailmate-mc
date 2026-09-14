import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createScenario,
  listScenarioIds,
  stepSimulation,
  type SimulationState
} from './SimulationCore.js';
import { generateArena, type ArenaKind } from './ArenaGenerator.js';
import { GymRunner } from './GymRunner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const reviewDir = path.join(process.cwd(), 'data', 'sim-reviews');
const port = Number(process.env.SIM_PORT || 4173);
const gym = new GymRunner();

const STATIC_FILES = new Set([
  'index.html',
  'app.js',
  'scene.js',
  'styles.css'
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/scenarios') {
      return json(response, 200, listScenarioIds().map((id) => createScenario(id)));
    }
    if (request.method === 'POST' && url.pathname === '/api/tick') {
      const state = await readJson<SimulationState>(request);
      return json(response, 200, stepSimulation(state));
    }
    if (request.method === 'POST' && url.pathname === '/api/gym/run') {
      const body = await readJson<{ count?: number; startSeed?: number; kind?: ArenaKind }>(request);
      const count = Math.max(1, Math.min(200, Number(body.count) || 10));
      const startSeed = Number.isFinite(body.startSeed) ? Number(body.startSeed) : Date.now() % 1_000_000;
      const results = gym.runBatch(count, startSeed);
      return json(response, 200, {
        results: results.map(summarizeEpisode),
        stats: gym.getStats()
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/gym/stats') {
      return json(response, 200, gym.getStats());
    }
    if (request.method === 'POST' && url.pathname === '/api/gym/reset') {
      const cleared = gym.resetSession();
      return json(response, 200, {
        ok: true,
        ...cleared,
        stats: gym.getStats()
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/gym/generate') {
      const body = await readJson<{ seed?: number; kind?: ArenaKind }>(request);
      const seed = Number.isFinite(body.seed) ? Number(body.seed) : Date.now() % 1_000_000;
      return json(response, 200, { seed, state: generateArena(seed, body.kind) });
    }
    if (request.method === 'POST' && url.pathname === '/api/gym/replay') {
      const body = await readJson<{ seed?: number; kind?: ArenaKind }>(request);
      const seed = Number(body.seed);
      if (!Number.isFinite(seed)) return json(response, 400, { error: 'seed が必要です' });
      return json(response, 200, { seed, state: gym.loadSeed(seed, body.kind) });
    }
    if (request.method === 'GET' && url.pathname === '/api/review/summary') {
      return json(response, 200, gym.buildReviewSummary());
    }
    if (request.method === 'POST' && url.pathname === '/api/review/export') {
      const markdown = gym.buildReviewMarkdown();
      await fs.mkdir(reviewDir, { recursive: true });
      const filePath = path.join(reviewDir, 'latest.md');
      await fs.writeFile(filePath, markdown, 'utf8');
      return json(response, 200, {
        path: 'data/sim-reviews/latest.md',
        markdown
      });
    }
    if (request.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!STATIC_FILES.has(file)) {
        return json(response, 404, { error: '見つかりません' });
      }
      const body = await fs.readFile(path.join(publicDir, file));
      response.writeHead(200, {
        'content-type': file.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8'
      });
      response.end(body);
      return;
    }
    json(response, 405, { error: '許可されていないメソッドです' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[combat-simulator] http://127.0.0.1:${port}`);
});

function summarizeEpisode(result: ReturnType<GymRunner['runEpisode']>) {
  return {
    seed: result.seed,
    arenaKind: result.arenaKind,
    win: result.win,
    died: result.died,
    ticks: result.ticks,
    botHp: result.botHp,
    damageTaken: result.damageTaken,
    attacks: result.attacks,
    shots: result.shots,
    kills: result.kills,
    presetId: result.presetId,
    exploring: result.exploring,
    exploringParams: result.exploringParams,
    paramsAdopted: result.paramsAdopted,
    changedKeys: result.changedKeys,
    score: result.score,
    learnReason: result.learnReason,
    curriculumReason: result.curriculumReason,
    failureKind: result.failureKind
  };
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error('リクエストが大きすぎます');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

process.on('SIGINT', () => {
  gym.flush();
  process.exit(0);
});
process.on('SIGTERM', () => {
  gym.flush();
  process.exit(0);
});
