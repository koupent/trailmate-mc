const settingsForm = document.getElementById('settings-form');
const settingsMsg = document.getElementById('settings-msg');
const placeholderWarn = document.getElementById('placeholder-warn');
const spawnBtn = document.getElementById('spawn-btn');
const despawnBtn = document.getElementById('despawn-btn');
const spawnMsg = document.getElementById('spawn-msg');
const statusPanel = document.getElementById('status-panel');
const msLoginBtn = document.getElementById('ms-login-btn');
const msCancelBtn = document.getElementById('ms-cancel-btn');
const msLoginMsg = document.getElementById('ms-login-msg');
const msLoginPanel = document.getElementById('ms-login-panel');
const msAccountStatus = document.getElementById('ms-account-status');
const setupChecklist = document.getElementById('setup-checklist');
const logsEl = document.getElementById('logs');
const refreshLogsBtn = document.getElementById('refresh-logs');

let currentLogService = 'trailmate';

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }
  return data;
}

function setMsg(el, text, kind = '') {
  el.textContent = text || '';
  el.className = `msg ${kind}`.trim();
}

function renderSetup(setup) {
  if (!setup) {
    setupChecklist.innerHTML = '';
    return;
  }
  const items = (setup.steps || [])
    .map((step) => {
      const cls = step.ok ? 'ok' : 'ng';
      const mark = step.ok ? 'OK' : '未完了';
      return `<li class="${cls}">[${mark}] ${escapeHtml(step.label)}</li>`;
    })
    .join('');
  const summary = setup.readyToSpawn
    ? '<strong class="ok">スポーン準備完了</strong>'
    : '<strong class="ng">スポーン前に下を完了してください（既存の saves.json には依存しません）</strong>';
  setupChecklist.innerHTML = `${summary}<ul>${items}</ul>`;
  spawnBtn.disabled = !setup.readyToSpawn;
}

function renderRegisteredAccount(account) {
  if (!account) {
    msAccountStatus.textContent = '登録状態不明';
    msAccountStatus.className = 'msg';
    return;
  }
  if (account.registered && account.name) {
    msAccountStatus.textContent = `登録済み: ${account.name}（${account.count}件）`;
    msAccountStatus.className = 'msg ok';
  } else {
    msAccountStatus.textContent =
      '未登録です。新しいPCでは「ログイン開始」が必須です（saves.json のコピーは不要・非推奨）。';
    msAccountStatus.className = 'msg err';
  }
}

async function loadSettings() {
  const settings = await api('/api/settings');
  document.getElementById('targetAddress').value = settings.targetAddress || '';
  document.getElementById('botName').value = settings.botName || 'Trailmate';
  document.getElementById('authMethod').value = settings.authMethod || 'ACCOUNT';
  document.getElementById('minecraftVersion').value = settings.minecraftVersion || '1.21.6';
  placeholderWarn.classList.toggle('hidden', !settings.placeholder);
  renderRegisteredAccount(settings.registeredAccount);
  renderSetup(settings.setup);
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMsg(settingsMsg, '保存中…');
  try {
    const body = {
      targetAddress: document.getElementById('targetAddress').value.trim(),
      botName: document.getElementById('botName').value.trim(),
      authMethod: document.getElementById('authMethod').value,
      minecraftVersion: document.getElementById('minecraftVersion').value.trim()
    };
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    setMsg(settingsMsg, '保存しました（ViaProxy を再起動しました）', 'ok');
    placeholderWarn.classList.toggle('hidden', !result.settings?.placeholder);
    renderRegisteredAccount(result.settings?.registeredAccount);
    renderSetup(result.settings?.setup);
  } catch (error) {
    setMsg(settingsMsg, error.message, 'err');
  }
});

spawnBtn.addEventListener('click', async () => {
  spawnBtn.disabled = true;
  setMsg(spawnMsg, 'スポーン中…');
  try {
    const result = await api('/api/spawn', { method: 'POST' });
    if (!result.ok) throw new Error(result.error || 'スポーンに失敗しました');
    setMsg(spawnMsg, 'スポーンしました', 'ok');
    await refreshStatus();
  } catch (error) {
    setMsg(spawnMsg, error.message, 'err');
  } finally {
    spawnBtn.disabled = false;
  }
});

despawnBtn.addEventListener('click', async () => {
  despawnBtn.disabled = true;
  setMsg(spawnMsg, 'デスポーン中…');
  try {
    const result = await api('/api/despawn', { method: 'POST' });
    if (!result.ok) throw new Error(result.error || 'デスポーンに失敗しました');
    setMsg(spawnMsg, 'デスポーンしました', 'ok');
    await refreshStatus();
  } catch (error) {
    setMsg(spawnMsg, error.message, 'err');
  } finally {
    despawnBtn.disabled = false;
  }
});

