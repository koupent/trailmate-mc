const modes = {
  message: {
    label: '相棒へのメッセージ', placeholder: '相棒に話しかける…', limit: 220,
    presetsLabel: 'よく使うメッセージ', action: '送信', storage: 'trailmate-message-presets'
  },
  command: {
    label: 'Minecraftコマンド', placeholder: '/tp Alex 120 64 -30', limit: 256,
    presetsLabel: 'よく使うコマンド', action: '発行', storage: 'trailmate-command-presets'
  }
};

const formatTime = new Intl.DateTimeFormat('ja', { hour: '2-digit', minute: '2-digit' });

function validate(kind, text) {
  if (!text) return '送信する内容を入力してください。';
  if (/[\p{Cc}\u2028\u2029]/u.test(text)) return '送信する内容は1行で入力してください。';
  if (text.length > modes[kind].limit) return '送信する内容が長すぎます。';
  if (kind === 'command' && !/^\/\S/.test(text)) return '/ で始まるコマンドを入力してください。';
  if (kind === 'message' && text.startsWith('/')) return 'Minecraftコマンドに切り替えてください。';
  return '';
}

function readPresets(kind) {
  try {
    const data = JSON.parse(localStorage.getItem(modes[kind].storage));
    if (Array.isArray(data)) {
      return data.filter((item) => typeof item?.name === 'string' && typeof item.text === 'string'
        && !validate(kind, item.text)).map(({ name, text, uses }) => ({
          name, text, uses: Number.isSafeInteger(uses) && uses > 0 ? uses : 0
        }));
    }
  } catch {
    // The dashboard remains usable when browser storage is unavailable.
  }
  return [];
}

function readPresetOrder(kind) {
  try {
    if (localStorage.getItem(modes[kind].storage + '-order') === 'frequency') return 'frequency';
  } catch {
    // Browser storage can be unavailable.
  }
  return 'manual';
}

