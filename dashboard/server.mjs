import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachContainer,
  demuxDockerLogs,
  dockerRequest,
  findServiceContainerId,
  stripAnsi
} from './dockerApi.mjs';
import { createUpdateManager } from './update.mjs';
import {
  BACKEND_STARTING_MESSAGE,
  PROXY_STARTING_MESSAGE,
  backendUnavailableStatus,
  humanizeSpawnError,
  isPlaceholderAddress,
  parseHostPort,
  probeSpawnReady,
  probeTcp,
  probeTrailmateBackend,
  withReadiness
} from './backendReady.mjs';
import {
  PROXY_RECYCLED_MESSAGE,
  PROXY_RECYCLING_MESSAGE,
  PROXY_RESTART_FAILED_MESSAGE,
  PROXY_STILL_UNREACHABLE_MESSAGE,
  createProxyWatch,
  isProxyBackendFailure
} from './proxyRecovery.mjs';
import {
  effectiveRetention,
  mergeRetentionIntoConfig,
  normalizeRetentionInput,
  readRetentionBlock
} from './retentionSettings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const projectRoot = process.env.PROJECT_ROOT || path.resolve(here, '..');
const port = Number(process.env.DASHBOARD_PORT || 8787);
const controlUrl = (process.env.TRAILMATE_CONTROL_URL || 'http://trailmate:8790').replace(/\/$/, '');
const viaproxyService = process.env.VIAPROXY_SERVICE || 'viaproxy';
const updateManager = createUpdateManager(projectRoot);
const proxyWatchIntervalMs = Number(process.env.PROXY_WATCH_INTERVAL_MS || 5000);
const proxyWatch = createProxyWatch();

const PATHS = {
  env: path.join(projectRoot, '.env'),
  envExample: path.join(projectRoot, '.env.example'),
  config: path.join(projectRoot, 'config.json'),
  configExample: path.join(projectRoot, 'config.example.json'),
  viaproxy: path.join(projectRoot, 'services', 'viaproxy', 'viaproxy.yml'),
  viaproxyExample: path.join(projectRoot, 'services', 'viaproxy', 'viaproxy.yml.example'),
  saves: path.join(projectRoot, 'services', 'viaproxy', 'saves.json')
};

/** @type {{ active: boolean, output: string, url: string | null, code: string | null, error: string | null, done: boolean, success: boolean, accountName: string | null }} */
let msLogin = emptyMsLogin();

/** @type {import('node:net').Socket | null} */
let msAttachSocket = null;

/**
 * Windows 起動直後の順番次第で ViaProxy は「動いているのに実サーバーへ行けない」
 * 状態で居座る。その自動つなぎ直しの進行状況。
 * @type {{ restarting: boolean, lastRestartAt: number | null, lastReason: string | null, message: string | null }}
 */
const proxyRecovery = {
  restarting: false,
  lastRestartAt: null,
  lastReason: null,
  message: null
};