function renderStatus(status) {
  if (!status || status.error) {
    statusPanel.innerHTML = `<div class="msg err">${status?.error || 'ステータス取得失敗'}</div>`;
    return;
  }

  if (!status.spawned) {
    const err = status.lastError
      ? `<div class="msg err">前回のエラー: ${escapeHtml(status.lastError)}</div>`
      : '';
    statusPanel.innerHTML = `
      <div><span class="pill off">未スポーン</span> ${escapeHtml(status.botName || '')}</div>
      <div class="muted">${status.spawning ? '接続処理中…' : 'ワールドには出ていません。時間は進みません。'}</div>
      ${err}
    `;
    return;
  }

  const pos = status.position
    ? `${status.position.x}, ${status.position.y}, ${status.position.z}`
    : '-';
  const inv = Array.isArray(status.inventory) && status.inventory.length
    ? `<ul class="inv">${status.inventory
        .map((item) => `<li>${escapeHtml(item.name)} × ${item.count}</li>`)
        .join('')}</ul>`
    : '<div class="muted">持ち物なし</div>';

  statusPanel.innerHTML = `
    <div><span class="pill on">スポーン中</span> ${escapeHtml(status.username || status.botName || '')}</div>
    <div>HP: ${fmt(status.health)} / 空腹: ${fmt(status.food)}</div>
    <div>座標: ${escapeHtml(pos)}</div>
    <div>ディメンション: ${escapeHtml(status.dimension || '-')}</div>
    <div>オーナー: ${escapeHtml(status.ownerName || '未ロック')}</div>
    <div>希望モード: <strong>${escapeHtml(status.preferredMode || '-')}</strong></div>
    <div>動作中 FSM: <strong>${escapeHtml(status.activeFsm || '-')}</strong></div>
    <div>持ち物:${inv}</div>
  `;
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    renderStatus(status);
  } catch (error) {
    renderStatus({ error: error.message });
  }
}

msLoginBtn.addEventListener('click', async () => {
  msLoginBtn.disabled = true;
  setMsg(msLoginMsg, '開始中…');
  try {
    await api('/api/ms-login/start', { method: 'POST' });
    setMsg(msLoginMsg, '下のURLを開いてログインしてください', 'ok');
    await refreshMsLogin();
  } catch (error) {
    setMsg(msLoginMsg, error.message, 'err');
  } finally {
    msLoginBtn.disabled = false;
  }
});

msCancelBtn.addEventListener('click', async () => {
  try {
    await api('/api/ms-login/cancel', { method: 'POST' });
    setMsg(msLoginMsg, 'キャンセルしました');
    await refreshMsLogin();
  } catch (error) {
    setMsg(msLoginMsg, error.message, 'err');
  }
});

async function refreshMsLogin() {
  try {
    const state = await api('/api/ms-login');
    renderRegisteredAccount(state.registeredAccount);

    const lines = [];
    if (state.url) {
      lines.push(`1. このURLを開く: ${state.url}`);
    }
    if (state.code) {
      lines.push(`2. コード（自動入力されないとき）: ${state.code}`);
    }
    if (state.active && state.url) {
      lines.push('3. ボット用 Microsoft アカウントでログインし、完了を待つ');
    }
    if (state.success && state.accountName) {
      lines.push(`完了: ${state.accountName} を登録しました`);
      setMsg(msLoginMsg, `登録完了: ${state.accountName}`, 'ok');
    } else if (state.error) {
      lines.push(`エラー: ${state.error}`);
      setMsg(msLoginMsg, state.error, 'err');
    } else if (state.active) {
      lines.push(state.url ? 'ログイン待ち…' : 'ViaProxy に接続中…');
    } else if (!state.url && !state.done) {
      lines.push('「ログイン開始」を押すと、ここにURLとコードが表示されます。');
    }

    if (!lines.length && state.output) {
      lines.push(state.output.slice(-500));
    }
    msLoginPanel.textContent = lines.join('\n');
  } catch (error) {
    msLoginPanel.textContent = error.message;
  }
}

async function refreshLogs() {
  try {
    const data = await api(`/api/logs?service=${encodeURIComponent(currentLogService)}&tail=50`);
    logsEl.textContent = data.logs || '(empty)';
  } catch (error) {
    logsEl.textContent = error.message;
  }
}

document.querySelectorAll('[data-log]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLogService = button.getAttribute('data-log');
    void refreshLogs();
  });
});
refreshLogsBtn.addEventListener('click', () => void refreshLogs());

function fmt(value) {
  return value == null ? '-' : String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

void loadSettings();
void refreshStatus();
void refreshLogs();
void refreshMsLogin();
setInterval(() => {
  void refreshStatus();
  void refreshMsLogin();
}, 2000);
