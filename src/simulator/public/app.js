import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const scene = createScene(viewport);

function syncCameraFollowButton() {
  const btn = $('camera-follow-toggle');
  if (!btn) return;
  const on = scene.getFollowBot();
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? 'カメラ: 相棒追従' : 'カメラ: 固定';
}

$('camera-follow-toggle')?.addEventListener('click', () => {
  scene.setFollowBot(!scene.getFollowBot());
  // 追従ON直後は現在の state があれば一度 sync で target を合わせる
  if (scene.getFollowBot() && state) {
    scene.sync(state, decision, {});
  }
  syncCameraFollowButton();
});
syncCameraFollowButton();

let scenarios = [];
let state = null;
let decision = null;
let playing = false;
let timer = null;
let latestStats = null;
let prevSnapshot = null;
const eventLog = [];

/** 放置学習ループ */
let learning = false;
let learnLoopPromise = null;
let nextSeed = Date.now() % 1_000_000;
let watchMode = false; // 学習中のライブ観戦

async function boot() {
  scenarios = await fetch('/api/scenarios').then((response) => response.json());
  $('scenario').innerHTML = scenarios.map((item) => (
    `<option value="${item.name}">${scenarioLabel(item.name)}</option>`
  )).join('');
  loadScenario(scenarios[0].name);
  await refreshStats();
  setLearnStatus(false, '停止中 — 「学習を開始」で放置運転できます');
}

function loadScenario(name) {
  stopPlayback();
  state = structuredClone(scenarios.find((item) => item.name === name));
  decision = null;
  prevSnapshot = null;
  eventLog.length = 0;
  syncEnemyAiInputs();
  render();
}

async function tick() {
  if (!state) return { ended: true };
  // HP0 / 死亡フラグのどちらかで完全停止（古い状態JSONでも効くよう hp も見る）
  if (state.ended || state.botDead || state.bot?.hp <= 0) {
    state.botDead = true;
    state.ended = true;
    state.outcome = state.outcome === 'win' ? 'win' : 'lose';
    state.bot.hp = 0;
    stopPlayback();
    render({ botDead: true });
    return { ended: true };
  }
  applyEnemyAiInputs();
  const before = snapshotCombat(state);
  const response = await fetch('/api/tick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state)
  });
  if (!response.ok) throw new Error(await response.text());
  ({ state, decision } = await response.json());
  const events = buildEvents(before, state, decision);
  if (state.bot?.hp <= 0) {
    state.botDead = true;
    state.ended = true;
    state.outcome = 'lose';
    state.bot.hp = 0;
  }
  if (state.botDead || state.outcome === 'lose') {
    events.botDead = true;
    events.lines.push({ kind: 'hurt', text: `t${state.tick} 相棒死亡 — 戦闘終了（停止）` });
  } else if (state.outcome === 'win') {
    events.lines.push({ kind: 'attack', text: `t${state.tick} 戦闘勝利` });
  }
  pushEvents(events);
  prevSnapshot = snapshotCombat(state);
  render(events);
  if (state.ended || state.botDead || state.bot?.hp <= 0) {
    stopPlayback();
    return { ended: true };
  }
  return { ended: false };
}

function snapshotCombat(current) {
  if (!current) return null;
  return {
    attacks: current.attacks || 0,
    shots: current.shots || 0,
    damageTaken: current.damageTaken || 0,
    botHp: current.bot?.hp ?? 20,
    botDead: Boolean(current.botDead),
    enemyHp: Object.fromEntries((current.enemies || []).map((enemy) => [enemy.id, enemy.hp]))
  };
}

