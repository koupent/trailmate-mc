/* ===== helpers ===== */
const POLL_INTERVAL_MS = 2000;

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

/* ===== DOM ===== */
const settingsForm = document.getElementById('settings-form');
const settingsMsg = document.getElementById('settings-msg');
const placeholderWarn = document.getElementById('placeholder-warn');
const targetAddressInput = document.getElementById('targetAddress');
const botNameInput = document.getElementById('botName');
const minecraftVersionInput = document.getElementById('minecraftVersion');
const authMethodSelect = document.getElementById('authMethod');
const spawnBtn = document.getElementById('spawn-btn');
const despawnBtn = document.getElementById('despawn-btn');
const spawnMsg = document.getElementById('spawn-msg');
const spawnBlockReason = document.getElementById('spawn-block-reason');
const statusPanel = document.getElementById('status-panel');
const msLoginBtn = document.getElementById('ms-login-btn');
const msCancelBtn = document.getElementById('ms-cancel-btn');
const msLoginMsg = document.getElementById('ms-login-msg');
const msLoginPanel = document.getElementById('ms-login-panel');
const msAccountStatus = document.getElementById('ms-account-status');
const msLoginControls = document.getElementById('ms-login-controls');
const msSkipNote = document.getElementById('ms-skip-note');
const setupChecklist = document.getElementById('setup-checklist');
const panelSetup = document.getElementById('panel-setup');
const wizardSlot = document.getElementById('wizard-setup-slot');
const settingsSlot = document.getElementById('settings-setup-slot');
const shellWizard = document.getElementById('shell-wizard');
const shellApp = document.getElementById('shell-app');
const stepServer = document.getElementById('step-server');
const stepAccount = document.getElementById('step-account');
const logsEl = document.getElementById('logs');
const logsDetails = document.getElementById('logs-details');
const refreshLogsBtn = document.getElementById('refresh-logs');
const logsServiceLabel = document.getElementById('logs-service-label');

let currentLogService = 'trailmate';
let lastKnownAccountName = null;
let currentTab = 'operate';
let readyToSpawn = false;

/* ===== mode / tabs ===== */
function applyMode(isReady, settings = {}) {
  const wasReady = readyToSpawn;
  readyToSpawn = Boolean(isReady);
  document.body.classList.toggle('mode-wizard', !readyToSpawn);
  document.body.classList.toggle('mode-app', readyToSpawn);
  shellWizard.classList.toggle('shell-hidden', readyToSpawn);
  shellApp.classList.toggle('shell-hidden', !readyToSpawn);

  panelSetup.hidden = false;
  if (readyToSpawn) {
    settingsSlot.appendChild(panelSetup);
    // ウィザード完了直後だけ運用タブへ戻す（設定タブ閲覧中は維持）
    if (!wasReady) showTab('operate');
  } else {
    wizardSlot.appendChild(panelSetup);
  }

  updateAccountStepVisibility(settings.authMethod === 'NONE');
}

function showTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.getAttribute('data-tab') === tabId;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.id === `tab-${tabId}`;
    panel.classList.toggle('is-active', active);
    panel.hidden = !active;
  });
  if (tabId === 'operate') {
    void refreshStatus();
    void refreshLogs();
  } else if (tabId === 'settings') {
    void refreshMsLogin();
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    showTab(button.getAttribute('data-tab'));
  });
});

/* ===== setup checklist ===== */
function renderSetup(setup, settings = {}) {
  const isReady = Boolean(setup?.readyToSpawn);
  applyMode(isReady, settings);

  if (!setup || isReady) {
    setupChecklist.innerHTML = '';
  } else {
    const items = (setup.steps || [])
      .map((step) => {
        const cls = step.ok ? 'ok' : 'ng';
        const mark = step.ok ? 'OK' : '未完了';
        return `<li class="${cls}">[${mark}] ${escapeHtml(step.label)}</li>`;
      })
      .join('');
    setupChecklist.innerHTML = `<strong class="ng">セットアップを完了してください</strong><ul>${items}</ul>`;
  }

  const serverOk = setup?.steps?.find((s) => s.id === 'server')?.ok;
  const accountOk = setup?.steps?.find((s) => s.id === 'account')?.ok;
  stepServer.classList.toggle('is-done', Boolean(serverOk));
  stepAccount.classList.toggle(
    'is-done',
    Boolean(accountOk) && settings.authMethod !== 'NONE'
  );
  stepAccount.classList.toggle('is-skipped', settings.authMethod === 'NONE');

  spawnBtn.disabled = !isReady;
  if (isReady) {
    spawnBlockReason.classList.add('hidden');
    spawnBlockReason.textContent = '';
  } else {
    spawnBlockReason.classList.remove('hidden');
    spawnBlockReason.textContent = `スポーンできません: ${(setup?.blockers || []).join(' / ')}`;
  }
}

function updateAccountStepVisibility(offline) {
  msLoginControls.classList.toggle('hidden', offline);
  msSkipNote.classList.toggle('hidden', !offline);
  msLoginPanel.classList.toggle('hidden', offline);
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
      '未登録です。新しい PC では「ログイン開始」が必須です（saves.json のコピーは不要・非推奨）。';
    msAccountStatus.className = 'msg err';
  }
}