let spawnInFlight = false;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return json(response, 200, await readSettings());
    }
    if (request.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readJson(request);
      await writeSettings(body);
      return json(response, 200, { ok: true, settings: await readSettings() });
    }
    if (request.method === 'GET' && url.pathname === '/api/retention') {
      return json(response, 200, await readRetentionSettings());
    }
    if (request.method === 'POST' && url.pathname === '/api/retention') {
      const body = await readJson(request);
      return json(response, 200, await writeRetentionSettings(body?.retention));
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      return sendControlStatus(response);
    }
    if (request.method === 'POST' && url.pathname === '/api/spawn') {
      return handleSpawn(response);
    }
    if (request.method === 'POST' && url.pathname === '/api/despawn') {
      const backend = await probeTrailmateBackend(controlUrl);
      if (!backend.ok) {
        return json(response, 503, {
          ok: false,
          error: backend.error || BACKEND_STARTING_MESSAGE,
          backendReady: false,
          spawnReady: false
        });
      }
      return proxyControl(response, '/despawn', 'POST');
    }
    if (request.method === 'GET' && url.pathname === '/api/logs') {
      const service = url.searchParams.get('service') || 'trailmate';
      const tail = Number(url.searchParams.get('tail') || 40);
      const logs = await dockerLogs(service, tail);
      return json(response, 200, { service, logs });
    }
    if (request.method === 'GET' && url.pathname === '/api/ms-login') {
      return json(response, 200, { ...msLogin, registeredAccount: await readRegisteredAccount() });
    }
    if (request.method === 'POST' && url.pathname === '/api/ms-login/start') {
      const result = await startMicrosoftLogin();
      return json(response, result.ok ? 200 : 409, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/ms-login/cancel') {
      await cancelMicrosoftLogin('cancelled by user');
      return json(response, 200, { ok: true, ...msLogin });
    }
    if (request.method === 'GET' && url.pathname === '/api/update/status') {
      return json(response, 200, await updateManager.getStatus());
    }
    if (request.method === 'GET' && url.pathname === '/api/update/logs') {
      return json(response, 200, await updateManager.getLogs());
    }
    if (request.method === 'POST' && url.pathname === '/api/update/apply') {
      const length = Number(request.headers['content-length'] || 0);
      const body = length > 0 ? await readJson(request) : {};
      const result = await updateManager.startApply({
        targetVersion: body?.targetVersion
      });
      return json(response, result.ok ? 200 : 409, result);
    }
    if (request.method === 'GET') {
      return serveStatic(url.pathname, response);
    }
    json(response, 405, { error: 'method not allowed' });
  } catch (error) {
    // A rejected value is the user's typo, not a broken dashboard: say so with
    // a 4xx so the form can show the message instead of "サーバーエラー".
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600
      ? Number(error.status)
      : 500;
    json(response, status, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[dashboard] http://0.0.0.0:${port}`);
  startProxyWatchdog();
});

function emptyMsLogin() {
  return {
    active: false,
    output: '',
    url: null,
    code: null,
    error: null,
    done: false,
    success: false,
    accountName: null
  };
}

async function readSettings() {
  await ensureConfigFiles();
  const envText = await fs.readFile(PATHS.env, 'utf8');
  const env = parseEnv(envText);
  const viaproxyText = await fs.readFile(PATHS.viaproxy, 'utf8');
  const targetAddress = matchYaml(viaproxyText, 'target-address') || '';
  const authMethod = matchYaml(viaproxyText, 'auth-method') || 'ACCOUNT';
  const botName = env.BOT_NAME || 'Trailmate';
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(PATHS.config, 'utf8'));
  } catch {
    config = {};
  }
  const registeredAccount = await readRegisteredAccount();
  const settings = {
    targetAddress,
    authMethod,
    botName,
    minecraftVersion: config.minecraft_version || '1.21.6',
    placeholder: isPlaceholderAddress(targetAddress),
    registeredAccount
  };
  return {
    ...settings,
    setup: buildSetup(settings)
  };
}

/**
 * Fresh installs must not depend on copied secrets. Surface exactly what is missing.
 * @param {{ placeholder: boolean, authMethod: string, registeredAccount: { registered: boolean, name: string | null } }} settings
 */
function buildSetup(settings) {
  const steps = [
    {
      id: 'server',
      ok: !settings.placeholder && Boolean(settings.targetAddress),
      label: 'サーバー住所を設定する'
    },
    {
      id: 'account',
      ok: settings.authMethod === 'NONE' || Boolean(settings.registeredAccount?.registered),
      label:
        settings.authMethod === 'NONE'
          ? 'オフライン認証（Microsoft 不要）'
          : 'ボット用 Microsoft アカウントを登録する'
    }
  ];
  const blockers = steps.filter((step) => !step.ok).map((step) => step.label);
  return {
    readyToSpawn: blockers.length === 0,
    steps,
    blockers
  };
}