function buildEvents(before, after, nextDecision) {
  const events = {
    botAttacked: false,
    botHurt: false,
    botDead: Boolean(after.botDead),
    damageDelta: 0,
    shotsFired: 0,
    lines: []
  };
  if (!before || !after) return events;

  if ((after.attacks || 0) > before.attacks) {
    events.botAttacked = true;
    const primary = after.enemies.find((enemy) => enemy.id === nextDecision?.primaryId);
    events.lines.push({
      kind: 'attack',
      text: `t${after.tick} 近接攻撃 ${primary ? primary.kind : '敵'}へ -4`
    });
  }

  const shotDelta = (after.shots || 0) - (before.shots || 0);
  if (shotDelta > 0) {
    events.shotsFired = shotDelta;
    const shooters = (nextDecision?.enemyMotions || []).filter((motion) => motion.fired);
    for (const motion of shooters) {
      const enemy = after.enemies.find((item) => item.id === motion.id);
      if (motion.hitKind === 'enemy') {
        const victim = after.enemies.find((item) => item.id === motion.hitEntityId);
        events.lines.push({
          kind: 'shot',
          text: `t${after.tick} 敵同士被弾 ← 矢が${victim?.kind || '敵'}に当たった（相棒には未到達）`
        });
      } else if (motion.hitKind === 'block') {
        events.lines.push({
          kind: 'shot',
          text: `t${after.tick} 敵射撃 ${enemy?.kind || ''} → 壁に当たって無効`
        });
      } else {
        events.lines.push({
          kind: 'shot',
          text: `t${after.tick} 敵射撃 ${enemy?.kind || ''} → 相棒`
        });
      }
    }
  }

  const damageDelta = (after.damageTaken || 0) - (before.damageTaken || 0);
  if (damageDelta > 0) {
    events.botHurt = true;
    events.damageDelta = damageDelta;
    events.lines.push({
      kind: 'hurt',
      text: `t${after.tick} 被弾 -${damageDelta}（残りHP ${after.bot.hp}）`
    });
  }

  if (
    nextDecision?.movement
    && !['stay', 'attack', 'dead'].includes(nextDecision.movement)
  ) {
    events.lines.push({
      kind: 'move',
      text: `t${after.tick} ${movementLabel(nextDecision.movement)} / 意図 ${intentLabel(nextDecision.intent?.priority) || '—'}`
    });
  }

  for (const [id, prevHp] of Object.entries(before.enemyHp || {})) {
    const still = after.enemies.find((enemy) => String(enemy.id) === String(id));
    if (!still && prevHp > 0) {
      events.lines.push({ kind: 'attack', text: `t${after.tick} 敵#${id} 撃破` });
    }
  }

  return events;
}

function pushEvents(events) {
  for (const line of events.lines || []) eventLog.unshift(line);
  while (eventLog.length > 14) eventLog.pop();
}

function render(events = {}) {
  scene.sync(state, decision, events);
  renderEntityOptions();
  renderDecision();
  renderHud(events);
  renderEventFeed();
}

function renderHud(events = {}) {
  const banner = $('action-banner');
  if (!banner || !state) return;
  const movement = decision?.movement || 'idle';
  let text = learning ? '学習待機…' : '待機中';
  let klass = 'idle';
  if (state.botDead || state.outcome === 'lose' || movement === 'dead') {
    text = '相棒死亡 — エピソード終了';
    klass = 'hurt';
  } else if (state.outcome === 'win') {
    text = '勝利 — 敵全滅';
    klass = 'attack';
  } else if (events.botHurt) {
    text = `被弾 -${events.damageDelta}！ HP ${state.bot.hp}`;
    klass = 'hurt';
  } else if (movement === 'attack') {
    const primary = state.enemies.find((enemy) => enemy.id === decision?.primaryId);
    text = `近接攻撃 → ${primary ? primary.kind : '敵'}`;
    klass = 'attack';
  } else if (movement === 'dodge') {
    text = '遠距離回避中';
    klass = 'dodge';
  } else if (movement === 'advance') {
    text = '前進・接近中';
    klass = 'advance';
  } else if (movement === 'positioning') {
    text = '位置取り（扇を狭める）';
    klass = 'positioning';
  } else if ((decision?.enemyMotions || []).some((motion) => motion.fired)) {
    text = '敵が射撃！';
    klass = 'hurt';
  }
  banner.className = `action-banner ${klass}`;
  banner.textContent = `tick ${state.tick} · ${text}`;
}

function renderEventFeed() {
  const feed = $('event-feed');
  if (!feed) return;
  feed.innerHTML = eventLog.length
    ? eventLog.map((item) => `<li class="${item.kind}">${escapeHtml(item.text)}</li>`).join('')
    : '<li class="move">学習を開始すると、ここに戦闘ログが流れます。</li>';
}

