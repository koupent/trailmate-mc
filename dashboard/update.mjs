import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const githubRepo = process.env.GITHUB_REPO || 'koupent/trailmate-mc';
const dockerSock = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const composeProject = process.env.COMPOSE_PROJECT_NAME || 'trailmate-mc';
const updaterImage = process.env.UPDATE_IMAGE || 'alpine:3.20';

/**
 * @param {string} projectRoot
 */
export function createUpdateManager(projectRoot) {
  const versionFile = path.join(projectRoot, 'VERSION');
  const logFile = path.join(projectRoot, 'data', 'update.log');
  const stateFile = path.join(projectRoot, 'data', 'update-state.json');

  /** @type {{ active: boolean, startedAt: number | null, finishedAt: number | null, ok: boolean | null, error: string | null, targetVersion: string | null, log: string }} */
  let job = emptyJob();

  return {
    getStatus,
    getLogs,
    startApply
  };

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
    const updateAvailable = Boolean(
      latestVersion && normalizeTag(latestVersion) !== normalizeTag(currentVersion)
    );

    return {
      currentVersion,
      latestVersion,
      latestUrl: latest?.url || null,
      latestName: latest?.name || null,
      updateAvailable,
      updating: job.active || (await isUpdaterContainerRunning()),
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
    const updating = job.active || (await isUpdaterContainerRunning());
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
    if (job.active || (await isUpdaterContainerRunning())) {
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
    await persistJob();

    void runUpdater(targetVersion).catch(async (error) => {
      job.active = false;
      job.finishedAt = Date.now();
      job.ok = false;
      job.error = error instanceof Error ? error.message : String(error);
      appendLog('失敗: ' + job.error);
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
      /* missing VERSION is normal for git clone */
    }

    const fromEnv = String(process.env.TRAILMATE_VERSION || process.env.DASHBOARD_VERSION || '').trim();
    if (fromEnv && fromEnv !== 'dev') return fromEnv;
    return fromEnv || 'dev';
  }

  async function fetchLatestRelease() {
    const url = 'https://api.github.com/repos/' + githubRepo + '/releases/latest';
    const response = await fetch(url, {
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

  async function isUpdaterContainerRunning() {
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          'docker',
          ['ps', '-q', '-f', 'name=' + composeProject + '-updater'],
          { env: process.env }
        );
        const chunks = [];
        child.stdout.on('data', (c) => chunks.push(c));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks).toString('utf8').trim());
          else resolve('');
        });
      });
      return Boolean(result);
    } catch {
      return false;
    }
  }

  async function hydrateJobFromDisk() {
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      job = {
        ...emptyJob(),
        ...raw,
        active: false
      };
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

    const script = [
      'set -e',
      'echo "[updater] pull trailmate dashboard"',
      'docker-compose pull trailmate dashboard',
      'echo "[updater] recreate trailmate"',
      'docker-compose up -d --no-deps trailmate',
      "printf '%s\\n' '" + shellQuote(targetVersion) + "' > VERSION",
      'echo "[updater] recreate dashboard (接続が切れることがあります)"',
      'docker-compose up -d --no-deps dashboard',
      'echo "[updater] DONE"'
    ].join('\n');

    const dockerBin = '/usr/local/bin/docker';
    const composeBin = '/usr/local/bin/docker-compose';
    if (!existsSync(dockerBin) || !existsSync(composeBin)) {
      throw new Error('docker / docker-compose がダッシュボードイメージにありません');
    }

    const args = [
      'run',
      '--rm',
      '--name',
      composeProject + '-updater',
      '-v',
      dockerSock + ':/var/run/docker.sock',
      '-v',
      projectRoot + ':/project',
      '-v',
      dockerBin + ':/usr/local/bin/docker:ro',
      '-v',
      composeBin + ':/usr/local/bin/docker-compose:ro',
      '-w',
      '/project',
      '-e',
      'COMPOSE_PROJECT_NAME=' + composeProject,
      '--entrypoint',
      'sh',
      updaterImage,
      '-c',
      script
    ];

    appendLog('updater コンテナを起動します（' + updaterImage + '）');
    await persistJob();

    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        env: process.env,
        cwd: projectRoot
      });
      child.stdout.on('data', (chunk) => {
        appendLog(chunk.toString('utf8'));
        void persistJob();
      });
      child.stderr.on('data', (chunk) => {
        appendLog(chunk.toString('utf8'));
        void persistJob();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error('updater 終了コード ' + code));
      });
    });

    job.active = false;
    job.finishedAt = Date.now();
    job.ok = true;
    job.error = null;
    appendLog('更新完了。ページを再読み込みしてください。');
    await persistJob();
  }

  function appendLog(text) {
    const chunk = String(text).replace(/\s+$/g, '');
    if (!chunk) return;
    job.log = (job.log + chunk + '\n').slice(-20000);
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

/**
 * @param {string} value
 */
function shellQuote(value) {
  return String(value).replace(/'/g, "'\\''");
}
