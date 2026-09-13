import { createLogFollowState } from './logFollow.js';

/* ===== helpers ===== */
const POLL_INTERVAL_MS = 2000;
const updateLogFollow = createLogFollowState();

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
const refreshLogsBtn = document.getElementById('refresh-logs');
const logsServiceLabel = document.getElementById('logs-service-label');
const updatePanel = document.getElementById('update-panel');
const updateZone = document.getElementById('update-zone');
const updateExpand = document.getElementById('update-expand');
const updateCheckBtn = document.getElementById('update-check-btn');
const updateApplyBtn = document.getElementById('update-apply-btn');
const updateMsg = document.getElementById('update-msg');
const updateLogsEl = document.getElementById('update-logs');
const updateLogsDetails = document.getElementById('update-logs-details');


let currentLogService = 'trailmate';
let lastKnownAccountName = null;
let currentTab = 'operate';
let readyToSpawn = false;
/** trailmate control API に届くか。起動直後は false のままにする。 */
let backendReady = false;
/** ViaProxy 込みでスポーンしてよいか。 */
let spawnReady = false;
let lastBackendMessage = '';
let lastMsLoginRenderKey = '';
let lastMsLoginUrl = '';
let lastMsLoginCode = '';

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
    void refreshUpdateStatus();
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

  syncSpawnControls(setup);
}

/** セットアップ完了かつスポーン依存（trailmate + ViaProxy）準備完了のときだけスポーン可能。 */
function syncSpawnControls(setup = null) {
  const setupReady = readyToSpawn;
  const canSpawn = setupReady && spawnReady;
  spawnBtn.disabled = !canSpawn;
  despawnBtn.disabled = !backendReady;

  if (!setupReady) {
    const blockers = setup?.blockers || [];
    spawnBlockReason.classList.remove('hidden');
    spawnBlockReason.textContent =
      blockers.length > 0
        ? `スポーンできません: ${blockers.join(' / ')}`
        : 'スポーンできません: セットアップが未完了です';
    return;
  }

  if (!backendReady || !spawnReady) {
    spawnBlockReason.classList.remove('hidden');
    spawnBlockReason.textContent =
      lastBackendMessage ||
      (!backendReady
        ? 'ボット側の準備中です。コンテナ起動が終わるまでスポーンできません。'
        : '接続用プロキシ（ViaProxy）の起動中です。しばらく待ってからスポーンしてください。');
    return;
  }

  spawnBlockReason.classList.add('hidden');
  spawnBlockReason.textContent = '';
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
  if (!spawnReady) {
    syncSpawnControls();
    setMsg(
      spawnMsg,
      lastBackendMessage ||
        'まだ準備中です。少し待ってから再度お試しください。',
      'err'
    );
    return;
  }
  spawnBtn.disabled = true;
  setMsg(spawnMsg, 'スポーン中…');
  try {
    const result = await api('/api/spawn', { method: 'POST' });
    if (!result.ok) throw new Error(result.error || 'スポーンに失敗しました');
    setMsg(spawnMsg, 'スポーンしました', 'ok');
    await refreshStatus();
  } catch (error) {
    setMsg(spawnMsg, error.message, 'err');
    await refreshStatus();
  } finally {
    syncSpawnControls();
  }
});

despawnBtn.addEventListener('click', async () => {
  if (!backendReady) {
    syncSpawnControls();
    setMsg(spawnMsg, 'ボット側の準備中です。少し待ってから再度お試しください。', 'err');
    return;
  }
  despawnBtn.disabled = true;
  setMsg(spawnMsg, 'デスポーン中…');
  try {
    const result = await api('/api/despawn', { method: 'POST' });
    if (!result.ok) throw new Error(result.error || 'デスポーンに失敗しました');
    setMsg(spawnMsg, 'デスポーンしました', 'ok');
    await refreshStatus();
  } catch (error) {
    setMsg(spawnMsg, error.message, 'err');
    await refreshStatus();
  } finally {
    syncSpawnControls();
  }
});