function renderDecision() {
  if (!state) return;
  const primary = state.enemies.find((enemy) => enemy.id === decision?.primaryId);
  const sit = decision?.situation;
  const phase = decision?.phase;
  const values = {
    結果: outcomeLabel(state.outcome),
    状況型: sit ? `${sit.label}` : '—',
    フェーズ: phase ? phase.label : '—',
    制御: ownerLabel(decision?.controlOwner || state.lastOwner),
    意図: intentLabel(decision?.intent?.priority) || '—',
    移動: movementLabel(decision?.movement) || '—',
    主対象: primary ? `${primary.kind}#${primary.id} HP${primary.hp}` : '—',
    HP: state.botDead ? '0（死亡）' : (state.bot?.hp ?? '—'),
    盾: state.inventory?.includes('shield') ? 'あり' : 'なし',
    被弾: state.damageTaken ?? 0,
    攻撃: state.attacks ?? 0,
    敵射撃: state.shots ?? 0,
    攻撃扇露出: (() => {
      const fans = decision?.safeZoneDebug?.fans || [];
      if (!fans.length) return '—';
      const exposed = fans.filter((fan) => fan.exposed).length;
      const blocked = fans.filter((fan) => fan.blocked).length;
      return `露出${exposed}/${fans.length}・遮蔽${blocked}`;
    })(),
    シード: state.seed ?? '—',
    地形: state.arenaKind || state.name,
    プリセット: state.activePresetId || 'baseline'
  };
  $('decision').innerHTML = Object.entries(values)
    .map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(String(value))}</dd>`).join('');
  renderUtilityLive();
}

function renderUtilityLive() {
  const eqEl = $('utility-equation');
  const liveEl = $('utility-live');
  if (!liveEl) return;
  const utility = decision?.utility;
  if (eqEl && utility?.equation) eqEl.textContent = utility.equation;
  if (!utility) {
    liveEl.innerHTML = '<p class="hint">戦闘中に状況型・フェーズ・項別スコアが出ます。</p>';
    return;
  }
  const sit = decision?.situation;
  const phase = decision?.phase;
  const evalation = utility.evaluation;
  const head = [
    sit ? `<div><strong>型</strong> ${escapeHtml(sit.label)} <span class="hint">${escapeHtml(sit.blurb || '')}</span></div>` : '',
    phase ? `<div><strong>フェーズ</strong> ${escapeHtml(phase.label)} — ${escapeHtml(phase.blurb || '')}</div>` : '',
    evalation ? `<div><strong>score</strong> <code>${Number(evalation.score).toFixed(3)}</code>`
      + (evalation.spanDeg != null ? ` · 扇 ${Number(evalation.spanDeg).toFixed(1)}°` : '')
      + `</div>` : ''
  ].join('');
  const terms = (evalation?.terms || []).map((term) => {
    const pct = Math.min(100, Math.abs(term.contribution) * 40);
    const neg = term.contribution < 0;
    return `<div class="utility-term">`
      + `<div class="utility-term-head"><span>${escapeHtml(term.label)}</span>`
      + `<code>w=${Number(term.weight).toFixed(2)} · f=${Number(term.feature).toFixed(2)} · `
      + `${neg ? '' : '+'}${Number(term.contribution).toFixed(3)}</code></div>`
      + `<div class="utility-bar"><i style="width:${pct}%;background:${neg ? '#f87171' : '#4ade80'}"></i></div>`
      + `</div>`;
  }).join('');
  liveEl.innerHTML = head + (terms || '<p class="hint">単体戦闘では扇項はほぼ0です。</p>');
}

function renderUtilityDashboard(utility) {
  const summaryEl = $('utility-summary');
  const inlineEl = $('utility-summary-inline');
  const bodyEl = $('utility-body');
  if (!summaryEl || !bodyEl) return;
  if (!utility) {
    summaryEl.textContent = '効用は参考表示のみです。';
    if (inlineEl) inlineEl.textContent = '参照のみ';
    bodyEl.innerHTML = '';
    return;
  }
  summaryEl.textContent = utility.methodNote || '';
  if (inlineEl) inlineEl.textContent = '探索停止';
  bodyEl.innerHTML = (
    `<div class="utility-equation-box"><code>${escapeHtml(utility.equation || '')}</code></div>`
    + `<p class="tuning-empty">効用の重み一覧は出していません。チューニング対象は上欄の敵クラス固有パラメータだけです。</p>`
  );
}

function renderEntityOptions() {
  if (!$('entity') || !state) return;
  const current = $('entity').value;
  const items = [
    ['bot', 'Bot'],
    ...(state.owner ? [['owner', 'オーナー']] : []),
    ...state.enemies.map((item) => [`enemy:${item.id}`, `${item.kind} #${item.id}`])
  ];
  $('entity').innerHTML = items.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  if (items.some(([value]) => value === current)) $('entity').value = current;
}

