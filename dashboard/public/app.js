import { createLogFollowState } from './logFollow.js';
import { syncHtml, syncProp, syncText, syncTextKeepingScroll } from './domSync.js';
import { renderFsmSvg } from './fsmGraph.js';
import { bundledFsmStates, stateLabel as labelForState, stateNote as noteForState } from './fsmLabels.js';
import { renderBtTree } from './btTree.js';

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
  syncText(el, text || '');
  syncProp(el, 'className', `msg ${kind}`.trim());
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
const botNameOnline = document.getElementById('bot-name-online');
const botNameOffline = document.getElementById('bot-name-offline');
const botDisplayName = document.getElementById('bot-display-name');
const minecraftVersionInput = document.getElementById('minecraftVersion');
const authMethodSelect = document.getElementById('authMethod');
const spawnBtn = document.getElementById('spawn-btn');
const despawnBtn = document.getElementById('despawn-btn');
const spawnMsg = document.getElementById('spawn-msg');
const spawnBlockReason = document.getElementById('spawn-block-reason');
const spawnDiagnosticsEl = document.getElementById('spawn-diagnostics');
const statusPanel = document.getElementById('status-panel');
const inventoryPanel = document.getElementById('inventory-panel');
const fsmGraphEl = document.getElementById('fsm-graph');
const fsmCurrentEl = document.getElementById('fsm-current');
const fsmModeEl = document.getElementById('fsm-mode');
const fsmHistoryEl = document.getElementById('fsm-history');
const btTitleEl = document.getElementById('bt-title');
const btTreeEl = document.getElementById('bt-tree');
const modeSwitchEl = document.getElementById('mode-switch');
const commandListEl = document.getElementById('command-list');
const commandMsg = document.getElementById('command-msg');
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
  // 同じスロットへの appendChild でもノードは差し替わる（入力中のフォーカスが飛ぶ）。
  const slot = readyToSpawn ? settingsSlot : wizardSlot;
  if (panelSetup.parentElement !== slot) slot.appendChild(panelSetup);
  // ウィザード完了直後だけプレイページへ戻す（設定ページ閲覧中は維持）
  if (readyToSpawn && !wasReady) showTab('operate');

  updateAccountStepVisibility(settings.authMethod === 'NONE');
}

function showTab(tabId) {
  currentTab = tabId;
  // `.tab` は保持ピッカーのサブタブ。ページ切替は data-tab を持つ項目だけ。
  document.querySelectorAll('.nav-item[data-tab]').forEach((button) => {
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
  // retention.js loads its own data the first time its tab is opened.
  document.dispatchEvent(new CustomEvent('trailmate:tab', { detail: { tabId } }));
}

document.querySelectorAll('.nav-item[data-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    showTab(button.getAttribute('data-tab'));
  });
});

