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
        && !validate(kind, item.text));
    }
  } catch {
    // The dashboard remains usable when browser storage is unavailable.
  }
  return [];
}

export function bindPlayChat(api) {
  const byId = (id) => document.getElementById(id);
  const composer = byId('play-compose');
  const feed = byId('conversation-feed');
  const input = byId('play-message');
  const sendButton = byId('play-send');
  const feedback = byId('play-send-status');
  const quick = byId('play-presets');
  const modeButtons = composer.querySelectorAll('[data-compose-mode]');
  const dialog = byId('play-preset-dialog');
  const presetForm = byId('play-preset-form');
  const presetList = byId('play-preset-list');
  const presetName = byId('play-preset-name');
  const presetText = byId('play-preset-text');
  const presets = { message: readPresets('message'), command: readPresets('command') };
  const drafts = { message: '', command: '' };
  let mode = 'message';
  let editIndex = null;
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
    sendButton.disabled = !available || pending;
    quick.querySelectorAll('button').forEach((button) => { button.disabled = sendButton.disabled; });
  }

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
      const who = entry.kind === 'companion' ? '相棒' : entry.kind === 'command' ? 'あなた · Minecraftコマンド' : 'あなた';
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

  async function send(text, fromInput = false) {
    if (!available || pending) return;
    const kind = mode;
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
      const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ kind, text }) });
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

  function renderPresets() {
    quick.replaceChildren(...presets[mode].map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.name + ' ↗';
      button.title = item.text;
      button.addEventListener('click', () => void send(item.text));
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

  function savePresets() {
    try {
      localStorage.setItem(modes[mode].storage, JSON.stringify(presets[mode]));
    } catch {
      showFeedback('このブラウザに登録内容を保存できませんでした。', true);
    }
    renderPresets();
  }

  function resetPresetForm() {
    editIndex = null;
    presetForm.reset();
    presetText.setCustomValidity('');
    presetForm.querySelector('[type="submit"]').textContent = '登録';
  }

  function renderPresetList() {
    presetList.replaceChildren(...presets[mode].map((item, index) => {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${item.name} · ${item.text}`;
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = '編集';
      edit.addEventListener('click', () => {
        editIndex = index;
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
        presets[mode].splice(index, 1);
        savePresets();
        resetPresetForm();
        renderPresetList();
        presetName.focus();
      });
      row.append(text, edit, remove);
      return row;
    }));
  }

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
    if (editIndex === null) presets[mode].push({ name, text });
    else presets[mode][editIndex] = { name, text };
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
    if (available) void refresh();
  };
}