/* ===== settings ===== */
function fillSettingsForm(settings) {
  targetAddressInput.value = settings.targetAddress || '';
  botNameInput.value = settings.botName || 'Trailmate';
  authMethodSelect.value = settings.authMethod || 'ACCOUNT';
  minecraftVersionInput.value = settings.minecraftVersion || '1.21.6';
  updateAccountStepVisibility(authMethodSelect.value === 'NONE');
}

/** チェックリスト等を更新。fillForm は初回表示・明示的な再読込時のみ。 */
function applySettingsState(settings, { fillForm = false } = {}) {
  if (fillForm) fillSettingsForm(settings);
  placeholderWarn.classList.toggle('hidden', !settings.placeholder);
  renderRegisteredAccount(settings.registeredAccount);
  lastKnownAccountName = settings.registeredAccount?.name || null;
  renderSetup(settings.setup, settings);
}

async function loadSettings({ fillForm = true } = {}) {
  const settings = await api('/api/settings');
  applySettingsState(settings, { fillForm });
  return settings;
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMsg(settingsMsg, '保存中…');
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        targetAddress: targetAddressInput.value.trim(),
        botName: botNameInput.value.trim(),
        authMethod: authMethodSelect.value,
        minecraftVersion: minecraftVersionInput.value.trim()
      })
    });
    setMsg(settingsMsg, '保存しました（ViaProxy を再起動しました）', 'ok');
    if (result.settings) {
      applySettingsState(result.settings, { fillForm: false });
    }
  } catch (error) {
    setMsg(settingsMsg, error.message, 'err');
  }
});

authMethodSelect.addEventListener('change', () => {
  updateAccountStepVisibility(authMethodSelect.value === 'NONE');
});

/* ===== spawn / status ===== */
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
    spawnBtn.disabled = !readyToSpawn;
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

/* ===== microsoft login ===== */
msLoginBtn.addEventListener('click', async () => {
  msLoginBtn.disabled = true;
  setMsg(msLoginMsg, '開始中…');
  try {
    await api('/api/ms-login/start', { method: 'POST' });
    setMsg(msLoginMsg, '下の URL を開いてログインしてください', 'ok');
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

function buildMsLoginLines(state) {
  const lines = [];
  if (state.url) lines.push(`1. この URL を開く: ${state.url}`);
  if (state.code) lines.push(`2. コード（自動入力されないとき）: ${state.code}`);
  if (state.active && state.url) {
    lines.push('3. ボット用 Microsoft アカウントでログインし、完了を待つ');
  }
  if (state.success && state.accountName) {
    lines.push(`完了: ${state.accountName} を登録しました`);
    setMsg(msLoginMsg, `登録完了: ${state.accountName}`, 'ok');
  } else if (state.error && state.error !== 'cancelled by user') {
    lines.push(`エラー: ${state.error}`);
    setMsg(msLoginMsg, state.error, 'err');
  } else if (state.active) {
    lines.push(state.url ? 'ログイン待ち…' : 'ViaProxy に接続中…');
  } else if (!state.url && !state.done) {
    lines.push('「ログイン開始」を押すと、ここに URL とコードが表示されます。');
  }
  if (!lines.length && state.output) {
    lines.push(state.output.slice(-500));
  }
  return lines;
}

async function refreshMsLogin() {
  try {
    const state = await api('/api/ms-login');
    renderRegisteredAccount(state.registeredAccount);

    // アカウント変化時のみセットアップを更新（フォームは上書きしない）
    const accountName =
      state.registeredAccount?.name || state.accountName || null;
    if (accountName && accountName !== lastKnownAccountName) {
      await loadSettings({ fillForm: false });
      lastKnownAccountName = accountName;
    }

    msLoginPanel.textContent = buildMsLoginLines(state).join('\n');
  } catch (error) {
    msLoginPanel.textContent = error.message;
  }
}

/* ===== logs ===== */
function updateLogButtons() {
  document.querySelectorAll('[data-log]').forEach((button) => {
    button.classList.toggle('is-active', button.getAttribute('data-log') === currentLogService);
  });
  logsServiceLabel.textContent = `表示中: ${currentLogService}`;
}

async function refreshLogs() {
  try {
    const data = await api(`/api/logs?service=${encodeURIComponent(currentLogService)}&tail=50`);
    logsEl.textContent = data.logs || '(empty)';
    updateLogButtons();
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

logsDetails?.addEventListener('toggle', (event) => {
  if (event.currentTarget.open) void refreshLogs();
});

/* ===== boot / polling ===== */
async function boot() {
  await loadSettings({ fillForm: true });
  if (readyToSpawn) {
    await refreshStatus();
    await refreshLogs();
  } else {
    await refreshMsLogin();
  }
}

void boot();

setInterval(() => {
  if (!readyToSpawn) {
    void refreshMsLogin();
    return;
  }
  if (currentTab === 'operate') {
    void refreshStatus();
  } else if (currentTab === 'settings') {
    void refreshMsLogin();
  }
}, POLL_INTERVAL_MS);