function renderStatus(status) {
  if (!status || status.backendReady === false) {
    const message =
      status?.backendMessage ||
      status?.error ||
      'ボット側の準備中です。コンテナ起動が終わるまでお待ちください。';
    statusPanel.innerHTML = `
      <div><span class="pill off">準備中</span></div>
      <div class="muted">${escapeHtml(message)}</div>
    `;
    return;
  }

  if (status.error && status.spawned == null) {
    statusPanel.innerHTML = `<div class="msg err">${escapeHtml(status.error)}</div>`;
    return;
  }

  const preparingNote =
    status.spawnReady === false
      ? `<div class="warn">${escapeHtml(
          status.backendMessage ||
            '接続用プロキシ（ViaProxy）の起動中です。しばらく待ってからスポーンしてください。'
        )}</div>`
      : '';

  if (!status.spawned) {
    const err =
      status.lastError && status.spawnReady !== false
        ? `<div class="msg err">前回のエラー: ${escapeHtml(status.lastError)}</div>`
        : '';
    statusPanel.innerHTML = `
      <div><span class="pill off">未スポーン</span> ${escapeHtml(status.botName || '')}</div>
      <div class="muted">${status.spawning ? '接続処理中…' : 'ワールドには出ていません。時間は進みません。'}</div>
      ${preparingNote}
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
    backendReady = status.backendReady !== false;
    spawnReady = Boolean(status.spawnReady);
    lastBackendMessage = status.backendMessage || '';
    syncSpawnControls();
    renderStatus(status);
  } catch (error) {
    backendReady = false;
    spawnReady = false;
    lastBackendMessage = error.message || 'ボット側の準備中です。';
    syncSpawnControls();
    renderStatus({
      backendReady: false,
      spawnReady: false,
      backendMessage: lastBackendMessage
    });
  }
}

/* ===== microsoft login ===== */
const COPY_FEEDBACK_MS = 1200;

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

function msLoginRenderKey(state) {
  return [
    state.url || '',
    state.code || '',
    state.active ? '1' : '0',
    state.done ? '1' : '0',
    state.success ? '1' : '0',
    state.accountName || '',
    state.error || '',
    state.output ? state.output.slice(-80) : ''
  ].join('|');
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const previous = button.textContent;
    button.textContent = 'コピー済み';
    setTimeout(() => {
      button.textContent = previous;
    }, COPY_FEEDBACK_MS);
  } catch {
    setMsg(msLoginMsg, 'コピーに失敗しました。リンクを手動で選択してください', 'err');
  }
}

function msLoginStepHtml(label, bodyHtml) {
  return `
    <div class="ms-login-step">
      <div class="ms-login-step-label">${label}</div>
      ${bodyHtml}
    </div>
  `;
}

function renderMsLoginPanel(state) {
  const key = msLoginRenderKey(state);
  if (key === lastMsLoginRenderKey) return;
  lastMsLoginRenderKey = key;
  lastMsLoginUrl = state.url || '';
  lastMsLoginCode = state.code || '';

  const parts = [];

  if (state.url) {
    const safeUrl = escapeHtml(state.url);
    parts.push(
      msLoginStepHtml(
        '1. この URL を開く',
        `<div class="row">
          <a class="ms-login-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>
          <button type="button" data-copy="url">URL をコピー</button>
        </div>`
      )
    );
  }

  if (state.code) {
    const safeCode = escapeHtml(state.code);
    parts.push(
      msLoginStepHtml(
        '2. コード（自動入力されないとき）',
        `<div class="row">
          <code class="ms-login-code">${safeCode}</code>
          <button type="button" data-copy="code">コードをコピー</button>
        </div>`
      )
    );
  }

  if (state.active && state.url) {
    parts.push(
      '<div class="ms-login-note">3. ボット用 Microsoft アカウントでログインし、完了を待つ</div>'
    );
  }

  if (state.success && state.accountName) {
    parts.push(
      `<div class="msg ok">完了: ${escapeHtml(state.accountName)} を登録しました</div>`
    );
    setMsg(msLoginMsg, `登録完了: ${state.accountName}`, 'ok');
  } else if (state.error && state.error !== 'cancelled by user') {
    parts.push(`<div class="msg err">エラー: ${escapeHtml(state.error)}</div>`);
    setMsg(msLoginMsg, state.error, 'err');
  } else if (state.active) {
    parts.push(
      `<div class="ms-login-note">${state.url ? 'ログイン待ち…' : 'ViaProxy に接続中…'}</div>`
    );
  } else if (!state.url && !state.done) {
    parts.push(
      '<div class="ms-login-note">「ログイン開始」を押すと、ここに URL とコードが表示されます。</div>'
    );
  }

  if (!parts.length && state.output) {
    parts.push(`<div class="ms-login-note">${escapeHtml(state.output.slice(-500))}</div>`);
  }

  msLoginPanel.innerHTML = parts.join('') || '<div class="ms-login-note"></div>';
}

msLoginPanel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button || !msLoginPanel.contains(button)) return;
  const kind = button.getAttribute('data-copy');
  const text = kind === 'code' ? lastMsLoginCode : lastMsLoginUrl;
  if (!text) return;
  void copyText(text, button);
});

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

    renderMsLoginPanel(state);
  } catch (error) {
    lastMsLoginRenderKey = '';
    msLoginPanel.textContent = error.message;
  }
}

/* ===== update ===== */
let updatePollTimer = null;

function renderUpdateStatus(status) {
  if (!status) {
    updatePanel.textContent = '更新情報を取得できません';
    updateApplyBtn.hidden = true;
    updateApplyBtn.disabled = true;
    updateZone.classList.remove('is-alert', 'is-busy');
    updateZone.classList.add('is-quiet');
    if (updateExpand) updateExpand.hidden = true;
    return;
  }

  const current = escapeHtml(status.currentVersion || 'unknown');
  const latest = status.latestVersion
    ? escapeHtml(status.latestVersion)
    : '未取得';
  const updating = Boolean(status.updating);
  const available = Boolean(status.updateAvailable);
  const needsAttention = updating || available;

  updateZone.classList.toggle('is-quiet', !needsAttention);
  updateZone.classList.toggle('is-alert', available && !updating);
  updateZone.classList.toggle('is-busy', updating);
  if (updateExpand) updateExpand.hidden = !needsAttention;

  let badge;
  if (updating) {
    badge = '<span class="pill busy">更新中</span>';
  } else if (available) {
    badge = '<span class="pill available">更新あり</span>';
  } else {
    badge = '<span class="pill on">最新</span>';
  }

  const link = status.latestUrl
    ? ` <a class="ms-login-link" href="${escapeHtml(status.latestUrl)}" target="_blank" rel="noopener noreferrer">Release</a>`
    : '';
  const err = status.latestError
    ? `<span class="msg err">${escapeHtml(status.latestError)}</span>`
    : '';

  if (needsAttention) {
    updatePanel.innerHTML = `
      ${badge}
      <span>現在 <strong>${current}</strong></span>
      <span>最新 <strong>${latest}</strong>${link}</span>
      ${err}
    `;
  } else {
    updatePanel.innerHTML = `
      ${badge}
      <span>${current}</span>
      ${err}
    `;
  }

  updateApplyBtn.hidden = !needsAttention;
  updateApplyBtn.disabled = updating || !available;
  if (updating) {
    setMsg(updateMsg, '更新を実行中…（完了後に再読み込みしてください）');
    if (updateLogsDetails) updateLogsDetails.open = true;
  }
}

async function refreshUpdateStatus() {
  try {
    const status = await api('/api/update/status');
    renderUpdateStatus(status);
    if (status.updating) {
      await refreshUpdateLogs();
      startUpdateLogPolling();
    } else {
      stopUpdateLogPolling();
    }
  } catch (error) {
    updatePanel.innerHTML = `<div class="msg err">${escapeHtml(error.message)}</div>`;
    updateApplyBtn.disabled = true;
  }
}

/** 最下部追従。details を先に開き、レイアウト後に pin する。 */
function setLogTextFollowBottom(el, text, { forceBottom = false, openDetails = false } = {}) {
  if (openDetails && updateLogsDetails) updateLogsDetails.open = true;
  if (forceBottom) updateLogFollow.forceStick();
  return updateLogFollow.setText(el, text, {
    forceBottom,
    afterLayout: (fn) => requestAnimationFrame(fn)
  });
}

if (updateLogsEl) {
  updateLogsEl.addEventListener('scroll', () => updateLogFollow.onScroll(updateLogsEl), {
    passive: true
  });
}

async function refreshUpdateLogs() {
  try {
    const data = await api('/api/update/logs');
    const openDetails = Boolean(data.updating);
    setLogTextFollowBottom(updateLogsEl, data.log || '(ログなし)', {
      // 更新中の初回展開では必ず末尾へ。以降は sticky 状態に従う。
      forceBottom: openDetails && !(updateLogsDetails && updateLogsDetails.open),
      openDetails
    });
    if (data.updating) {
      setMsg(updateMsg, '更新を実行中…（完了後に再読み込みしてください）');
    } else if (data.ok) {
      setMsg(updateMsg, '更新が完了しました。ページを再読み込みしてください', 'ok');
      stopUpdateLogPolling();
      await refreshUpdateStatus();
    } else if (data.error) {
      setMsg(updateMsg, data.error, 'err');
      stopUpdateLogPolling();
      await refreshUpdateStatus();
    }
  } catch (error) {
    setLogTextFollowBottom(updateLogsEl, error.message, { forceBottom: true, openDetails: true });
  }
}

function startUpdateLogPolling() {
  if (updatePollTimer) return;
  updatePollTimer = setInterval(() => {
    void refreshUpdateLogs();
  }, POLL_INTERVAL_MS);
}

function stopUpdateLogPolling() {
  if (!updatePollTimer) return;
  clearInterval(updatePollTimer);
  updatePollTimer = null;
}

updateCheckBtn.addEventListener('click', async () => {
  setMsg(updateMsg, '確認中…');
  try {
    const status = await api('/api/update/status');
    renderUpdateStatus(status);
    if (status.updating) {
      setMsg(updateMsg, '更新を実行中…（完了後に再読み込みしてください）');
      await refreshUpdateLogs();
      startUpdateLogPolling();
      return;
    }
    stopUpdateLogPolling();
    if (status.latestError && !status.latestVersion) {
      setMsg(updateMsg, status.latestError, 'err');
      return;
    }
    if (status.updateAvailable) {
      setMsg(
        updateMsg,
        `更新があります（${status.latestVersion}）`,
        'ok'
      );
      return;
    }
    setMsg(
      updateMsg,
      `最新です（${status.currentVersion || 'unknown'}）`,
      'ok'
    );
  } catch (error) {
    setMsg(updateMsg, error.message, 'err');
  }
});

updateApplyBtn.addEventListener('click', async () => {
  if (
    !window.confirm(
      '最新 Release のイメージを取り込みます。スポーン中の相棒は再起動されます。続行しますか？'
    )
  ) {
    return;
  }
  updateApplyBtn.disabled = true;
  setMsg(updateMsg, '更新を開始します…');
  try {
    const result = await api('/api/update/apply', {
      method: 'POST',
      body: JSON.stringify({})
    });
    if (!result.ok) throw new Error(result.error || '更新を開始できませんでした');
    setMsg(updateMsg, '更新を実行中…（完了後に再読み込みしてください）', 'ok');
    setLogTextFollowBottom(updateLogsEl, result.log || '(ログなし)', {
      forceBottom: true,
      openDetails: true
    });
    startUpdateLogPolling();
  } catch (error) {
    setMsg(updateMsg, error.message, 'err');
    await refreshUpdateStatus();
  }
});

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

/* ===== boot / polling ===== */
async function boot() {
  await loadSettings({ fillForm: true });
  if (readyToSpawn) {
    await refreshStatus();
    await refreshLogs();
    await refreshUpdateStatus();
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
