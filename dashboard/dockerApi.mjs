import http from 'node:http';

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
