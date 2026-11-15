import { createScene } from './scene.js';

const $ = id => document.getElementById(id);
const scene = createScene($('viewport'));
scene.setFollowBot(true);
let id, playing = false, busy = false, generation = 0;

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function stop() { playing = false; $('water-play').textContent = '再生'; }
function render(state) {
  scene.sync(state, null);
  $('water-vitals').textContent = `経過 ${(state.tick / 20).toFixed(1)}秒 ｜ 体力 ${state.bot.hp}/20 ｜ 酸素 ${state.vitals.oxygen}/20 ｜ 満腹度 ${state.vitals.food}/20 ｜ 溺水ダメージ ${state.vitals.drowningDamage}`;
  const n = state.navigation;
  const p = n.target;
  const format = point => point ? `${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)}` : '—';
  const rows = [
    ['状態', ({ returning: '呼吸できる場所へ帰還中', recovering: '水面で回復待ち',
      holding: '酸素を帰還に残すため潜水を保留', blocked: '通れる水路を確認できないため停止', near: '追従距離内で待機' })[n.phase] || '追従中'],
    ['プレイヤーとの水平距離', `${state.metrics.horizontalDistance.toFixed(2)}ブロック`],
    ['プレイヤーとの高低差', `${state.metrics.depthDifference.toFixed(2)}ブロック`],
    ['相棒の位置', format(state.bot)], ['プレイヤーの位置', format(state.owner)],
    ['帰還先', format(p)], ['酸素の残り時間', `${(n.availableSeconds ?? state.vitals.airTicks / 20).toFixed(1)}秒`],
    ['帰還の見積もり', n.returnSeconds == null ? '—' : `${n.returnSeconds.toFixed(1)}秒`],
    ['帰還回数', state.metrics.returnCount], ['追従再開回数', state.metrics.resumedCount]
  ];
  $('water-status').replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = String(value); return [dt, dd];
  }));
  if (state.ended) stop();
}
async function reset() {
  stop(); const version = ++generation;
  const result = await post('/api/water/start', { scenario: $('water-scenario').value });
  if (version !== generation) return;
  id = result.id; render(result.state); $('water-error').textContent = '';
}
async function step(ticks = 5) {
  if (busy || !id) return;
  busy = true; const version = generation;
  try { const result = await post('/api/water/tick', { id, ticks }); if (version === generation) render(result.state); }
  catch (error) { stop(); $('water-error').textContent = error.message; }
  finally { busy = false; }
}
$('water-reset').onclick = () => reset().catch(error => { $('water-error').textContent = error.message; });
$('water-step').onclick = () => step();
$('water-play').onclick = () => { playing = !playing; $('water-play').textContent = playing ? '一時停止' : '再生'; };
setInterval(() => { if (playing) void step(Number($('water-speed').value)); }, 250);
const scenarios = await fetch('/api/water/scenarios').then(r => r.json());
for (const scenario of scenarios) {
  const option = document.createElement('option'); option.value = scenario.id; option.textContent = scenario.name;
  $('water-scenario').appendChild(option);
}
await reset();