function renderStats(stats) {
  latestStats = stats;
  const winRate = stats.episodes ? ((stats.wins / stats.episodes) * 100).toFixed(1) : '0.0';
  const deathRate = stats.episodes ? ((stats.deaths / stats.episodes) * 100).toFixed(1) : '0.0';
  const tuning = stats.tuning;
  const modeLabel = tuning?.aggregate?.mode || '—';
  $('gym-stats').innerHTML = [
    ['エピソード', stats.episodes],
    ['勝率', `${winRate}%`],
    ['死亡率', `${deathRate}%`],
    ['平均被弾', Number(stats.avgDamage || 0).toFixed(2)],
    ['平均スコア', Number(stats.avgScore || 0).toFixed(2)],
    ['チューニング', modeLabel],
    ['状態', learning ? '学習中（放置可）' : '停止']
  ].map(([key, value]) => (
    `<div class="stat-chip"><span>${escapeHtml(key)}</span><strong>${escapeHtml(String(value))}</strong></div>`
  )).join('');

  renderTuning(tuning);
  renderUtilityDashboard(stats.utility);

  $('clusters').innerHTML = (stats.clusters || []).length
    ? stats.clusters.map((cluster) => (
      `<div class="cluster">`
      + `<strong>${escapeHtml(cluster.label)}</strong> × ${cluster.count}`
      + `<div class="seeds">seed: ${cluster.seeds.map((seed) => `<button data-seed="${seed}" class="seed-btn">${seed}</button>`).join(' ')}</div>`
      + `</div>`
    )).join('')
    : '<p class="hint">まだ失敗クラスタはありません。学習を回してください。</p>';

  $('worst-list').innerHTML = (stats.worst || []).map((item) => (
    `<option value="${item.seed}" data-kind="${escapeHtml(item.arenaKind)}">${item.seed} · ${item.arenaKind} · score ${item.score.toFixed(1)}</option>`
  )).join('');

  document.querySelectorAll('.seed-btn').forEach((button) => {
    button.addEventListener('click', () => {
      $('replay-seed').value = button.dataset.seed;
      watchMode = false;
      loadSeed(Number(button.dataset.seed), {
        autoPlay: true,
        kind: button.dataset.kind || undefined
      }).catch(alert);
    });
  });
}

function formatTuningNumber(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const text = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2);
  return unit ? `${text}${unit}` : text;
}