export function bindPlayChat(api) {
  const byId = (id) => document.getElementById(id);
  const composer = byId('play-compose');
  const feed = byId('conversation-feed');
  const input = byId('play-message');
  const sendButton = byId('play-send');
  const sender = byId('play-chat-sender');
  const senderKey = 'trailmate-chat-sender';
  let selectedSender = '';
  try { selectedSender = localStorage.getItem(senderKey) || ''; } catch { /* Session only. */ }
  let onlinePlayers = [];
  let senderOptions = '';
  const feedback = byId('play-send-status');
  const quick = byId('play-presets');
  const modeButtons = composer.querySelectorAll('[data-compose-mode]');
  const dialog = byId('play-preset-dialog');
  const presetForm = byId('play-preset-form');
  const presetList = byId('play-preset-list');
  const presetName = byId('play-preset-name');
  const presetText = byId('play-preset-text');
  const presetOrder = byId('play-preset-order');
  const presets = { message: readPresets('message'), command: readPresets('command') };
  const orders = { message: readPresetOrder('message'), command: readPresetOrder('command') };
  const drafts = { message: '', command: '' };
  let mode = 'message';
  let editedPreset = null;
  let draggedPreset = null;
  let available = false;
  let pending = false;
  let polling = false;
  let revision = 0;
  let rendered = '';

  function showFeedback(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('err', error);
  }

  function updateControls() {
    input.disabled = !available;
    sender.disabled = !available;
    const senderUnavailable = Boolean(selectedSender && !onlinePlayers.includes(selectedSender));
    byId('play-chat-sender-status').hidden = !available || !senderUnavailable;
    sendButton.disabled = !available || pending || (mode === 'message' && senderUnavailable);
    quick.querySelectorAll('button').forEach((button) => { button.disabled = sendButton.disabled; });
  }

  function renderSenders() {
    const options = JSON.stringify([onlinePlayers, selectedSender]);
    if (options === senderOptions) return;
    senderOptions = options;
    sender.replaceChildren(new Option('管理画面（プレイヤー未選択）', ''),
      ...onlinePlayers.map(player => new Option(player, player)));
    if (selectedSender && !onlinePlayers.includes(selectedSender)) {
      sender.append(new Option(selectedSender + '（不在）', selectedSender));
    }
    sender.value = selectedSender;
  }
  sender.addEventListener('change', () => {
    selectedSender = sender.value;
    try { localStorage.setItem(senderKey, selectedSender); } catch { /* Session only. */ }
    renderSenders();
    updateControls();
  });
  renderSenders();

  function renderEntries(entries, follow = false) {
    const signature = JSON.stringify(entries);
    if (signature === rendered) return;
    rendered = signature;
    const pinned = feed.scrollHeight - feed.clientHeight - feed.scrollTop < 28;
    const scrollTop = feed.scrollTop;
    const rows = entries.map((entry) => {
      const row = document.createElement('div');
      row.className = entry.kind === 'companion' ? 'conversation-entry' : 'conversation-entry mine';
      const meta = document.createElement('small');
      const who = entry.kind === 'companion' ? '相棒' : entry.kind === 'command'
        ? 'あなた · Minecraftコマンド' : entry.player || 'あなた';
      meta.textContent = `${who} · ${formatTime.format(entry.at)}`;
      const body = document.createElement('p');
      if (entry.kind === 'command') body.className = 'slash-text';
      body.textContent = entry.text;
      row.append(meta, body);
      return row;
    });
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = available ? '相棒に話しかけてみよう。' : 'スポーンすると会話できます。';
      rows.push(empty);
    }
    feed.replaceChildren(...rows);
    feed.scrollTop = pinned || follow ? feed.scrollHeight : scrollTop;
  }

  async function refresh() {
    if (polling || pending) return;
    polling = true;
    const version = revision;
    try {
      const data = await api('/api/chat');
      if (revision === version) renderEntries(data.entries);
    } catch {
      // The next status poll will retry.
    } finally {
      polling = false;
    }
  }

  async function send(text, fromInput = false, preset = null) {
    if (!available || pending) return;
    const kind = mode;
    if (kind === 'message' && selectedSender && !onlinePlayers.includes(selectedSender)) return;
    const error = validate(kind, text);
    if (error) {
      showFeedback(error, true);
      return;
    }
    pending = true;
    const version = ++revision;
    updateControls();
    showFeedback(kind === 'command' ? '発行中…' : '返答を待っています…');
    try {
      const player = kind === 'message' && selectedSender ? selectedSender : undefined;
      const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ kind, text, player }) });
      if (preset && presets[kind].includes(preset)) {
        preset.uses++;
        savePresets(kind);
        if (kind === mode && orders[kind] === 'frequency' && dialog.open) renderPresetList();
      }
      if (revision !== version) return;
      if (fromInput) {
        if (mode === kind && input.value.trim() === text) input.value = '';
        else if (drafts[kind].trim() === text) drafts[kind] = '';
      }
      renderEntries(data.entries, true);
      showFeedback(kind === 'command' ? 'ワールドにコマンドを送信しました。'
        : data.replied ? '' : 'ワールドに送信しました。相棒は今は返答できません。');
    } catch (failure) {
      if (revision === version) showFeedback(failure.message, true);
    } finally {
      pending = false;
      updateControls();
    }
  }

  function orderedPresets() {
    return orders[mode] === 'frequency' ? [...presets[mode]].sort((a, b) => b.uses - a.uses) : presets[mode];
  }

  function renderPresets() {
    quick.replaceChildren(...orderedPresets().map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.name + ' ↗';
      button.title = item.text;
      button.addEventListener('click', () => void send(item.text, false, item));
      return button;
    }));
    updateControls();
  }

  function selectMode(next) {
    drafts[mode] = input.value;
    mode = next;
    const setup = modes[mode];
    composer.dataset.mode = mode;
    modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.composeMode === mode)));
    input.value = drafts[mode];
    input.placeholder = setup.placeholder;
    input.maxLength = setup.limit;
    input.setAttribute('aria-label', setup.label);
    sendButton.textContent = setup.action;
    byId('play-presets-label').textContent = `${setup.presetsLabel} · 押すと${setup.action}`;
    renderPresets();
  }

  function savePresets(kind = mode) {
    try {
      localStorage.setItem(modes[kind].storage, JSON.stringify(presets[kind]));
      localStorage.setItem(modes[kind].storage + '-order', orders[kind]);
    } catch {
      showFeedback('このブラウザに登録内容を保存できませんでした。', true);
    }
    if (mode === kind) renderPresets();
  }

  function resetPresetForm() {
    editedPreset = null;
    presetForm.reset();
    presetText.setCustomValidity('');
    presetForm.querySelector('[type="submit"]').textContent = '登録';
  }

  function movePreset(item, targetIndex, focusDirection) {
    const list = presets[mode];
    const index = list.indexOf(item);
    if (index < 0 || index === targetIndex || targetIndex < 0 || targetIndex >= list.length) return;
    list.splice(index, 1);
    list.splice(targetIndex, 0, item);
    savePresets();
    renderPresetList();
    if (focusDirection) {
      const row = presetList.children[targetIndex];
      const button = row.querySelector(`[data-move="${focusDirection}"]:not(:disabled)`);
      (button || row.querySelector('[data-move]:not(:disabled)'))?.focus();
    }
  }

  function renderPresetList() {
    const manual = orders[mode] === 'manual';
    presetOrder.value = orders[mode];
    const canReorder = manual && presets[mode].length > 1;
    byId('play-preset-reorder-hint').hidden = !canReorder;
    presetList.replaceChildren(...orderedPresets().map((item, index) => {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${item.name} · ${item.text}`;
      row.append(text);
      if (canReorder) {
        const reorder = document.createElement('div');
        reorder.className = 'preset-reorder';
        for (const [direction, label, step] of [['up', '上へ移動', -1], ['down', '下へ移動', 1]]) {
          const move = document.createElement('button');
          move.type = 'button';
          move.dataset.move = direction;
          move.textContent = step < 0 ? '↑' : '↓';
          move.setAttribute('aria-label', `${item.name}を${label}`);
          move.disabled = !presets[mode][index + step];
          move.addEventListener('click', () => movePreset(item, index + step, direction));
          reorder.append(move);
        }
        text.draggable = true;
        text.title = 'ドラッグして並び替え';
        text.addEventListener('dragstart', (event) => {
          draggedPreset = item;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.name);
        });
        text.addEventListener('dragend', () => {
          draggedPreset = null;
          presetList.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
        });
        row.addEventListener('dragover', (event) => {
          if (!draggedPreset || draggedPreset === item) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          presetList.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
          row.classList.add('is-drop-target');
        });
        row.addEventListener('dragleave', (event) => {
          if (!row.contains(event.relatedTarget)) row.classList.remove('is-drop-target');
        });
        row.addEventListener('drop', (event) => {
          if (!draggedPreset) return;
          event.preventDefault();
          row.classList.remove('is-drop-target');
          const itemToMove = draggedPreset;
          draggedPreset = null;
          movePreset(itemToMove, index);
        });
        row.append(reorder);
      }
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '編集';
      edit.addEventListener('click', () => {
        editedPreset = item;
        presetName.value = item.name;
        presetText.value = item.text;
        presetText.setCustomValidity('');
        presetForm.querySelector('[type="submit"]').textContent = '保存';
        presetName.focus();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '削除';
      remove.addEventListener('click', () => {
        presets[mode].splice(presets[mode].indexOf(item), 1);
        savePresets();
        resetPresetForm();
        renderPresetList();
        presetName.focus();
      });
      row.append(edit, remove);
      return row;
    }));
  }

  presetOrder.addEventListener('change', () => {
    orders[mode] = presetOrder.value === 'frequency' ? 'frequency' : 'manual';
    savePresets();
    renderPresetList();
  });
  modeButtons.forEach((button) => button.addEventListener('click', () => selectMode(button.dataset.composeMode)));
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void send(input.value.trim(), true);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    composer.requestSubmit();
  });
  byId('play-presets-manage').addEventListener('click', () => {
    resetPresetForm();
    const setup = modes[mode];
    byId('play-preset-title').textContent = setup.presetsLabel;
    byId('play-preset-content-label').textContent = setup.label;
    presetText.placeholder = setup.placeholder;
    presetText.maxLength = setup.limit;
    renderPresetList();
    dialog.showModal();
    presetName.focus();
  });
  byId('play-preset-close').addEventListener('click', () => dialog.close());
  presetText.addEventListener('input', () => presetText.setCustomValidity(''));
  presetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = presetName.value.trim();
    const text = presetText.value.trim();
    const error = validate(mode, text);
    if (error) {
      presetText.setCustomValidity(error);
      presetText.reportValidity();
      return;
    }
    if (!name) return;
    if (editedPreset === null) presets[mode].push({ name, text, uses: 0 });
    else Object.assign(editedPreset, { name, text });
    savePresets();
    dialog.close();
  });

  selectMode(mode);
  renderEntries([]);
  return function syncPlayChat(status) {
    const connected = Boolean(status?.spawned && status.chatIngame);
    if (connected !== available) {
      available = connected;
      revision++;
      rendered = '';
      if (!available) renderEntries([]);
      updateControls();
    }
    byId('play-bot-name').textContent = status?.username || status?.botName || '';
    onlinePlayers = Array.isArray(status?.onlinePlayers) ? status.onlinePlayers : [];
    renderSenders();
    updateControls();
    if (available) void refresh();
  };
}
