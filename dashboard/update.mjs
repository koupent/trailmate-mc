import fs from 'node:fs/promises';
import path from 'node:path';
import { recreateServiceContainer, findServiceContainerId } from './dockerApi.mjs';
import { spawn } from 'node:child_process';

const githubRepo = process.env.GITHUB_REPO || 'koupent/trailmate-mc';
const DEFAULT_DESPAWN_GRACE_MS = 4000;
const updateServices = ['trailmate', 'dashboard'];

/**
 * @param {string} projectRoot
 * @param {{
 *   recreateServiceContainer?: typeof recreateServiceContainer,
 *   fetch?: typeof fetch,
 *   despawnGraceMs?: number
 * }} [deps]
 */
export function createUpdateManager(projectRoot, deps = {}) {
  const versionFile = path.join(projectRoot, 'VERSION');
  const logFile = path.join(projectRoot, 'data', 'update.log');
  const stateFile = path.join(projectRoot, 'data', 'update-state.json');
  const lockFile = path.join(projectRoot, 'data', 'update.lock');
  const recreate = deps.recreateServiceContainer || recreateServiceContainer;
  const fetchFn = deps.fetch || globalThis.fetch;
  // サーバーがセッションを落とすのを待つ猶予（テストからは 0 にできる）
  const despawnGraceMs = Number.isFinite(deps.despawnGraceMs)
    ? Math.max(0, Number(deps.despawnGraceMs))
    : DEFAULT_DESPAWN_GRACE_MS;

  /** @type {{ active: boolean, startedAt: number | null, finishedAt: number | null, ok: boolean | null, error: string | null, targetVersion: string | null, log: string }} */
  let job = emptyJob();

  return { getStatus, getLogs, startApply };

  async function getStatus() {
    await hydrateJobFromDisk();
    const currentVersion = await readCurrentVersion();
    let latest = null;
    let latestError = null;
    try {
      latest = await fetchLatestRelease();
    } catch (error) {
      latestError = error instanceof Error ? error.message : String(error);
    }

    const latestVersion = latest?.tag || null;
    const updating = job.active || (await hasLock());
    const updateAvailable = Boolean(
      !updating &&
        latestVersion &&
        normalizeTag(latestVersion) !== normalizeTag(currentVersion)
    );

    return {
      currentVersion,
      latestVersion,
      latestUrl: latest?.url || null,
      latestName: latest?.name || null,
      updateAvailable,
      updating,
      lastJob: {
        ok: job.ok,
        error: job.error,
        targetVersion: job.targetVersion,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
      },
      latestError,
      githubRepo
    };
  }

  async function getLogs() {
    await hydrateJobFromDisk();
    const updating = job.active || (await hasLock());
    return {
      updating,
      log: job.log || '(ログなし)',
      ok: job.ok,
      error: job.error,
      targetVersion: job.targetVersion
    };
  }

  /**
   * @param {{ targetVersion?: string }} [options]
   */
  async function startApply(options = {}) {
    await hydrateJobFromDisk();
    if (job.active || (await hasLock())) {
      return {
        ...(await getLogs()),
        ok: false,
        error: 'すでに更新を実行中です'
      };
    }

    const status = await getStatus();
    const targetVersion = options.targetVersion || status.latestVersion;
    if (!targetVersion) {
      return {
        ...(await getLogs()),
        ok: false,
        error: status.latestError || '最新リリースを取得できませんでした'
      };
    }

    job = emptyJob();
    job.active = true;
    job.startedAt = Date.now();
    job.targetVersion = targetVersion;
    appendLog('更新開始: ' + targetVersion);
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, String(Date.now()), 'utf8');
    await persistJob();

    void runUpdater(targetVersion).catch(async (error) => {
      job.active = false;
      job.finishedAt = Date.now();
      job.ok = false;
      job.error = error instanceof Error ? error.message : String(error);
      appendLog('失敗: ' + job.error);
      await clearLock();
      await persistJob();
    });

    return {
      ...(await getLogs()),
      ok: true,
      started: true,
      targetVersion
    };
  }

  async function readCurrentVersion() {
    try {
      const text = (await fs.readFile(versionFile, 'utf8')).trim();
      if (text) return text;
    } catch {
      /* missing */
    }
    const fromEnv = String(process.env.TRAILMATE_VERSION || process.env.DASHBOARD_VERSION || '').trim();
    if (fromEnv && fromEnv !== 'dev') return fromEnv;
    return fromEnv || 'dev';
  }

  async function fetchLatestRelease() {
    const url = 'https://api.github.com/repos/' + githubRepo + '/releases/latest';
    const response = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trailmate-dashboard'
      }
    });
    if (response.status === 404) {
      throw new Error('GitHub Release がまだありません（v* タグを作成してください）');
    }
    if (!response.ok) {
      throw new Error('GitHub API エラー: HTTP ' + response.status);
    }
    const data = await response.json();
    const tag = String(data.tag_name || '').trim();
    if (!tag) throw new Error('最新 Release に tag_name がありません');
    return {
      tag,
      name: data.name || tag,
      url: data.html_url || 'https://github.com/' + githubRepo + '/releases/tag/' + tag
    };
  }

  async function hasLock() {
    try {
      await fs.access(lockFile);
      return true;
    } catch {
      return false;
    }
  }

  async function clearLock() {
    await fs.unlink(lockFile).catch(() => null);
  }

  async function hydrateJobFromDisk() {
    // 実行中・またはこのプロセスで開始済みのジョブは、ポーリングでディスクに潰さない。
    // （未 flush 行の消失や、完了直前の STALE 読み込みを防ぐ）
    if (job.active || job.startedAt) return;
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      job = { ...emptyJob(), ...raw, active: false };
      try {
        job.log = await fs.readFile(logFile, 'utf8');
      } catch {
        /* ignore */
      }
    } catch {
      /* no state yet */
    }
  }

  async function persistJob() {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const { log, ...rest } = job;
    await fs.writeFile(stateFile, JSON.stringify(rest, null, 2), 'utf8').catch(() => null);
    await fs.writeFile(logFile, log || '', 'utf8').catch(() => null);
  }

  /**
   * @param {string} targetVersion
   */
  async function runUpdater(targetVersion) {
    await fs.mkdir(path.dirname(logFile), { recursive: true });

    const onProgress = (line) => {
      appendLog(line);
      void persistJob();
    };

    // dashboard 以外を先に更新し、VERSION を書いてから自身を更新する
    for (const service of updateServices) {
      if (service === 'dashboard') continue;
      if (service === 'trailmate') {
        await softDespawnTrailmate(onProgress);
      }
      appendLog('[updater] recreate ' + service);
      await persistJob();
      await recreate(service, onProgress);
      if (service === 'trailmate') {
        await syncItemsJaLocale(onProgress);
      }
    }

    await fs.writeFile(versionFile, targetVersion + '\n', 'utf8');
    appendLog('[updater] VERSION=' + targetVersion);

    job.active = false;
    job.finishedAt = Date.now();
    job.ok = true;
    job.error = null;
    appendLog('[updater] recreate dashboard（接続が切れることがあります。再読み込みしてください）');
    await persistJob();
    await clearLock();

    try {
      await recreate('dashboard', onProgress, { selfReplace: true });
      appendLog('[updater] DONE（dashboard 差し替えを起動済み）');
      await persistJob();
    } catch (error) {
      appendLog(
        'dashboard 差し替えの起動に失敗: ' +
          (error instanceof Error ? error.message : String(error))
      );
      await persistJob();
    }
  }

  function appendLog(text) {
    const chunk = String(text).replace(/\s+$/g, '');
    if (!chunk) return;
    job.log = (job.log + chunk + '\n').slice(-20000);
  }

  /**
   * trailmate 再作成前にクリーン切断し、サーバー側の duplicate_login を減らす。
   * @param {(line: string) => void} [onProgress]
   */
  async function softDespawnTrailmate(onProgress) {
    const control = String(
      process.env.TRAILMATE_CONTROL_URL || 'http://trailmate:8790'
    ).replace(/\/$/, '');
    try {
      onProgress?.('[updater] despawn trailmate before recreate');
      appendLog('[updater] despawn trailmate before recreate');
      await fetchFn(control + '/despawn', {
        method: 'POST',
        signal: AbortSignal.timeout(15000)
      });
      // サーバーがセッションを落とす猶予
      if (despawnGraceMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, despawnGraceMs));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onProgress?.('[updater] despawn skipped: ' + detail);
      appendLog('[updater] despawn skipped: ' + detail);
    }
  }

  /**
   * ホストの ./locales は volume でイメージを上書きするため、
   * 更新後に同梱の items-ja.json をホストへ書き戻す。
   * @param {(line: string) => void} [onProgress]
   */
  async function syncItemsJaLocale(onProgress) {
    try {
      const id = await findServiceContainerId('trailmate');
      if (!id) {
        onProgress?.('[updater] items-ja sync skipped: trailmate missing');
        return;
      }
      const destDir = path.join(projectRoot, 'locales');
      await fs.mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, 'items-ja.json');
      // イメージ内は volume の外（src/i18n）に同梱する
      const srcInContainer = id + ':/app/src/i18n/items-ja.json';
      onProgress?.('[updater] sync items-ja.json to host locales');
      appendLog('[updater] sync items-ja.json to host locales');
      await new Promise((resolve, reject) => {
        const child = spawn('docker', ['cp', srcInContainer, dest], {
          env: process.env
        });
        const errs = [];
        child.stderr.on('data', (c) => errs.push(c));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(undefined);
          else {
            reject(
              new Error(
                'docker cp failed: ' + Buffer.concat(errs).toString('utf8').slice(0, 200)
              )
            );
          }
        });
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onProgress?.('[updater] items-ja sync skipped: ' + detail);
      appendLog('[updater] items-ja sync skipped: ' + detail);
    }
  }
}

function emptyJob() {
  return {
    active: false,
    startedAt: null,
    finishedAt: null,
    ok: null,
    error: null,
    targetVersion: null,
    log: ''
  };
}

/**
 * @param {string} tag
 */
export function normalizeTag(tag) {
  return String(tag || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}