/* ===== setup checklist ===== */
function renderSetup(setup, settings = {}) {
  const isReady = Boolean(setup?.readyToSpawn);
  applyMode(isReady, settings);

  if (!setup || isReady) {
    syncHtml(setupChecklist, '');
  } else {
    const items = (setup.steps || [])
      .map((step) => {
        const cls = step.ok ? 'ok' : 'ng';
        const mark = step.ok ? 'OK' : '未完了';
        return `<li class="${cls}">[${mark}] ${escapeHtml(step.label)}</li>`;
      })
      .join('');
    syncHtml(
      setupChecklist,
      `<strong class="ng">セットアップを完了してください</strong><ul>${items}</ul>`
    );
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

/** セットアップ完了かつ診断 OK のときだけスポーン可能。 */
function syncSpawnControls(setup = null) {
  const setupReady = readyToSpawn;
  const canSpawn = setupReady && spawnReady;
  spawnBtn.disabled = !canSpawn;
  despawnBtn.disabled = !backendReady;

  if (!setupReady) {
    const blockers = setup?.blockers || [];
    spawnBlockReason.classList.remove('hidden');
    syncText(
      spawnBlockReason,
      blockers.length > 0
        ? `スポーンできません: ${blockers.join(' / ')}`
        : 'スポーンできません: セットアップが未完了です'
    );
    return;
  }

  if (!backendReady || !spawnReady) {
    spawnBlockReason.classList.remove('hidden');
    syncText(
      spawnBlockReason,
      lastBackendMessage || 'スポーンの前提条件がまだ揃っていません。下の診断を確認してください。'
    );
    return;
  }

  spawnBlockReason.classList.add('hidden');
  syncText(spawnBlockReason, '');
}

function renderSpawnDiagnostics(diagnostics) {
  if (!spawnDiagnosticsEl) return;
  const steps = Array.isArray(diagnostics?.steps) ? diagnostics.steps : [];
  if (!steps.length) {
    syncHtml(spawnDiagnosticsEl, '');
    return;
  }
  const html = steps
    .map((step) => {
      const state = step.state === 'ok' ? 'ok' : step.state === 'starting' ? 'starting' : 'error';
      const mark = state === 'ok' ? '✓' : state === 'starting' ? '…' : '✗';
      return `<li class="is-${state}">
        <span class="diag-mark">${mark}</span>
        <span class="diag-label">${escapeHtml(step.label || step.id || '')}</span>
        <span class="diag-detail">${escapeHtml(step.detail || '')}</span>
      </li>`;
    })
    .join('');
  syncHtml(spawnDiagnosticsEl, html);
}

function updateAccountStepVisibility(offline) {
  msLoginControls.classList.toggle('hidden', offline);
  msSkipNote.classList.toggle('hidden', !offline);
  msLoginPanel.classList.toggle('hidden', offline);
  // オンライン: Microsoft プロフィール名がワールド名。オフラインのみ BOT_NAME が本体。
  if (botNameOnline) botNameOnline.classList.toggle('hidden', offline);
  if (botNameOffline) botNameOffline.classList.toggle('hidden', !offline);
  if (botNameInput) {
    botNameInput.required = Boolean(offline);
    if (!offline) botNameInput.removeAttribute('required');
  }
}

function renderBotDisplayName(account, authMethod) {
  if (!botDisplayName) return;
  if (authMethod === 'NONE') {
    setMsg(botDisplayName, '');
    return;
  }
  if (account?.registered && account.name) {
    setMsg(botDisplayName, account.name, 'ok');
    return;
  }
  setMsg(botDisplayName, '未登録（設定の Microsoft ログインを完了してください）', 'err');
}

function renderRegisteredAccount(account) {
  if (!account) {
    setMsg(msAccountStatus, '登録状態不明');
    return;
  }
  if (account.registered && account.name) {
    setMsg(msAccountStatus, `登録済み: ${account.name}（${account.count}件）`, 'ok');
  } else {
    setMsg(
      msAccountStatus,
      '未登録です。新しい PC では「ログイン開始」が必須です（saves.json のコピーは不要・非推奨）。',
      'err'
    );
  }
}

/* ===== settings ===== */
function fillSettingsForm(settings) {
  targetAddressInput.value = settings.targetAddress || '';
  botNameInput.value = settings.botName || 'Trailmate';
  authMethodSelect.value = settings.authMethod || 'ACCOUNT';
  minecraftVersionInput.value = settings.minecraftVersion || '1.21.6';
  updateAccountStepVisibility(authMethodSelect.value === 'NONE');
  renderBotDisplayName(settings.registeredAccount, authMethodSelect.value);
}

/** チェックリスト等を更新。fillForm は初回表示・明示的な再読込時のみ。 */
function applySettingsState(settings, { fillForm = false } = {}) {
  if (fillForm) fillSettingsForm(settings);
  placeholderWarn.classList.toggle('hidden', !settings.placeholder);
  renderRegisteredAccount(settings.registeredAccount);
  lastKnownAccountName = settings.registeredAccount?.name || null;
  renderBotDisplayName(
    settings.registeredAccount,
    settings.authMethod || authMethodSelect.value
  );
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
    const authMethod = authMethodSelect.value;
    const body = {
      targetAddress: targetAddressInput.value.trim(),
      authMethod,
      minecraftVersion: minecraftVersionInput.value.trim()
    };
    // オフライン時のみワールド名として保存。オンラインでは ViaProxy 接続用に既存値を維持。
    if (authMethod === 'NONE') {
      body.botName = botNameInput.value.trim() || 'Trailmate';
    }
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    setMsg(settingsMsg, '保存しました（ViaProxy を再起動しました）', 'ok');
    if (result.settings) {
      applySettingsState(result.settings, { fillForm: true });
    }
  } catch (error) {
    setMsg(settingsMsg, error.message, 'err');
  }
});

