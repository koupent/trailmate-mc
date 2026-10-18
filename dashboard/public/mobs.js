/**
 * 攻撃するモブの設定。未設定のモブを先頭にまとめて、決めてもらうよう促す。
 * retention.js と同じく、編集中は再読み込みしない。
 */

import { syncHtml, syncProp, syncText } from './domSync.js';

const listEl = document.getElementById('mobs-list');
const summaryEl = document.getElementById('mobs-summary');
const saveBtn = document.getElementById('mobs-save');
const msgEl = document.getElementById('mobs-msg');

const state = {
  /** @type {Array<{ id: string, label: string, default: 'attack'|'ignore'|null }>} */
  mobs: [],
  /** @type {Record<string, 'attack'|'ignore'>} */
  mobHostility: {},
  dirty: false
};

const LABELS = { attack: '攻撃する', ignore: '攻撃しない' };

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setMsg(text, kind = '') {
  syncText(msgEl, text || '');
  syncProp(msgEl, 'className', `msg ${kind}`.trim());
}

function decisionOf(mob) {
  return state.mobHostility[mob.id] ?? mob.default;
}

function rowHtml(mob) {
  const saved = state.mobHostility[mob.id] ?? '';
  const defaultText = mob.default ? `既定（${LABELS[mob.default]}）` : '未設定（攻撃しない）';
  const options = [
    `<option value="" ${saved === '' ? 'selected' : ''}>${defaultText}</option>`,
    ...Object.entries(LABELS).map(
      ([value, text]) => `<option value="${value}" ${saved === value ? 'selected' : ''}>${text}</option>`
    )
  ].join('');
  return `
    <label class="row">
      <span>${escapeHtml(mob.label)} <span class="muted">${escapeHtml(mob.id)}</span></span>
      <select data-mob="${escapeHtml(mob.id)}">${options}</select>
    </label>`;
}

function render() {
  // 保存済みだが一覧にない（遭遇記録が再起動で消えた）モブも出す。
  const known = new Set(state.mobs.map((mob) => mob.id));
  const mobs = [
    ...state.mobs,
    ...Object.keys(state.mobHostility)
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: id, default: null }))
  ];
  const unset = mobs.filter((mob) => decisionOf(mob) == null);
  const rest = mobs.filter((mob) => decisionOf(mob) != null).sort((a, b) => a.label.localeCompare(b.label));

  syncHtml(
    summaryEl,
    unset.length
      ? `<div class="warn">未設定のモブが ${unset.length} 件あります。攻撃するかどうかを選んでください。</div>`
      : ''
  );
  syncHtml(
    listEl,
    `${unset.length ? `<h3>未設定</h3>${unset.map(rowHtml).join('')}` : ''}
     <h3>設定済み・既定</h3>${rest.map(rowHtml).join('')}`
  );
}

async function loadMobs() {
  if (state.dirty) return;
  const data = await fetch('/api/mobs').then((response) => response.json()).catch(() => null);
  if (!data?.mobs) {
    syncText(listEl, data?.message || 'モブ一覧を取得できませんでした。');
    return;
  }
  state.mobs = data.mobs;
  state.mobHostility = data.mobHostility || {};
  render();
}

async function saveMobs() {
  syncProp(saveBtn, 'disabled', true);
  try {
    const response = await fetch('/api/mobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobHostility: state.mobHostility })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.mobHostility = data.mobHostility || {};
    state.dirty = false;
    setMsg(data.message, 'ok');
    render();
  } catch (error) {
    setMsg(`保存に失敗しました: ${error.message}`, 'err');
    syncProp(saveBtn, 'disabled', false);
  }
}

listEl?.addEventListener('change', (event) => {
  const id = event.target?.getAttribute?.('data-mob');
  if (!id) return;
  if (event.target.value) state.mobHostility[id] = event.target.value;
  else delete state.mobHostility[id];
  state.dirty = true;
  setMsg('');
  syncProp(saveBtn, 'disabled', false);
  // 選んだ行が別グループへ移るのは保存後にする（操作中の行が消えないように）。
});

saveBtn?.addEventListener('click', () => void saveMobs());

document.addEventListener('trailmate:tab', (event) => {
  if (event.detail?.tabId === 'settings') void loadMobs();
});

if (listEl) void loadMobs();
