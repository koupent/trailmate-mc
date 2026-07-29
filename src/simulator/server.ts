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

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const port = Number(process.env.SIM_PORT || 4173);

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
    if (request.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'styles.css'].includes(file)) {
        return json(response, 404, { error: 'not found' });
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
    json(response, 405, { error: 'method not allowed' });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[combat-simulator] http://127.0.0.1:${port}`);
});

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error('request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