function renderTuning(tuning) {
  const summaryEl = $('tuning-summary');
  const inlineEl = $('tuning-summary-inline');
  const bodyEl = $('tuning-body');
  if (!tuning) {
    summaryEl.textContent = 'チューニング情報がまだありません。';
    if (inlineEl) inlineEl.textContent = '学習前';
    bodyEl.innerHTML = '';
    return;
  }

  const agg = tuning.aggregate;
  const method = tuning.method;
  summaryEl.textContent = agg.summary || '';
  if (inlineEl) {
    const last = tuning.lastEpisode;
    if (last) {
      inlineEl.textContent = `${last.intentLabel} · ${last.arenaKind} · score ${Number(last.score).toFixed(1)}`;
    } else {
      const best = agg.bestScore == null ? '—' : Number(agg.bestScore).toFixed(1);
      inlineEl.textContent = `${agg.mode} · 探索${agg.paramExploreCount} · 採用${agg.paramAdoptCount} · ベスト${best}`;
    }
  }

  const modeClass = `tuning-mode-${agg.mode}`;
  const metaHtml = [
    ['mode', agg.mode],
    ['対象数', method.tunableCount],
    ['1回の変更', method.mutateKeysPerTrial],
    ['ステップ', `±${Math.round(method.stepRatio * 100)}%`],
    ['探索', agg.paramExploreCount],
    ['採用', agg.paramAdoptCount],
    ['改善なし連続', agg.noImproveStreak],
    ['ベスト', agg.bestScore == null ? '—' : Number(agg.bestScore).toFixed(2)]
  ].map(([key, value], index) => (
    `<div class="stat-chip ${index === 0 ? modeClass : ''}"><span>${escapeHtml(key)}</span><strong>${escapeHtml(String(value))}</strong></div>`
  )).join('');

  const last = tuning.lastEpisode;
  const lastHtml = last
    ? (
      `<div class="tuning-trial current">`
      + `<div class="tuning-trial-head"><strong>いまの目的</strong>`
      + `<span class="tuning-pill">${escapeHtml(last.intentLabel)}</span></div>`
      + `<div class="tuning-trial-body">`
      + `<div>状況: <code>${escapeHtml(last.arenaKind)}</code> / ${escapeHtml(last.contextLabel)}`
      + ` / 敵[${escapeHtml((last.enemyKinds || []).join(', ') || '—')}]`
      + ` / preset=${escapeHtml(last.presetId)}</div>`
      + `<div>結果: score ${Number(last.score).toFixed(2)}`
      + ` · ${last.win ? '勝利' : (last.died ? '死亡' : '未決着')}`
      + (last.exploringParams
        ? ` · ${last.paramsAdopted ? '数値採用' : '数値不採用'}`
        : '')
      + ` · seed ${last.seed}</div>`
      + `</div></div>`
    )
    : '<p class="tuning-empty">まだエピソードがありません。</p>';

  const trials = tuning.recentTrials || [];
  const trialsHtml = trials.length
    ? `<div class="tuning-trials">${trials.map((trial) => {
      const changes = (trial.changes || []).map((row) => (
        `${escapeHtml(row.label)} ${formatTuningNumber(row.from, row.unit)}→${formatTuningNumber(row.to, row.unit)}`
      )).join(' / ');
      return (
        `<div class="tuning-trial ${trial.outcome}">`
        + `<div class="tuning-trial-head">`
        + `<strong>${trial.outcome === 'adopted' ? '採用' : '不採用'}</strong>`
        + `<span>${escapeHtml(changes || trial.changedKeys.join(', '))}</span>`
        + `</div>`
        + `<div class="tuning-trial-body">`
        + `<div>状況: <code>${escapeHtml(trial.arenaKind)}</code> / ${escapeHtml(trial.contextLabel)}`
        + ` / 敵[${escapeHtml((trial.enemyKinds || []).join(', ') || '—')}]</div>`
        + `<div>結果: score ${Number(trial.score).toFixed(2)}`
        + ` · ${trial.win ? '勝利' : (trial.died ? '死亡' : '未決着')}`
        + ` · seed ${trial.seed}</div>`
        + `</div></div>`
      );
    }).join('')}</div>`
    : '<p class="tuning-empty">数値探索の試行はまだありません（敵クラス別の厳選パラメータを少数試行中）。</p>';

  const byClass = tuning.byClass || [];
  const byClassHtml = byClass.length
    ? `<div class="tuning-by-class">${byClass.map((group) => {
      const keyCount = (group.keys || []).length;
      const keys = keyCount
        ? (group.keys || []).map((item) => (
          `<div class="tuning-catalog-item">`
          + `<strong>${escapeHtml(item.label)}</strong>`
          + `<code>${escapeHtml(item.key)}</code>`
          + `<span>${escapeHtml(item.blurb)} · ${formatTuningNumber(item.min, item.unit)}〜${formatTuningNumber(item.max, item.unit)}</span>`
          + `</div>`
        )).join('')
        : '<p class="tuning-empty">数値探索なし（原則＋固定定数）</p>';
      return (
        `<div class="tuning-class-block">`
        + `<div class="tuning-class-head"><strong>${escapeHtml(group.label)}</strong>`
        + `<span>${keyCount} パラメータ</span></div>`
        + (keyCount ? `<div class="tuning-catalog">${keys}</div>` : keys)
        + `</div>`
      );
    }).join('')}</div>`
    : (tuning.catalog || []).map((item) => (
      `<div class="tuning-catalog-item">`
      + `<strong>${escapeHtml(item.label)}</strong>`
      + `<code>${escapeHtml(item.key)}</code>`
      + `<span>${escapeHtml(item.blurb)} · ${formatTuningNumber(item.min, item.unit)}〜${formatTuningNumber(item.max, item.unit)}</span>`
      + `</div>`
    )).join('');

  const contexts = tuning.contexts || [];
  const contextsHtml = contexts.length
    ? contexts.map((ctx) => {
      // 厳選キーはすべて表示（未チューニングも含む）。tuned は強調。
      const rows = (ctx.params || []).map((row) => {
        const span = row.max - row.min || 1;
        const basePct = ((row.base - row.min) / span) * 100;
        const curPct = ((row.current - row.min) / span) * 100;
        const fillPct = Math.max(basePct, curPct);
        const deltaClass = row.delta > 0.0001 ? 'delta-up' : (row.delta < -0.0001 ? 'delta-down' : '');
        const deltaText = row.delta === 0
          ? '±0'
          : `${row.delta > 0 ? '+' : ''}${formatTuningNumber(row.delta, row.unit)}`;
        return (
          `<div class="tuning-param ${row.tuned ? 'tuned' : ''}">`
          + `<div class="tuning-param-name">${escapeHtml(row.label)}`
          + (row.tuned ? '<span class="tuning-pill">採用中</span>' : '')
          + `<small>${escapeHtml(row.key)}</small></div>`
          + `<div class="tuning-bar" title="${escapeHtml(row.blurb)}">`
          + `<div class="tuning-bar-fill" style="width:${fillPct.toFixed(1)}%"></div>`
          + `<div class="tuning-bar-mark" style="left:${basePct.toFixed(1)}%"></div>`
          + `<div class="tuning-bar-mark current" style="left:${curPct.toFixed(1)}%"></div>`
          + `</div>`
          + `<div class="tuning-param-values">`
          + `${formatTuningNumber(row.base, row.unit)} → ${formatTuningNumber(row.current, row.unit)}`
          + ` <span class="${deltaClass}">(${deltaText})</span>`
          + `</div>`
          + `</div>`
        );
      }).join('');

      return (
        `<div class="tuning-context">`
        + `<div class="tuning-context-head">`
        + `<strong>${escapeHtml(ctx.label)}</strong>`
        + `<span>preset=${escapeHtml(ctx.presetId)}</span>`
        + `<span>mode=${escapeHtml(ctx.status.mode)}</span>`
        + `<span>探索 ${ctx.paramExploreCount} / 採用 ${ctx.paramAdoptCount}</span>`
        + `<span>改善なし ${ctx.noImproveStreak}</span>`
        + `</div>`
        + (rows ? `<div class="tuning-params">${rows}</div>` : '')
        + `</div>`
      );
    }).join('')
    : '<p class="tuning-empty">学習コンテキストがまだありません。</p>';

  bodyEl.innerHTML = (
    `<div class="tuning-meta">${metaHtml}</div>`
    + `<p class="hint">${escapeHtml(method.note)}</p>`
    + `<h3>いま試していること</h3>`
    + lastHtml
    + `<h3>直近の数値探索</h3>`
    + trialsHtml
    + `<h3>探索対象（計${method.tunableCount}・遠距離＋爆発のみ）</h3>`
    + byClassHtml
    + `<p class="tuning-empty">近接・敏捷は数値探索なし（原則＋固定）。</p>`
    + `<h3>文脈別の現行値（探索対象クラスのみ）</h3>`
    + `<div class="tuning-contexts">${contextsHtml}</div>`
  );
}

