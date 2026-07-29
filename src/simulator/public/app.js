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
  $('scenario').innerHTML = scenarios.map((item) => `<option value="${item.name}">${scenarioLabel(item.name)}</option>`).join('');
  loadScenario(scenarios[0].name);
  refreshSaved();
}

function loadScenario(name) {
  state = structuredClone(scenarios.find((item) => item.name === name));
  decision = null;
  syncEnemyAiInputs();
  syncExpectationInputs();
  render();
}

async function tick() {
  applyEnemyAiInputs();
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
  (decision?.enemyMotions || []).forEach((motion) => drawEnemyMotion(motion));
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
  state.enemies.forEach((enemy) => {
    const motion = decision?.enemyMotions?.find((item) => item.id === enemy.id);
    triangle(enemy, 11, enemy.kind === 'skeleton' ? '#fb7185' : '#ef4444', motion);
  });
  circle(state.bot, 11, '#34d399', true);
  ctx.restore();
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '13px system-ui';
  ctx.fillText(`tick ${state.tick}  時間 ${(state.now / 1000).toFixed(2)}秒  攻撃回数 ${state.attacks}`, 14, 22);
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
function triangle(item, size, color, motion) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(item.x * scale, item.z * scale - size); ctx.lineTo(item.x * scale + size, item.z * scale + size); ctx.lineTo(item.x * scale - size, item.z * scale + size); ctx.fill();
  const motionLabel = motion ? ` · ${behaviorLabel(motion.behavior)} ${motion.speed.toFixed(2)}/tick${motion.fired ? ' · 射撃' : ''}` : '';
  ctx.fillStyle = '#e5e7eb'; ctx.font = '11px system-ui'; ctx.fillText(`${item.kind}${motionLabel}`, item.x * scale + 12, item.z * scale + 4);
}
function drawEnemyMotion(motion) {
  ctx.strokeStyle = motion.fired ? '#fbbf24' : '#94a3b8';
  ctx.lineWidth = motion.fired ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(motion.from.x * scale, motion.from.z * scale);
  ctx.lineTo(motion.to.x * scale, motion.to.z * scale);
  ctx.stroke();
  if (motion.fired) {
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(motion.to.x * scale, motion.to.z * scale);
    ctx.lineTo(state.bot.x * scale, state.bot.z * scale);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function renderDecision() {
  const recovery = decision?.recovery;
  const values = {
    制御所有者: ownerLabel(decision?.controlOwner || state.lastOwner),
    戦闘意図: intentLabel(decision?.intent?.priority) || '—',
    移動: movementLabel(decision?.movement) || '—',
    span: decision?.spanDeg == null ? '—' : `${decision.spanDeg.toFixed(1)}°`,
    '選択後span': decision?.selectedSpanDeg == null ? '—' : `${decision.selectedSpanDeg.toFixed(1)}°`,
    敵AI: `${state.enemyAi?.enabled ? '有効' : '無効'} · ${Number(state.enemyAi?.speedScale || 1).toFixed(2)}×`,
    遠距離圧: decision?.rangedPressureCount ?? 0,
    射撃回数: state.shots || 0,
    目的地: decision?.destination ? formatPoint(decision.destination) : '—',
    主対象: decision?.primaryId ?? '—',
    復旧: recovery ? `${recoveryLabel(recovery.phase)} / 残り${recovery.remainingIds.length}件` : '—',
    期限残り: recovery ? `${recovery.deadlineRemainingMs} ms` : '—',
    装備: state.equipped || '—'
  };
  $('decision').innerHTML = Object.entries(values)
    .map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(String(value))}</dd>`).join('');
  $('validation').innerHTML = (decision?.validation || []).map((item) =>
    `<div class="${item.pass ? 'pass' : 'fail'}">${item.pass ? '合格' : '不合格'} ${escapeHtml(validationLabel(item.field))}: ${escapeHtml(String(item.actual))}</div>`
  ).join('');
}

function renderEntityOptions() {
  const current = $('entity').value;
  const items = [
    ['bot', 'Bot'],
    ...(state.owner ? [['owner', 'オーナー']] : []),
    ...state.enemies.map((item) => [`enemy:${item.id}`, `${item.kind} #${item.id}`]),
    ...state.drops.map((item) => [`drop:${item.id}`, `${item.item} #${item.id}`]),
    ...state.obstacles.map((item) => [`obstacle:${item.id}`, `障害物 #${item.id}`])
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
function applyEnemyAiInputs() {
  state.enemyAi = {
    enabled: $('enemy-ai').checked,
    speedScale: Number($('enemy-speed').value)
  };
}
function syncEnemyAiInputs() {
  const config = { enabled: false, speedScale: 1, ...(state.enemyAi || {}) };
  state.enemyAi = config;
  state.shots ||= 0;
  $('enemy-ai').checked = config.enabled;
  $('enemy-speed').value = String(config.speedScale);
  $('enemy-speed-value').textContent = `${Number(config.speedScale).toFixed(2)}×`;
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
  state = JSON.parse(raw); decision = null; syncEnemyAiInputs(); syncExpectationInputs(); render();
}
function exportCase() {
  applyExpectations();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${state.name || 'combat-case'}.json`; link.click(); URL.revokeObjectURL(link.href);
}

$('scenario').addEventListener('change', () => loadScenario($('scenario').value));
$('reset').addEventListener('click', () => loadScenario($('scenario').value));
$('tick').addEventListener('click', () => tick().catch(alert));
$('enemy-ai').addEventListener('change', () => { applyEnemyAiInputs(); render(); });
$('enemy-speed').addEventListener('input', () => { applyEnemyAiInputs(); syncEnemyAiInputs(); render(); });
$('play').addEventListener('click', () => {
  playing = !playing; $('play').textContent = playing ? '一時停止' : '自動進行';
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
  state = JSON.parse(await file.text()); decision = null; syncEnemyAiInputs(); syncExpectationInputs(); render();
});

function formatPoint(point) { return `(${point.x.toFixed(2)}, ${point.z.toFixed(2)})`; }
function round(value) { return Math.round(value * 4) / 4; }
function escapeHtml(value) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function scenarioLabel(value) {
  return ({
    'single-ranged': '単体遠距離: 回避→前進→攻撃',
    'multi-positioning': '複数脅威: 敵列外側への位置取り',
    recovery: '復旧: 墓回収→装備→戦闘',
    'dynamic-melee-pincer': '動的: 近接2体の挟撃',
    'dynamic-ranged-pressure': '動的: 遠距離2体の射撃圧',
    'dynamic-mixed': '動的: 近接・遠距離混成'
  })[value] || value;
}
function behaviorLabel(value) { return ({ chase: '追尾', retreat: '距離確保', strafe: '横移動', hold: '待機' })[value] || value; }
function ownerLabel(value) { return ({ follow: '追従', combat: '戦闘', recovery: '復旧', survival: '緊急生存', transfer: '受け渡し', wait: '待機' })[value] || value || '—'; }
function intentLabel(value) { return ({ attack: '攻撃', guard: '防御', dodge: '回避', hold: '維持' })[value] || value; }
function movementLabel(value) { return ({ stay: '現在地維持', positioning: '位置取り', dodge: '回避', advance: '前進', attack: '攻撃', follow: '追従', recovery: '復旧', survival: '緊急生存', hold: '維持' })[value] || value; }
function recoveryLabel(value) { return ({ travel: '墓へ移動', grave: '墓を破壊', items: 'アイテム回収', equip: '装備復元', done: '完了' })[value] || value; }
function validationLabel(value) { return ({ owner: '制御所有者', intent: '戦闘意図', maxSpanDeg: '最大span', recoveryActive: '復旧中', equipped: '装備' })[value] || value; }

boot().catch((error) => { document.body.textContent = error.message; });
