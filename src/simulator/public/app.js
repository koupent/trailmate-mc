const $ = (id) => document.getElementById(id);
const canvas = $('arena');
const ctx = canvas.getContext('2d');
const scale = 28;
let scenarios = [];
let state = null;
let decision = null;
let playing = false;
let timer = null;

async function boot() {
  scenarios = await fetch('/api/scenarios').then((response) => response.json());
  $('scenario').innerHTML = scenarios.map((item) => `<option value="${item.name}">${item.name}</option>`).join('');
  loadScenario(scenarios[0].name);
  refreshSaved();
}

function loadScenario(name) {
  state = structuredClone(scenarios.find((item) => item.name === name));
  decision = null;
  syncExpectationInputs();
  render();
}

async function tick() {
  applyExpectations();
  const response = await fetch('/api/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state)
  });
  if (!response.ok) throw new Error(await response.text());
  ({ state, decision } = await response.json());
  render();
}

function render() {
  drawArena();
  renderEntityOptions();
  renderDecision();
  $('transitions').innerHTML = (state.transitions || []).slice().reverse()
    .map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}

function drawArena() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  drawGrid();
  state.obstacles.forEach((item) => drawObstacle(item));
  if (decision?.destination) {
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(state.bot.x * scale, state.bot.z * scale);
    ctx.lineTo(decision.destination.x * scale, decision.destination.z * scale);
    ctx.stroke();
    ctx.setLineDash([]);
    circle(decision.destination, 7, '#facc15', false);
  }
  state.drops.forEach((drop) => circle(drop, 6, drop.graveOwned ? '#f59e0b' : '#9ca3af', false));
  if (state.grave) square(state.grave, 14, '#a78bfa');
  if (state.owner) diamond(state.owner, 10, '#60a5fa');
  state.enemies.forEach((enemy) => triangle(enemy, 11, enemy.kind === 'skeleton' ? '#fb7185' : '#ef4444'));
  circle(state.bot, 11, '#34d399', true);
  ctx.restore();
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '13px system-ui';
  ctx.fillText(`tick ${state.tick}  time ${(state.now / 1000).toFixed(2)}s  attacks ${state.attacks}`, 14, 22);
}

function drawGrid() {
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#263449';
  for (let n = -12; n <= 12; n += 1) {
    ctx.beginPath(); ctx.moveTo(n * scale, -11 * scale); ctx.lineTo(n * scale, 11 * scale); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-13 * scale, n * scale); ctx.lineTo(13 * scale, n * scale); ctx.stroke();
  }
  ctx.strokeStyle = '#64748b';
  ctx.beginPath(); ctx.moveTo(-13 * scale, 0); ctx.lineTo(13 * scale, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -11 * scale); ctx.lineTo(0, 11 * scale); ctx.stroke();
}

function drawObstacle(item) {
  ctx.fillStyle = '#475569';
  ctx.fillRect((item.x - item.size / 2) * scale, (item.z - item.size / 2) * scale, item.size * scale, item.size * scale);
}
function circle(item, radius, color, fill) {
  ctx.beginPath(); ctx.arc(item.x * scale, item.z * scale, radius, 0, Math.PI * 2);
  ctx[fill ? 'fillStyle' : 'strokeStyle'] = color; ctx.lineWidth = 3; ctx[fill ? 'fill' : 'stroke']();
}
function square(item, size, color) {
  ctx.fillStyle = color; ctx.fillRect(item.x * scale - size / 2, item.z * scale - size / 2, size, size);
}
function diamond(item, size, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(item.x * scale, item.z * scale - size); ctx.lineTo(item.x * scale + size, item.z * scale); ctx.lineTo(item.x * scale, item.z * scale + size); ctx.lineTo(item.x * scale - size, item.z * scale); ctx.fill();
}
function triangle(item, size, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(item.x * scale, item.z * scale - size); ctx.lineTo(item.x * scale + size, item.z * scale + size); ctx.lineTo(item.x * scale - size, item.z * scale + size); ctx.fill();
  ctx.fillStyle = '#e5e7eb'; ctx.font = '11px system-ui'; ctx.fillText(item.kind, item.x * scale + 12, item.z * scale + 4);
}