async function writeSettings(body) {
  await ensureConfigFiles();
  const targetAddress = String(body.targetAddress || '').trim();
  const authMethod = body.authMethod === 'NONE' ? 'NONE' : 'ACCOUNT';
  const minecraftVersion = String(body.minecraftVersion || '').trim();

  if (!targetAddress) {
    throw new Error('サーバー住所を入力してください');
  }

  let envText = await fs.readFile(PATHS.env, 'utf8');
  const currentEnv = parseEnv(envText);
  // ACCOUNT 時の BOT_NAME は Mineflayer→ViaProxy のオフライン握手名に過ぎず、
  // ワールド内名は Microsoft プロフィール側。未指定なら既存／既定を維持する。
  const botName =
    authMethod === 'NONE'
      ? String(body.botName || currentEnv.BOT_NAME || 'Trailmate').trim() || 'Trailmate'
      : String(currentEnv.BOT_NAME || body.botName || 'Trailmate').trim() || 'Trailmate';
  envText = upsertEnv(envText, 'BOT_NAME', botName);
  await fs.writeFile(PATHS.env, envText, 'utf8');

  let yml = await fs.readFile(PATHS.viaproxy, 'utf8');
  yml = upsertYaml(yml, 'target-address', targetAddress);
  yml = upsertYaml(yml, 'auth-method', authMethod);
  await fs.writeFile(PATHS.viaproxy, yml, 'utf8');

  if (minecraftVersion) {
    const config = JSON.parse(await fs.readFile(PATHS.config, 'utf8'));
    config.minecraft_version = minecraftVersion;
    await fs.writeFile(PATHS.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  const container = await findServiceContainerId(viaproxyService);
  if (container) {
    await dockerRequest('POST', `/containers/${container}/restart`);
  }
}

/**
 * The candidate item list, published by the bot from its own registry.
 * Null while the trailmate container is still starting.
 */
async function fetchRetentionCatalog() {
  try {
    const upstream = await fetch(`${controlUrl}/retention/catalog`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    if (!upstream.ok) return null;
    const catalog = await upstream.json();
    return Array.isArray(catalog?.categories) && catalog.categories.length > 0
      ? catalog
      : null;
  } catch {
    return null;
  }
}

async function readConfigJson() {
  await ensureConfigFiles();
  try {
    return JSON.parse(await fs.readFile(PATHS.config, 'utf8'));
  } catch {
    return {};
  }
}

/** Catalog plus whatever `config.json` currently says, ready to draw. */
async function readRetentionSettings() {
  const catalog = await fetchRetentionCatalog();
  const stored = readRetentionBlock(await readConfigJson());
  return {
    catalog,
    retention: catalog ? effectiveRetention(catalog, stored) : null,
    backendReady: Boolean(catalog),
    message: catalog
      ? null
      : '相棒（ボット）コンテナの準備中です。アイテム一覧を取得できるまでお待ちください。'
  };
}

/**
 * Validate, persist, then hand the result to a running companion.
 *
 * The write is an in-place `fs.writeFile` on purpose. `config.json` is bind
 * mounted into the bot as a single file, so writing a temporary file and
 * renaming it over the top would swap the inode and leave the bot reading the
 * old contents for the rest of its life.
 *
 * ViaProxy is deliberately left alone: which items the companion keeps has
 * nothing to do with the proxy, and restarting it would drop the session.
 *
 * @param {unknown} input
 */
async function writeRetentionSettings(input) {
  const catalog = await fetchRetentionCatalog();
  const retention = normalizeRetentionInput(catalog, input);

  const config = mergeRetentionIntoConfig(await readConfigJson(), retention);
  await fs.writeFile(PATHS.config, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const applied = await pushRetentionToBot(retention);
  return {
    ok: true,
    applied,
    catalog,
    retention: effectiveRetention(catalog, retention),
    backendReady: true,
    message: applied
      ? '保存しました。次のチェスト返却から新しい設定で動きます。'
      : '保存しました。相棒が未スポーンのため、次のスポーンから反映されます。'
  };
}

/**
 * Push the saved policy onto the live companion. A failure here is not a
 * failed save — the file is already written, so the next spawn picks it up.
 * @param {object} retention
 */
async function pushRetentionToBot(retention) {
  try {
    const upstream = await fetch(`${controlUrl}/retention`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retention }),
      signal: AbortSignal.timeout(5000)
    });
    if (!upstream.ok) return false;
    const result = await upstream.json();
    return Boolean(result?.applied);
  } catch {
    return false;
  }
}

async function ensureConfigFiles() {
  if (!existsSync(PATHS.env) && existsSync(PATHS.envExample)) {
    await fs.copyFile(PATHS.envExample, PATHS.env);
  }
  if (!existsSync(PATHS.config) && existsSync(PATHS.configExample)) {
    await fs.copyFile(PATHS.configExample, PATHS.config);
  }
  if (!existsSync(PATHS.viaproxy) && existsSync(PATHS.viaproxyExample)) {
    await fs.copyFile(PATHS.viaproxyExample, PATHS.viaproxy);
  }
  // Never create saves.json here. Fresh installs must register via Microsoft login UI.
}

async function readRegisteredAccount() {
  try {
    if (!existsSync(PATHS.saves)) {
      return { registered: false, count: 0, name: null };
    }
    const data = JSON.parse(await fs.readFile(PATHS.saves, 'utf8'));
    const accounts = Array.isArray(data?.accountsV4) ? data.accountsV4 : [];
    const named = accounts.filter((account) => account?.minecraftProfile?.name);
    const first = named[0];
    return {
      registered: named.length > 0,
      count: named.length,
      name: first?.minecraftProfile?.name || null
    };
  } catch {
    return { registered: false, count: 0, name: null };
  }
}

async function evaluateSpawnGate() {
  const settings = await readSettings();
  return probeSpawnReady({
    controlUrl,
    targetAddress: settings.targetAddress,
    authMethod: settings.authMethod,
    registeredAccount: settings.registeredAccount,
    getProxyHealth: () => readServiceHealth(viaproxyService)
  });
}

async function readServiceHealth(service) {
  try {
    const id = await findServiceContainerId(service);
    if (!id) return { ok: false, status: 'missing' };
    const info = await dockerRequest('GET', `/containers/${id}/json`);
    if (info.status >= 400) return { ok: false, status: 'error' };
    const body = JSON.parse(info.body.toString('utf8'));
    const running = Boolean(body?.State?.Running);
    if (!running) return { ok: false, status: 'stopped' };
    const health = body?.State?.Health?.Status;
    if (health === 'healthy') return { ok: true, status: 'healthy' };
    if (health == null) return { ok: true, status: 'running' };
    return { ok: false, status: String(health) };
  } catch {
    return { ok: false, status: 'error' };
  }
}

/**
 * Windows 起動直後は Docker が Tailscale より先に上がることがあり、その順番で
 * 起動した ViaProxy は実サーバーへ一度も届かないまま居座る（待ち受けポートは
 * 開くので healthy に見える）。スポーンだけが失敗し、直し方は再起動だけ。
 * ここでダッシュボードが肩代わりして、人が restart.bat を叩かなくて済むようにする。
 * @param {string} reason
 */
async function restartViaProxy(reason) {
  if (proxyRecovery.restarting) {
    return { ok: false, error: PROXY_RECYCLING_MESSAGE };
  }
  const id = await findServiceContainerId(viaproxyService);
  if (!id) {
    return { ok: false, error: 'ViaProxy コンテナが見つかりません' };
  }

  proxyRecovery.restarting = true;
  proxyRecovery.lastReason = reason;
  proxyRecovery.message = PROXY_RECYCLING_MESSAGE;
  console.log(`[dashboard] restarting viaproxy (${reason})`);
  try {
    const result = await dockerRequest('POST', `/containers/${id}/restart`);
    if (result.status >= 400) {
      throw new Error(result.body.toString('utf8').slice(0, 200));
    }
    const healthyId = await waitForViaProxyHealthy(60000);
    proxyRecovery.lastRestartAt = Date.now();
    if (!healthyId) {
      proxyRecovery.message = PROXY_STARTING_MESSAGE;
      return { ok: false, error: 'ViaProxy の再起動待ちがタイムアウトしました' };
    }
    proxyRecovery.message = PROXY_RECYCLED_MESSAGE;
    console.log('[dashboard] viaproxy restarted and healthy');
    return { ok: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    proxyRecovery.message = PROXY_RESTART_FAILED_MESSAGE;
    console.error('[dashboard] viaproxy restart failed:', message);
    return { ok: false, error: message };
  } finally {
    proxyRecovery.restarting = false;
  }
}

async function readProxyContainerState() {
  try {
    const id = await findServiceContainerId(viaproxyService);
    if (!id) return { running: false, startedAt: null };
    const info = await dockerRequest('GET', `/containers/${id}/json`);
    if (info.status >= 400) return { running: false, startedAt: null };
    const body = JSON.parse(info.body.toString('utf8'));
    const startedAt = Date.parse(body?.State?.StartedAt || '');
    return {
      running: Boolean(body?.State?.Running),
      startedAt: Number.isFinite(startedAt) ? startedAt : null
    };
  } catch {
    return { running: false, startedAt: null };
  }
}

async function readSessionState() {
  try {
    const upstream = await fetch(`${controlUrl}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    if (!upstream.ok) return { spawned: false, spawning: false };
    const data = await upstream.json();
    return { spawned: Boolean(data?.spawned), spawning: Boolean(data?.spawning) };
  } catch {
    return { spawned: false, spawning: false };
  }
}

function startProxyWatchdog() {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await proxyWatchTick();
    } catch (error) {
      console.warn(
        '[dashboard] proxy watchdog error:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      ticking = false;
    }
  };
  void tick();
  const timer = setInterval(tick, proxyWatchIntervalMs);
  timer.unref?.();
  return timer;
}

async function proxyWatchTick() {
  let settings;
  try {
    settings = await readSettings();
  } catch {
    return;
  }
  if (settings.placeholder || !settings.targetAddress) return;
  const parsed = parseHostPort(settings.targetAddress);
  if (!parsed) return;

  const container = await readProxyContainerState();
  const target = await probeTcp(parsed.host, parsed.port);
  const session = await readSessionState();

  const decision = proxyWatch.observe({
    reachable: target.ok,
    proxyRunning: container.running,
    proxyStartedAt: container.startedAt,
    spawned: session.spawned,
    spawning: session.spawning,
    busy: proxyRecovery.restarting || spawnInFlight || msLogin.active
  });

  if (decision.restart) {
    await restartViaProxy('target-recovered');
  }
}

async function handleSpawn(response) {
  const readiness = buildSetup(await readSettings());
  if (!readiness.readyToSpawn) {
    return json(response, 409, {
      ok: false,
      error: readiness.blockers.join(' / '),
      setup: readiness
    });
  }
  if (proxyRecovery.restarting) {
    return json(response, 503, {
      ok: false,
      error: PROXY_RECYCLING_MESSAGE,
      backendReady: true,
      spawnReady: false
    });
  }

  const spawnGate = await evaluateSpawnGate();
  if (!spawnGate.ok) {
    return json(response, 503, {
      ok: false,
      error: spawnGate.error || PROXY_STARTING_MESSAGE,
      backendReady: Boolean(spawnGate.backendReady),
      spawnReady: false,
      diagnostics: spawnGate.diagnostics || null
    });
  }

  spawnInFlight = true;
  try {
    let attempt = await requestControlSpawn();
    let proxyRestarted = false;
    let restartError = null;

    // 診断は全部緑（実サーバーには届く）なのに ViaProxy だけが背後へ行けない＝
    // 起動順で壊れた ViaProxy。つなぎ直して一度だけやり直す。
    if (!attempt.ok && isProxyBackendFailure(spawnErrorText(attempt))) {
      const restart = await restartViaProxy('spawn-backend-unreachable');
      if (restart.ok) {
        proxyRestarted = true;
        attempt = await requestControlSpawn();
      } else {
        restartError = restart.error;
      }
    }

    const data =
      attempt.data && typeof attempt.data === 'object'
        ? { ...attempt.data }
        : attempt.networkError
          ? {
              ok: false,
              backendReady: false,
              spawnReady: false,
              error: BACKEND_STARTING_MESSAGE,
              detail: attempt.networkError
            }
          : { ok: false, error: attempt.text || BACKEND_STARTING_MESSAGE };

    const stillBlocked = !attempt.ok && isProxyBackendFailure(spawnErrorText(attempt));
    if (data.ok === false && data.error) {
      data.error =
        proxyRestarted && stillBlocked
          ? PROXY_STILL_UNREACHABLE_MESSAGE
          : humanizeSpawnError(data.error, { spawnReady: true, blockerId: null });
      if (restartError) data.error = `${data.error}（${restartError}）`;
    }
    if (data.status?.lastError) {
      data.status = {
        ...data.status,
        lastError: humanizeSpawnError(data.status.lastError, {
          spawnReady: true,
          blockerId: null
        })
      };
    }
    if (proxyRestarted) data.proxyRestarted = true;

    return json(response, attempt.status, data);
  } finally {
    spawnInFlight = false;
  }
}

async function requestControlSpawn() {
  try {
    const upstream = await fetch(`${controlUrl}/spawn`, {
      method: 'POST',
      signal: AbortSignal.timeout(120000)
    });
    const text = await upstream.text();
    /** @type {any} */
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw */
    }
    return {
      ok: upstream.ok && data?.ok !== false,
      status: upstream.status,
      data,
      text,
      networkError: null
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      data: null,
      text: '',
      networkError: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * @param {{ data?: any, text?: string, networkError?: string | null }} attempt
 */
function spawnErrorText(attempt) {
  return String(
    attempt?.data?.error || attempt?.data?.status?.lastError || attempt?.text || ''
  );
}

/**
 * つなぎ直し中は診断の要約より、いま何をしているかを優先して見せる。
 * @param {object | null} diagnostics
 */
function decorateDiagnostics(diagnostics) {
  if (!proxyRecovery.restarting) return diagnostics || null;
  if (!diagnostics) return null;
  return { ...diagnostics, summary: PROXY_RECYCLING_MESSAGE };
}

function proxyRecoveryPayload() {
  return {
    restarting: proxyRecovery.restarting,
    lastRestartAt: proxyRecovery.lastRestartAt,
    reason: proxyRecovery.lastReason,
    message: proxyRecovery.message
  };
}

async function sendControlStatus(response) {
  const spawnGate = await evaluateSpawnGate();
  const diagnostics = decorateDiagnostics(spawnGate.diagnostics);

  if (!spawnGate.backendReady) {
    return json(response, 200, {
      ...backendUnavailableStatus(
        proxyRecovery.restarting
          ? PROXY_RECYCLING_MESSAGE
          : spawnGate.error || BACKEND_STARTING_MESSAGE
      ),
      diagnostics,
      proxyRecovery: proxyRecoveryPayload()
    });
  }

  try {
    const upstream = await fetch(`${controlUrl}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    const text = await upstream.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text || `HTTP ${upstream.status}` };
    }
    if (!upstream.ok) {
      return json(response, 200, {
        ...backendUnavailableStatus(BACKEND_STARTING_MESSAGE),
        diagnostics,
        proxyRecovery: proxyRecoveryPayload()
      });
    }
    if (data?.lastError) {
      data = {
        ...data,
        lastError: humanizeSpawnError(data.lastError, {
          spawnReady: Boolean(spawnGate.spawnReady),
          blockerId: spawnGate.diagnostics?.blockerId
        })
      };
    }
    return json(response, 200, {
      ...withReadiness(data, {
        backendReady: true,
        spawnReady: Boolean(spawnGate.spawnReady) && !proxyRecovery.restarting,
        backendMessage: proxyRecovery.restarting
          ? PROXY_RECYCLING_MESSAGE
          : spawnGate.spawnReady
            ? null
            : diagnostics?.summary || spawnGate.error || PROXY_STARTING_MESSAGE,
        diagnostics
      }),
      proxyRecovery: proxyRecoveryPayload()
    });
  } catch {
    return json(response, 200, {
      ...backendUnavailableStatus(),
      diagnostics,
      proxyRecovery: proxyRecoveryPayload()
    });
  }
}

async function proxyControl(response, pathname, method = 'GET') {
  try {
    const upstream = await fetch(`${controlUrl}${pathname}`, {
      method,
      signal: AbortSignal.timeout(method === 'GET' ? 2000 : 120000)
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(text);
  } catch (error) {
    json(response, 503, {
      ok: false,
      backendReady: false,
      spawnReady: false,
      error: BACKEND_STARTING_MESSAGE,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function dockerLogs(service, tail) {
  const safeService = ['trailmate', 'viaproxy', 'dashboard'].includes(service)
    ? service
    : 'trailmate';
  const id = await findServiceContainerId(safeService);
  if (!id) {
    return `${safeService} コンテナが見つかりません`;
  }
  const n = Math.min(Math.max(Number(tail) || 40, 1), 200);
  const result = await dockerRequest(
    'GET',
    `/containers/${id}/logs?stdout=1&stderr=1&timestamps=0&tail=${n}`
  );
  return demuxDockerLogs(result.body).trim() || '(empty)';
}

async function startMicrosoftLogin() {
  if (msLogin.active) {
    return { ok: false, error: 'already running', ...msLogin };
  }

  msLogin = emptyMsLogin();
  msLogin.active = true;

  const before = await readRegisteredAccount();
  let containerId = await findServiceContainerId(viaproxyService);
  if (!containerId) {
    msLogin.active = false;
    msLogin.error = 'ViaProxy コンテナが見つかりません。start.bat で起動してください。';
    msLogin.done = true;
    return { ok: false, error: msLogin.error, ...msLogin };
  }

  try {
    // A previous device-code wait can block the ViaProxy console. Restart for a clean session.
    msLogin.output = 'ViaProxy を準備しています…\n';
    await dockerRequest('POST', `/containers/${containerId}/restart`);
    containerId = await waitForViaProxyHealthy(45000);
    if (!containerId) {
      throw new Error('ViaProxy の再起動待ちがタイムアウトしました');
    }

    const socket = await attachContainer(containerId);
    msAttachSocket = socket;
    let buffer = '';

    socket.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString('utf8'));
      buffer += text;
      msLogin.output = `${msLogin.output}${text}`.slice(-12000);
      parseMsLoginOutput(msLogin.output);

      if (
        /account added|successfully added|Logged in as|login successful|Added account/i.test(
          buffer
        )
      ) {
        msLogin.success = true;
        msLogin.done = true;
        void finalizeMicrosoftLogin(before);
      }
    });

    socket.on('error', (error) => {
      msLogin.error = error.message;
      msLogin.active = false;
      msLogin.done = true;
      msAttachSocket = null;
    });

    socket.on('close', () => {
      msAttachSocket = null;
      if (msLogin.active && !msLogin.done) {
        msLogin.active = false;
        msLogin.done = true;
      }
    });

    // ViaProxy console expects CRLF and needs a moment after attach.
    await sleep(1000);
    socket.write('help\r\n');
    await sleep(800);
    socket.write('account add microsoft\r\n');

    const startedAt = Date.now();
    const poll = setInterval(() => {
      void (async () => {
        if (!msLogin.active) {
          clearInterval(poll);
          return;
        }
        if (Date.now() - startedAt > 180000) {
          clearInterval(poll);
          await cancelMicrosoftLogin(
            'タイムアウトしました。もう一度「ログイン開始」を押してください。'
          );
          return;
        }
        const now = await readRegisteredAccount();
        if (
          now.registered &&
          now.name &&
          (!before.registered || now.name !== before.name || now.count > before.count)
        ) {
          msLogin.success = true;
          msLogin.accountName = now.name;
          msLogin.done = true;
          clearInterval(poll);
          await finalizeMicrosoftLogin(before);
        } else if (msLogin.success) {
          clearInterval(poll);
          await finalizeMicrosoftLogin(before);
        }
      })();
    }, 2000);
  } catch (error) {
    msLogin.active = false;
    msLogin.done = true;
    msLogin.error = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msLogin.error, ...msLogin };
  }

  return { ok: true, ...msLogin };
}

async function finalizeMicrosoftLogin(before) {
  const account = await readRegisteredAccount();
  msLogin.accountName = account.name || msLogin.accountName;
  msLogin.success = msLogin.success || account.registered;
  msLogin.active = false;
  msLogin.done = true;
  try {
    msAttachSocket?.end();
  } catch {
    /* ignore */
  }
  msAttachSocket = null;

  if (msLogin.success) {
    const container = await findServiceContainerId(viaproxyService);
    if (container) {
      await dockerRequest('POST', `/containers/${container}/restart`).catch(() => null);
    }
  }

  if (!msLogin.success && !msLogin.error) {
    msLogin.error = before.registered
      ? 'ログイン完了を確認できませんでした'
      : 'アカウントが保存されませんでした';
  }
}

async function cancelMicrosoftLogin(reason) {
  msLogin.active = false;
  msLogin.done = true;
  if (reason && !msLogin.success) msLogin.error = reason;
  try {
    msAttachSocket?.end();
  } catch {
    /* ignore */
  }
  msAttachSocket = null;
}

function parseMsLoginOutput(output) {
  const urlMatch =
    output.match(/https:\/\/www\.microsoft\.com\/link\S*/i) ||
    output.match(/https:\/\/microsoft\.com\/link\S*/i) ||
    output.match(/https?:\/\/\S*microsoft\S+/i);
  if (urlMatch) {
    msLogin.url = urlMatch[0].replace(/[),.;'"\]]+$/g, '');
  }

  const codeMatch =
    output.match(/enter the code:\s*([A-Z0-9]{4,12})/i) ||
    output.match(/[?&]otc=([A-Z0-9]{4,12})/i) ||
    output.match(/code[:\s]+([A-Z0-9]{4,12})/i);
  if (codeMatch) {
    msLogin.code = codeMatch[1];
  }

  const nameMatch = output.match(/Logged in as[:\s]+(\w+)/i);
  if (nameMatch) {
    msLogin.accountName = nameMatch[1];
    msLogin.success = true;
  }
}

async function waitForViaProxyHealthy(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const id = await findServiceContainerId(viaproxyService);
    if (id) {
      const info = await dockerRequest('GET', `/containers/${id}/json`);
      if (info.status < 400) {
        const body = JSON.parse(info.body.toString('utf8'));
        const health = body?.State?.Health?.Status;
        const running = body?.State?.Running;
        if (running && (health === 'healthy' || health == null)) {
          await sleep(1500);
          return id;
        }
      }
    }
    await sleep(1000);
  }
  return null;
}

function serveStatic(pathname, response) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'logFollow.js', 'retention.js', 'styles.css'].includes(file)) {
    return json(response, 404, { error: 'not found' });
  }
  const full = path.join(publicDir, file);
  const type = file.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/css; charset=utf-8';
  response.writeHead(200, { 'content-type': type });
  createReadStream(full).pipe(response);
}

function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

function matchYaml(text, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const match = text.match(re);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

function upsertYaml(text, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 1_000_000) throw new Error('request too large');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(value));
}