async function refreshStats() {
  const stats = await fetch('/api/gym/stats').then((response) => response.json());
  renderStats(stats);
}

async function resetGymSession() {
  if (learning) {
    learning = false;
    setLearnStatus(false, '停止中');
    stopPlayback();
  }
  const ok = window.confirm(
    '画面の統計と箱庭学習データ（data/sim-combat-state.json）を空にします。\n'
    + 'ロジック改修の前後が混ざらないようにするための操作です。続行しますか？'
  );
  if (!ok) return;
  const response = await fetch('/api/gym/reset', { method: 'POST' });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  renderStats(payload.stats);
  $('clusters').innerHTML = '';
  $('worst-list').innerHTML = '';
  $('review-status').textContent = `リセット完了（消去エピソード ${payload.clearedEpisodes}）。新しい学習を開始できます。`;
  setLearnStatus(false, '停止中（統計リセット済み）');
}

function setLearnStatus(active, text) {
  learning = active;
  const button = $('learn-toggle');
  const status = $('learn-status');
  button.textContent = active ? '学習を停止' : '学習を開始（放置OK）';
  button.classList.toggle('running', active);
  status.textContent = text;
  status.className = `learn-status ${active ? 'running' : 'stopped'}`;
}

async function toggleLearning() {
  if (learning) {
    learning = false;
    setLearnStatus(false, '停止中');
    stopPlayback();
    return;
  }
  setLearnStatus(true, '学習中… 新しいステージを連続生成します');
  learnLoopPromise = runLearningLoop().finally(() => {
    learnLoopPromise = null;
    if (learning) setLearnStatus(false, '停止中');
  });
}