function renderDecision() {
  const recovery = decision?.recovery;
  const values = {
    owner: decision?.controlOwner || state.lastOwner,
    intent: decision?.intent?.priority || '—',
    movement: decision?.movement || '—',
    span: decision?.spanDeg == null ? '—' : `${decision.spanDeg.toFixed(1)}°`,
    'selected span': decision?.selectedSpanDeg == null ? '—' : `${decision.selectedSpanDeg.toFixed(1)}°`,
    destination: decision?.destination ? formatPoint(decision.destination) : '—',
    primary: decision?.primaryId ?? '—',
    recovery: recovery ? `${recovery.phase} / ${recovery.remainingIds.length} left` : '—',
    deadline: recovery ? `${recovery.deadlineRemainingMs} ms` : '—',
    equipped: state.equipped || '—'
  };
  $('decision').innerHTML = Object.entries(values)
    .map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(String(value))}</dd>`).join('');
  $('validation').innerHTML = (decision?.validation || []).map((item) =>
    `<div class="${item.pass ? 'pass' : 'fail'}">${item.pass ? 'PASS' : 'FAIL'} ${escapeHtml(item.field)}: ${escapeHtml(String(item.actual))}</div>`
  ).join('');
}

function renderEntityOptions() {
  const current = $('entity').value;
  const items = [
    ['bot', 'Bot'],
    ...(state.owner ? [['owner', 'Owner']] : []),
    ...state.enemies.map((item) => [`enemy:${item.id}`, `${item.kind} #${item.id}`]),
    ...state.drops.map((item) => [`drop:${item.id}`, `${item.item} #${item.id}`]),
    ...state.obstacles.map((item) => [`obstacle:${item.id}`, `Obstacle #${item.id}`])
  ];
  $('entity').innerHTML = items.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  if (items.some(([value]) => value === current)) $('entity').value = current;
}

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * canvas.width / rect.width - canvas.width / 2) / scale;
  const z = ((event.clientY - rect.top) * canvas.height / rect.height - canvas.height / 2) / scale;
  const selected = $('entity').value;
  const target = selected === 'bot' ? state.bot
    : selected === 'owner' ? state.owner
      : findBySelection(selected);
  if (target) Object.assign(target, { x: round(x), z: round(z) });
  render();
});

function findBySelection(selected) {
  const [type, rawId] = selected.split(':');
  const list = type === 'enemy' ? state.enemies : type === 'drop' ? state.drops : state.obstacles;
  return list.find((item) => item.id === Number(rawId));
}

function add(type) {
  const base = { id: state.nextId++, x: 2, z: 2 };
  if (type === 'enemy') state.enemies.push({ ...base, kind: $('enemy-kind').value, hp: 20 });
  if (type === 'drop') state.drops.push({ ...base, item: 'dirt' });
  if (type === 'obstacle') state.obstacles.push({ ...base, size: 1.5 });
  render();
}

function removeSelected() {
  const selected = $('entity').value;
  const [type, rawId] = selected.split(':');
  const id = Number(rawId);
  if (type === 'enemy') state.enemies = state.enemies.filter((item) => item.id !== id);
  if (type === 'drop') state.drops = state.drops.filter((item) => item.id !== id);
  if (type === 'obstacle') state.obstacles = state.obstacles.filter((item) => item.id !== id);
  render();
}

function applyExpectations() {
  state.expectations = {};
  if ($('expect-owner').value) state.expectations.owner = $('expect-owner').value;
  if ($('expect-intent').value) state.expectations.intent = $('expect-intent').value;
  if ($('expect-span').value !== '') state.expectations.maxSpanDeg = Number($('expect-span').value);
}
function syncExpectationInputs() {
  $('expect-owner').value = state.expectations?.owner || '';
  $('expect-intent').value = state.expectations?.intent || '';
  $('expect-span').value = state.expectations?.maxSpanDeg ?? '';
}

function saveCase() {
  const name = $('case-name').value.trim() || `case-${Date.now()}`;
  applyExpectations();
  localStorage.setItem(`trailmate-sim:${name}`, JSON.stringify(state));
  refreshSaved(name);
}
function refreshSaved(selected = '') {
  const names = Object.keys(localStorage).filter((key) => key.startsWith('trailmate-sim:')).map((key) => key.slice(14)).sort();
  $('saved').innerHTML = names.map((name) => `<option>${escapeHtml(name)}</option>`).join('');
  if (selected) $('saved').value = selected;
}
function loadSaved() {
  const raw = localStorage.getItem(`trailmate-sim:${$('saved').value}`);
  if (!raw) return;
  state = JSON.parse(raw); decision = null; syncExpectationInputs(); render();
}
function exportCase() {
  applyExpectations();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${state.name || 'combat-case'}.json`; link.click(); URL.revokeObjectURL(link.href);
}

$('scenario').addEventListener('change', () => loadScenario($('scenario').value));
$('reset').addEventListener('click', () => loadScenario($('scenario').value));
$('tick').addEventListener('click', () => tick().catch(alert));
$('play').addEventListener('click', () => {
  playing = !playing; $('play').textContent = playing ? 'Pause' : 'Auto';
  clearInterval(timer); if (playing) timer = setInterval(() => tick().catch(() => {}), 300);
});
$('add-enemy').addEventListener('click', () => add('enemy'));
$('add-drop').addEventListener('click', () => add('drop'));
$('add-obstacle').addEventListener('click', () => add('obstacle'));
$('remove').addEventListener('click', removeSelected);
$('save').addEventListener('click', saveCase);
$('load').addEventListener('click', loadSaved);
$('export').addEventListener('click', exportCase);
$('import').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  state = JSON.parse(await file.text()); decision = null; syncExpectationInputs(); render();
});

function formatPoint(point) { return `(${point.x.toFixed(2)}, ${point.z.toFixed(2)})`; }
function round(value) { return Math.round(value * 4) / 4; }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

boot().catch((error) => { document.body.textContent = error.message; });
