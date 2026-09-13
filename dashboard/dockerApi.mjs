import http from 'node:http';
import { spawn } from 'node:child_process';

const dockerSock = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const composeProject = process.env.COMPOSE_PROJECT_NAME || 'trailmate-mc';

/**
 * @param {string} method
 * @param {string} requestPath
 * @param {unknown} [body]
 */
export function dockerRequest(method, requestPath, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (body != null) {
      payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      {
        socketPath: dockerSock,
        path: requestPath,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 500,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {string} service
 */
export async function findServiceContainerId(service) {
  const result = await dockerRequest('GET', '/containers/json');
  if (result.status >= 400) {
    throw new Error(`docker list failed: ${result.body.toString('utf8').slice(0, 200)}`);
  }
  const list = JSON.parse(result.body.toString('utf8'));
  const match = list.find((container) => {
    const labels = container.Labels || {};
    const project = labels['com.docker.compose.project'];
    const svc = labels['com.docker.compose.service'];
    if (svc === service && (!project || project === composeProject)) return true;
    return (container.Names || []).some((name) =>
      String(name).includes(`${composeProject}-${service}`)
    );
  });
  return match?.Id || null;
}

/**
 * @param {string} containerId
 * @returns {Promise<import('node:net').Socket>}
 */
export function attachContainer(containerId) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: dockerSock,
        path: `/containers/${containerId}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        method: 'POST',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'tcp',
          'Content-Type': 'application/vnd.docker.raw-stream'
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          reject(
            new Error(
              `ViaProxy attach failed (${res.statusCode}): ${Buffer.concat(chunks)
                .toString('utf8')
                .slice(0, 300)}`
            )
          );
        });
      }
    );
    req.on('upgrade', (_res, socket) => resolve(socket));
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {Buffer} buffer
 */
export function demuxDockerLogs(buffer) {
  if (!buffer.length) return '';
  let offset = 0;
  const parts = [];
  const looksMultiplexed = buffer.length >= 8 && buffer[0] <= 2;
  if (!looksMultiplexed) {
    return stripAnsi(buffer.toString('utf8'));
  }
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break;
    parts.push(buffer.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return stripAnsi(parts.join(''));
}

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * @param {string} imageRef e.g. ghcr.io/koupent/trailmate-mc:latest
 * @param {(line: string) => void} [onProgress]
 */
export async function pullImage(imageRef, onProgress) {
  const lastColon = imageRef.lastIndexOf(':');
  const slash = imageRef.lastIndexOf('/');
  const tag =
    lastColon > slash && lastColon !== -1 ? imageRef.slice(lastColon + 1) : 'latest';
  const repo =
    lastColon > slash && lastColon !== -1 ? imageRef.slice(0, lastColon) : imageRef;
  const requestPath =
    '/images/create?fromImage=' +
    encodeURIComponent(repo) +
    '&tag=' +
    encodeURIComponent(tag);

  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: dockerSock,
        path: requestPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.error) {
                reject(new Error(msg.error));
                return;
              }
              const text = [msg.status, msg.progress].filter(Boolean).join(' ');
              if (text && onProgress) onProgress(text);
            } catch {
              if (onProgress) onProgress(line);
            }
          }
        });
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error('image pull failed: HTTP ' + res.statusCode));
          } else {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Pull the container's current image tag, then recreate with the same mounts/env.
 * @param {string} service
 * @param {(line: string) => void} [onProgress]
 * @param {{ selfReplace?: boolean }} [options]
 *   selfReplace: 自分自身（dashboard）を更新するとき。停止でプロセスが死ぬ前に
 *   差し替え用コンテナを別プロセスで起動する。
 */
export async function recreateServiceContainer(service, onProgress, options = {}) {
  const id = await findServiceContainerId(service);
  if (!id) throw new Error(service + ' コンテナが見つかりません');

  const inspected = await dockerRequest('GET', '/containers/' + id + '/json');
  if (inspected.status >= 400) {
    throw new Error(service + ' の inspect に失敗しました');
  }
  const info = JSON.parse(inspected.body.toString('utf8'));
  const name = String(info.Name || '').replace(/^\//, '');
  const image = info.Config?.Image;
  if (!image) throw new Error(service + ' のイメージ名が空です');

  if (onProgress) onProgress('[pull] ' + image);
  await pullImage(image, onProgress);

  const networks = info.NetworkSettings?.Networks || {};
  const createBody = {
    Hostname: info.Config.Hostname,
    Domainname: info.Config.Domainname,
    User: info.Config.User,
    AttachStdin: info.Config.AttachStdin,
    AttachStdout: info.Config.AttachStdout,
    AttachStderr: info.Config.AttachStderr,
    Tty: info.Config.Tty,
    OpenStdin: info.Config.OpenStdin,
    StdinOnce: info.Config.StdinOnce,
    Env: info.Config.Env,
    Cmd: info.Config.Cmd,
    Healthcheck: info.Config.Healthcheck,
    ArgsEscaped: info.Config.ArgsEscaped,
    Image: image,
    Volumes: info.Config.Volumes,
    WorkingDir: info.Config.WorkingDir,
    Entrypoint: info.Config.Entrypoint,
    Labels: info.Config.Labels,
    ExposedPorts: info.Config.ExposedPorts,
    HostConfig: info.HostConfig,
    NetworkingConfig: { EndpointsConfig: networks }
  };

  if (options.selfReplace) {
    return replaceContainerExternally(id, name, createBody, onProgress);
  }

  if (onProgress) onProgress('[recreate] stop ' + name);
  // trailmate は quit でサーバーセッションを切るため、猶予を長めに取る
  const stopTimeout = service === 'trailmate' ? 40 : 20;
  await dockerRequest('POST', '/containers/' + id + '/stop?t=' + stopTimeout);
  await dockerRequest('DELETE', '/containers/' + id + '?v=0');

  const created = await dockerRequest(
    'POST',
    '/containers/create?name=' + encodeURIComponent(name),
    createBody
  );
  if (created.status >= 400) {
    throw new Error(
      service + ' の create に失敗: ' + created.body.toString('utf8').slice(0, 300)
    );
  }
  const newId = JSON.parse(created.body.toString('utf8')).Id;
  if (onProgress) onProgress('[recreate] start ' + name);
  const started = await dockerRequest('POST', '/containers/' + newId + '/start');
  if (started.status >= 400) {
    throw new Error(
      service + ' の start に失敗: ' + started.body.toString('utf8').slice(0, 300)
    );
  }
  return newId;
}

/**
 * dashboard 自己更新用: 新コンテナを先に作り、差し替えは別コンテナに任せる。
 * @param {string} oldId
 * @param {string} name
 * @param {object} createBody
 * @param {(line: string) => void} [onProgress]
 */
async function replaceContainerExternally(oldId, name, createBody, onProgress) {
  const tempName = name + '-next';
  const swapperName = composeProject + '-dash-swap';

  await dockerRequest('DELETE', '/containers/' + encodeURIComponent(tempName) + '?force=1').catch(
    () => null
  );
  await dockerRequest('DELETE', '/containers/' + encodeURIComponent(swapperName) + '?force=1').catch(
    () => null
  );

  if (onProgress) onProgress('[recreate] create replacement ' + tempName);
  const created = await dockerRequest(
    'POST',
    '/containers/create?name=' + encodeURIComponent(tempName),
    createBody
  );
  if (created.status >= 400) {
    throw new Error(
      'dashboard の create に失敗: ' + created.body.toString('utf8').slice(0, 300)
    );
  }
  const newId = JSON.parse(created.body.toString('utf8')).Id;

  const updated = await dockerRequest('POST', '/containers/' + oldId + '/update', {
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }
  });
  if (updated.status >= 400 && onProgress) {
    onProgress(
      '[recreate] warn: restart policy update failed: ' +
        updated.body.toString('utf8').slice(0, 200)
    );
  }

  const script = [
    'set -e',
    'echo "[swap] begin"',
    'docker update --restart=no "' + name + '" || true',
    'echo "[swap] stop old"',
    'docker stop -t 15 "' + name + '" || true',
    'docker rm -f "' + name + '" || true',
    'echo "[swap] rename new"',
    'docker rename "' + tempName + '" "' + name + '"',
    'docker update --restart=unless-stopped "' + name + '" || true',
    'echo "[swap] start"',
    'docker start "' + name + '"',
    'echo "[swap] DONE"'
  ].join('\n');

  if (onProgress) onProgress('[recreate] hand off swap to ' + swapperName);
  const runOut = await new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'run',
        '-d',
        '--name',
        swapperName,
        '-v',
        dockerSock + ':/var/run/docker.sock',
        'docker:27.5.1-cli',
        'sh',
        '-c',
        script
      ],
      { env: process.env }
    );
    const chunks = [];
    const errs = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => errs.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8').trim();
      const stderr = Buffer.concat(errs).toString('utf8').trim();
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            'swapper 起動終了コード ' + code + ' ' + (stderr || stdout).slice(0, 300)
          )
        );
    });
  });
  if (onProgress) onProgress('[recreate] swapper id ' + runOut);

  await new Promise((r) => setTimeout(r, 1500));
  return newId;
}