async function runLearningLoop() {
  while (learning) {
    setLearnStatus(true, `学習中… 次シード ${nextSeed}`);
    const response = await fetch('/api/gym/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 1, startSeed: nextSeed })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    renderStats(payload.stats);
    const result = payload.results[0];
    nextSeed += 1;

    if (!learning) break;
    if (result) {
      const reasonLabel = ({
        explore: '探索',
        coverage: '未試行埋め',
        weakness: '苦手優先',
        rematch: '失敗再戦'
      })[result.curriculumReason] || '通常';
      setLearnStatus(
        true,
        `観戦中 seed=${result.seed} (${result.arenaKind} / ${reasonLabel})`
      );
      await loadSeed(result.seed, {
        autoPlay: false,
        fromLearning: true,
        kind: result.arenaKind
      });
      await playUntilEnded();
      // 死亡／勝利後は動きを止め、結果を見せてから次へ
      const outcome = state?.outcome || (result.died ? 'lose' : result.win ? 'win' : 'ongoing');
      const label = outcome === 'lose' ? '死亡で終了' : outcome === 'win' ? '勝利で終了' : '終了';
      setLearnStatus(true, `${label} — 次のステージまで待機中…`);
      renderHud({ botDead: outcome === 'lose' });
      await sleep(2500);
    }
  }
  setLearnStatus(false, '停止中');
}

async function playUntilEnded(maxTicks = 160) {
  stopPlayback();
  watchMode = true;
  for (let index = 0; index < maxTicks; index += 1) {
    if (!learning && !watchMode) break;
    if (!state || state.ended || state.botDead || state.bot?.hp <= 0) break;
    const result = await tick();
    if (result.ended) break;
    await sleep(380);
  }
  // 最終フレームを死亡／勝利表示で固定
  if (state && (state.botDead || state.ended)) {
    render({ botDead: Boolean(state.botDead || state.bot?.hp <= 0) });
  }
  watchMode = false;
}

function stopPlayback() {
  playing = false;
  if ($('play')) $('play').textContent = '自動進行';
  clearInterval(timer);
  timer = null;
}

async function runGymOnce() {
  const count = Number($('gym-count').value) || 5;
  const body = { count, startSeed: nextSeed };
  $('gym-run').disabled = true;
  try {
    const response = await fetch('/api/gym/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    renderStats(payload.stats);
    nextSeed += count;
    const last = payload.results[payload.results.length - 1];
    if (last) {
      $('replay-seed').value = String(last.seed);
      await loadSeed(last.seed, { autoPlay: true });
    }
  } finally {
    $('gym-run').disabled = false;
  }
}

async function loadSeed(seed, options = {}) {
  stopPlayback();
  const response = await fetch('/api/gym/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed, kind: options.kind || undefined })
  });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  state = payload.state;
  state.enemyAi = { enabled: true, speedScale: state.enemyAi?.speedScale || 1 };
  decision = null;
  prevSnapshot = null;
  eventLog.length = 0;
  syncEnemyAiInputs();
  render();
  if (options.autoPlay && !options.fromLearning) {
    watchMode = true;
    playUntilEnded().finally(() => { watchMode = false; });
  }
}

async function exportReview() {
  const response = await fetch('/api/review/export', { method: 'POST' });
  if (!response.ok) throw new Error(await response.text());
  const payload = await response.json();
  try {
    await navigator.clipboard.writeText(payload.markdown);
    $('review-status').textContent = `書き出し完了: ${payload.path}（クリップボード済み）。Cursor に貼ってください。`;
  } catch {
    $('review-status').textContent = `書き出し完了: ${payload.path}`;
  }
}

function applyEnemyAiInputs() {
  if (!state || !$('enemy-ai')) return;
  state.enemyAi = {
    enabled: $('enemy-ai').checked,
    speedScale: Number($('enemy-speed').value)
  };
}

function syncEnemyAiInputs() {
  if (!state || !$('enemy-ai')) return;
  const config = { enabled: true, speedScale: 1, ...(state.enemyAi || {}) };
  state.enemyAi = config;
  $('enemy-ai').checked = config.enabled;
  $('enemy-speed').value = String(config.speedScale);
  $('enemy-speed-value').textContent = `${Number(config.speedScale).toFixed(2)}×`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

scene.canvas.addEventListener('click', (event) => {
  if (!state || state.botDead || learning) return;
  const point = scene.pickGround(event.clientX, event.clientY);
  if (!point) return;
  const selected = $('entity')?.value;
  if (!selected) return;
  const target = selected === 'bot' ? state.bot
    : selected === 'owner' ? state.owner
      : state.enemies.find((item) => item.id === Number(selected.split(':')[1]));
  if (!target) return;
  Object.assign(target, { x: point.x, z: point.z });
  render();
});

$('learn-toggle').addEventListener('click', () => toggleLearning().catch(alert));
$('scenario').addEventListener('change', () => loadScenario($('scenario').value));
$('reset').addEventListener('click', () => loadScenario($('scenario').value));
$('tick').addEventListener('click', () => tick().catch(alert));
$('enemy-ai').addEventListener('change', () => { applyEnemyAiInputs(); render(); });
$('enemy-speed').addEventListener('input', () => { applyEnemyAiInputs(); syncEnemyAiInputs(); render(); });
$('play').addEventListener('click', () => {
  if (learning) return;
  playing = !playing;
  $('play').textContent = playing ? '一時停止' : '自動進行';
  clearInterval(timer);
  if (playing) {
    timer = setInterval(() => {
      tick().catch(() => {}).then((result) => {
        if (result?.ended) stopPlayback();
      });
    }, 420);
  }
});
$('add-enemy').addEventListener('click', () => {
  if (!state || state.botDead) return;
  state.enemies.push({
    id: state.nextId++,
    kind: $('enemy-kind').value,
    x: 2,
    y: 1,
    z: 2,
    hp: 20
  });
  render();
});
$('remove').addEventListener('click', () => {
  const selected = $('entity').value;
  if (!selected.startsWith('enemy:')) return;
  const id = Number(selected.split(':')[1]);
  state.enemies = state.enemies.filter((item) => item.id !== id);
  render();
});
$('gym-run').addEventListener('click', () => runGymOnce().catch(alert));
$('gym-refresh').addEventListener('click', () => refreshStats().catch(alert));
$('gym-reset').addEventListener('click', () => resetGymSession().catch(alert));
$('review-export').addEventListener('click', () => exportReview().catch(alert));
$('replay-load').addEventListener('click', () => {
  watchMode = false;
  loadSeed(Number($('replay-seed').value), { autoPlay: true }).catch(alert);
});
$('worst-load').addEventListener('click', () => {
  const seed = Number($('worst-list').value);
  const selected = $('worst-list').selectedOptions?.[0];
  const kind = selected?.dataset?.kind || undefined;
  $('replay-seed').value = String(seed);
  watchMode = false;
  loadSeed(seed, { autoPlay: true, kind }).catch(alert);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function scenarioLabel(value) {
  return ({
    'single-ranged': '単体遠距離',
    'multi-positioning': '複数脅威の位置取り',
    recovery: '復旧',
    'dynamic-melee-pincer': '動的: 近接挟撃',
    'dynamic-ranged-pressure': '動的: 遠距離圧',
    'dynamic-mixed': '動的: 混成',
    'attack-fan-cover': '攻撃扇: 肉壁カバー',
    'elevated-ranged': '3D: 高台遠距離',
    'wall-los-block': '3D: 壁越しLOS'
  })[value] || value;
}

function ownerLabel(value) {
  return ({ follow: '追従', combat: '戦闘', recovery: '復旧', survival: '緊急生存' })[value] || value || '—';
}
function intentLabel(value) {
  return ({ attack: '攻撃', guard: '防御', dodge: '回避', hold: '維持' })[value] || value;
}
function movementLabel(value) {
  return ({
    stay: '維持', positioning: '位置取り', dodge: '回避', advance: '前進',
    attack: '攻撃', recovery: '復旧', survival: '緊急生存', dead: '死亡'
  })[value] || value;
}
function outcomeLabel(value) {
  return ({ ongoing: '進行中', win: '勝利', lose: '敗北', draw: '引分' })[value] || value || '—';
}

boot().catch((error) => {
  document.body.textContent = error.message;
});