authMethodSelect.addEventListener('change', () => {
  updateAccountStepVisibility(authMethodSelect.value === 'NONE');
  renderBotDisplayName(
    { registered: Boolean(lastKnownAccountName), name: lastKnownAccountName, count: 1 },
    authMethodSelect.value
  );
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
  setMsg(
    spawnMsg,
    'スポーン中…（重複ログインや ViaProxy の接続不良は自動で直して再試行します）'
  );
  try {
    const result = await api('/api/spawn', { method: 'POST' });
    if (!result.ok) throw new Error(result.error || 'スポーンに失敗しました');
    setMsg(
      spawnMsg,
      result.proxyRestarted ? 'ViaProxy をつなぎ直してスポーンしました' : 'スポーンしました',
      'ok'
    );
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
  renderSpawnDiagnostics(status?.diagnostics);
  const spawned = Boolean(status?.backendReady !== false && status?.spawned);
  renderCompanionPanels(spawned ? status : null);

  if (!status || status.backendReady === false) {
    const message =
      status?.diagnostics?.summary ||
      status?.backendMessage ||
      status?.error ||
      'ボット側の準備中です。コンテナ起動が終わるまでお待ちください。';
    syncHtml(
      statusPanel,
      `
      <div class="status-line"><span class="pill off">準備中</span></div>
      <div class="muted">${escapeHtml(message)}</div>
    `
    );
    return;
  }

  if (status.error && status.spawned == null) {
    syncHtml(statusPanel, `<div class="msg err">${escapeHtml(status.error)}</div>`);
    return;
  }

  const preparingNote =
    status.spawnReady === false
      ? `<div class="warn">${escapeHtml(
          status.diagnostics?.summary ||
            status.backendMessage ||
            'スポーンの前提条件がまだ揃っていません。'
        )}</div>`
      : '';

  if (!status.spawned) {
    const err =
      status.lastError && status.spawnReady !== false
        ? `<div class="msg err">前回のエラー: ${escapeHtml(status.lastError)}</div>`
        : '';
    syncHtml(
      statusPanel,
      `
      <div class="status-line"><span class="pill off">未スポーン</span> ${escapeHtml(status.botName || '')}</div>
      <div class="muted">${status.spawning ? '接続処理中…' : 'ワールドには出ていません。時間は進みません。'}</div>
      ${preparingNote}
      ${err}
    `
    );
    return;
  }

  renderSpawnDiagnostics(null);

  const pos = status.position
    ? `${status.position.x}, ${status.position.y}, ${status.position.z}`
    : '-';

  syncHtml(
    statusPanel,
    `
    <div class="status-line"><span class="pill on">スポーン中</span> <strong>${escapeHtml(status.username || status.botName || '')}</strong></div>
    <dl class="props">
      <dt>体力</dt><dd>${fmt(status.health)} / 20</dd>
      <dt>満腹度</dt><dd>${fmt(status.food)} / 20</dd>
      <dt>座標</dt><dd>${escapeHtml(pos)}</dd>
      <dt>ディメンション</dt><dd>${escapeHtml(dimensionLabel(status.dimension))}</dd>
      <dt>オーナー</dt><dd>${escapeHtml(status.ownerName || '未ロック')}</dd>
    </dl>
    ${
      status.unsetMobs?.length
        ? `<div class="warn">攻撃するか未設定のモブに出会いました（${escapeHtml(
            status.unsetMobs.map((mob) => mob.label).join('、')
          )}）。設定タブの「攻撃するモブ」で選んでください。</div>`
        : ''
    }
  `
  );
}

/** ゲーム内の日本語表記に合わせる。 */
const DIMENSION_TEXT = {
  overworld: 'オーバーワールド',
  the_nether: 'ネザー',
  the_end: 'ジ・エンド'
};

function dimensionLabel(dimension) {
  if (!dimension) return '-';
  const id = String(dimension).replace(/^minecraft:/, '');
  return DIMENSION_TEXT[id] || id;
}

/* ===== state machine ===== */
/** Display copy. The image bundle shows Japanese before locales/ja.json is replaced. */
let fsmStates = bundledFsmStates;

async function loadUiCopy() {
  try {
    const data = await api('/api/ui-copy');
    const states = data?.fsm_states;
    if (states && typeof states === 'object' && Object.keys(states).length > 0) fsmStates = states;
  } catch {
    fsmStates = bundledFsmStates;
  }
}

/** Modes are chosen by the player, above the state machine. */
const MODE_IDS = ['follow', 'wait'];

function stateLabel(id) {
  return labelForState(fsmStates, id);
}

/** The normal state does what the selected mode says. */
function stateNote(fsm, id) {
  return noteForState(fsmStates, fsm, id);
}

function formatTime(at) {
  return new Date(at).toLocaleTimeString('ja-JP', { hour12: false });
}

/** State whose tree is open; `null` follows the active state. */
let btSelected = null;
/** @type {object|null} Last status, so a click can redraw without waiting for the poll. */
let lastFsm = null;

function renderFsm(fsm) {
  lastFsm = fsm;
  if (!fsm) {
    syncHtml(fsmGraphEl, '<div class="empty">スポーンすると表示されます</div>');
    syncHtml(fsmModeEl, '');
    syncHtml(fsmCurrentEl, '');
    syncHtml(fsmHistoryEl, '<li class="muted">まだありません</li>');
    syncText(btTitleEl, '状態の中身');
    syncHtml(btTreeEl, '<div class="empty">スポーンすると表示されます</div>');
    return;
  }

  const shown = btSelected && fsm.trees?.[btSelected] ? btSelected : fsm.active;
  syncHtml(
    fsmModeEl,
    `<span class="fsm-mode-label">モード<small>（ユーザーが選ぶ・状態の上位）</small></span>${MODE_IDS.map(
      (id) =>
        `<button type="button" class="small${id === fsm.preferredMode ? ' is-active' : ''}" data-run="${id}" aria-pressed="${
          id === fsm.preferredMode
        }">${escapeHtml(stateLabel(id))}</button>`
    ).join('')}`
  );
  syncHtml(
    fsmGraphEl,
    renderFsmSvg(fsm, {
      label: stateLabel,
      note: (id) => stateNote(fsm, id),
      selected: btSelected ? shown : null
    })
  );
  syncHtml(
    fsmCurrentEl,
    `<div class="fsm-current-label">${escapeHtml(stateLabel(fsm.active))}</div>
    <div class="fsm-current-note">${escapeHtml(stateNote(fsm, fsm.active))} · モード ${escapeHtml(
      stateLabel(fsm.preferredMode)
    )}</div>`
  );

  const live = shown === fsm.active;
  const modeNote = shown === 'normal' ? `・${stateLabel(fsm.preferredMode)}モード` : '';
  syncText(
    btTitleEl,
    `「${stateLabel(shown)}」の中身${modeNote}${live ? '（いま動いている状態）' : '（いまは動いていない状態）'}`
  );
  syncHtml(btTreeEl, renderBtTree(fsm.trees?.[shown], { live, mode: fsm.preferredMode }));

  const history = [...(fsm.history || [])].reverse();
  syncHtml(
    fsmHistoryEl,
    history.length
      ? history
          .map(
            (entry) => `<li${entry.kind === 'mode' ? ' class="is-mode"' : ''}><time>${formatTime(
              entry.at
            )}</time><span>${entry.kind === 'mode' ? '<span class="tag">モード</span>' : ''}${escapeHtml(
              stateLabel(entry.from)
            )}<span class="arrow">→</span><strong>${escapeHtml(stateLabel(entry.to))}</strong></span></li>`
          )
          .join('')
      : '<li class="muted">スポーンしてからの遷移はまだありません</li>'
  );
}

/** Clicking a state opens its tree; clicking it again goes back to following the active state. */
function selectFsmState(id) {
  btSelected = btSelected === id ? null : id;
  renderFsm(lastFsm);
}

fsmGraphEl.addEventListener('click', (event) => {
  const node = event.target.closest?.('[data-state]');
  if (node) selectFsmState(node.getAttribute('data-state'));
});
fsmGraphEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const node = event.target.closest?.('[data-state]');
  if (!node) return;
  event.preventDefault();
  selectFsmState(node.getAttribute('data-state'));
});

/* ===== modes / commands ===== */
/** @type {Array<{ id: string, kind: 'mode'|'action', word: string, description: string }>|null} */
let chatCommands = null;
let companionSpawned = false;
let preferredMode = null;

async function loadCommands() {
  if (chatCommands) return;
  try {
    const data = await api('/api/commands');
    if (!Array.isArray(data.commands)) return;
    chatCommands = data.commands;
  } catch {
    return;
  }
  syncHtml(
    modeSwitchEl,
    chatCommands
      .filter((command) => command.kind === 'mode')
      .map(
        (command) => `<button type="button" data-run="${escapeHtml(command.id)}">${escapeHtml(
          stateLabel(command.id)
        )}<span class="segmented-sub">${escapeHtml(command.description)}</span></button>`
      )
      .join('')
  );
  syncHtml(
    commandListEl,
    chatCommands
      .map(
        (command) => `<tr>
        <td class="cmd-word"><code>${escapeHtml(command.word)}</code><span class="cmd-kind">${
          command.kind === 'mode' ? 'モード' : 'アクション'
        }</span></td>
        <td>${escapeHtml(command.description)}</td>
        <td class="cmd-actions">
          <button type="button" class="small" data-run="${escapeHtml(command.id)}">実行</button>
          <button type="button" class="small" data-copy-word="${escapeHtml(command.word)}">コピー</button>
        </td>
      </tr>`
      )
      .join('')
  );
  syncCommandButtons();
}

function syncCommandButtons() {
  document.querySelectorAll('[data-run]').forEach((button) => {
    syncProp(button, 'disabled', !companionSpawned);
  });
  modeSwitchEl.querySelectorAll('[data-run]').forEach((button) => {
    const active = companionSpawned && button.getAttribute('data-run') === preferredMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function renderCompanionPanels(status) {
  companionSpawned = Boolean(status);
  preferredMode = status?.preferredMode ?? null;
  syncCommandButtons();
  renderFsm(status?.fsm ?? null);

  if (!status) {
    syncHtml(inventoryPanel, '<span class="muted">スポーンすると表示されます</span>');
    return;
  }
  const items = Array.isArray(status.inventory) ? status.inventory : [];
  syncHtml(
    inventoryPanel,
    items.length
      ? items
          .map(
            (item) =>
              `<span class="inv-chip">${escapeHtml(item.displayName || item.name)}<b>×${item.count}</b></span>`
          )
          .join('')
      : '<span class="muted">持ち物なし</span>'
  );
}

async function runCommand(id) {
  const command = chatCommands?.find((entry) => entry.id === id);
  if (!command) return;
  setMsg(commandMsg, `「${command.word}」を送信中…`);
  try {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ id }) });
    setMsg(commandMsg, `「${command.word}」を指示しました`, 'ok');
    await refreshStatus();
  } catch (error) {
    setMsg(commandMsg, error.message, 'err');
  }
}

async function copyWord(word) {
  try {
    await navigator.clipboard.writeText(word);
    setMsg(commandMsg, `「${word}」をコピーしました。マイクラのチャットに貼り付けて使えます`, 'ok');
  } catch {
    setMsg(commandMsg, 'コピーに失敗しました。ワードを手で選択してください', 'err');
  }
}

document.addEventListener('click', (event) => {
  const run = event.target.closest('[data-run]');
  if (run && !run.disabled) {
    void runCommand(run.getAttribute('data-run'));
    return;
  }
  const copy = event.target.closest('[data-copy-word]');
  if (copy) void copyWord(copy.getAttribute('data-copy-word'));
});

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    backendReady = status.backendReady !== false;
    spawnReady = Boolean(status.spawnReady);
    lastBackendMessage =
      status.diagnostics?.summary || status.backendMessage || status.error || '';
    syncSpawnControls();
    renderStatus(status);
    if (backendReady) void loadCommands();
  } catch (error) {
    backendReady = false;
    spawnReady = false;
    lastBackendMessage = error.message || 'ボット側の準備中です。';
    syncSpawnControls();
    renderStatus({
      backendReady: false,
      spawnReady: false,
      backendMessage: lastBackendMessage,
      diagnostics: null
    });
  }
}

/* ===== microsoft login ===== */
const COPY_FEEDBACK_MS = 1200;
const COPY_LABELS = { url: 'URL をコピー', code: 'コードをコピー' };

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

/**
 * コピー直後だけ変わる見た目。パネルは作り直されうるので、状態は DOM ではなく
 * ここが持ち、描き直しのたびに貼り直す。
 */
let copiedKind = null;
let copiedTimer = null;

function applyCopyFeedback() {
  msLoginPanel.querySelectorAll('[data-copy]').forEach((button) => {
    const kind = button.getAttribute('data-copy');
    syncProp(
      button,
      'textContent',
      kind === copiedKind ? 'コピー済み' : COPY_LABELS[kind] || 'コピー'
    );
  });
}

async function copyText(text, kind) {
  try {
    await navigator.clipboard.writeText(text);
    copiedKind = kind;
    applyCopyFeedback();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKind = null;
      applyCopyFeedback();
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
          <button type="button" data-copy="url">${COPY_LABELS.url}</button>
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
          <button type="button" data-copy="code">${COPY_LABELS.code}</button>
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

  syncHtml(msLoginPanel, parts.join('') || '<div class="ms-login-note"></div>');
  // 作り直された直後でも、1.2 秒のコピー表示はここで貼り直される。
  applyCopyFeedback();
}

msLoginPanel.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button || !msLoginPanel.contains(button)) return;
  const kind = button.getAttribute('data-copy');
  const text = kind === 'code' ? lastMsLoginCode : lastMsLoginUrl;
  if (!text) return;
  void copyText(text, kind);
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
    syncText(msLoginPanel, error.message);
  }
}

/* ===== update ===== */
let updatePollTimer = null;
/** 更新1回につき1度だけ自動で開く。手で閉じたぶんを開き直さないための印。 */
let updateLogsAutoOpened = false;

/** @returns {boolean} この呼び出しで開いたか（開いた直後だけ末尾へ寄せたい） */
function autoOpenUpdateLogs() {
  if (!updateLogsDetails || updateLogsAutoOpened) return false;
  updateLogsAutoOpened = true;
  if (updateLogsDetails.open) return false;
  updateLogsDetails.open = true;
  return true;
}

function renderUpdateStatus(status) {
  if (!status) {
    syncText(updatePanel, '更新情報を取得できません');
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
    syncHtml(
      updatePanel,
      `
      ${badge}
      <span>現在 <strong>${current}</strong></span>
      <span>最新 <strong>${latest}</strong>${link}</span>
      ${err}
    `
    );
  } else {
    syncHtml(
      updatePanel,
      `
      ${badge}
      <span>${current}</span>
      ${err}
    `
    );
  }

  updateApplyBtn.hidden = !needsAttention;
  updateApplyBtn.disabled = updating || !available;
  if (updating) {
    setMsg(updateMsg, '更新を実行中…（完了後に再読み込みしてください）');
    autoOpenUpdateLogs();
  } else {
    // 次の更新まで巻き戻す。1回の更新中は開き直さない。
    updateLogsAutoOpened = false;
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
    syncHtml(updatePanel, `<div class="msg err">${escapeHtml(error.message)}</div>`);
    updateApplyBtn.disabled = true;
  }
}

/** 最下部追従。details の開閉は呼び出し側が先に決める。 */
function setLogTextFollowBottom(el, text, { forceBottom = false } = {}) {
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
    // 更新中の初回展開では必ず末尾へ。以降は sticky 状態に従う。
    const justOpened = data.updating ? autoOpenUpdateLogs() : false;
    setLogTextFollowBottom(updateLogsEl, data.log || '(ログなし)', { forceBottom: justOpened });
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
    autoOpenUpdateLogs();
    setLogTextFollowBottom(updateLogsEl, error.message, { forceBottom: true });
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
    // ここからが新しい更新。自分で押した操作なので、1度だけ開いてよい。
    updateLogsAutoOpened = false;
    autoOpenUpdateLogs();
    setLogTextFollowBottom(updateLogsEl, result.log || '(ログなし)', { forceBottom: true });
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
  syncText(logsServiceLabel, `表示中: ${currentLogService}`);
}

async function refreshLogs() {
  try {
    const data = await api(`/api/logs?service=${encodeURIComponent(currentLogService)}&tail=50`);
    syncTextKeepingScroll(logsEl, data.logs || '(empty)');
    updateLogButtons();
  } catch (error) {
    syncTextKeepingScroll(logsEl, error.message);
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
  await loadUiCopy();
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
