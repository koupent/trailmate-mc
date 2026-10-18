/**
 * Draw the companion state machine as SVG markup.
 *
 * Nothing here knows which states exist: nodes and arrows come from the
 * `fsm` block of `/api/status`, which the bot reads from its live machine.
 * A state added or removed there shows up here without touching this file —
 * only its Japanese label falls back to the raw id until one is given.
 */

const WIDTH = 640;
const HEIGHT = 340;
const NODE_W = 128;
const NODE_H = 48;
/** How far an arrow bows sideways, so A→B and B→A do not overlap. */
const BEND = 26;
/** A transition this recent is drawn as "just happened". */
const RECENT_MS = 8000;

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** States on an ellipse, first one at the top, clockwise. */
export function layoutNodes(states) {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const rx = WIDTH / 2 - NODE_W / 2 - 12;
  const ry = HEIGHT / 2 - NODE_H / 2 - 12;
  const n = Math.max(states.length, 1);
  return new Map(
    states.map((id, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [id, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }];
    })
  );
}

/** Where a ray from the node centre towards (tx, ty) leaves its box. */
function boxExit(center, tx, ty, pad = 0) {
  const dx = tx - center.x;
  const dy = ty - center.y;
  const hw = NODE_W / 2 + pad;
  const hh = NODE_H / 2 + pad;
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy)
  );
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function edgePath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const control = {
    x: (from.x + to.x) / 2 + (-dy / len) * BEND,
    y: (from.y + to.y) / 2 + (dx / len) * BEND
  };
  const start = boxExit(from, control.x, control.y);
  const end = boxExit(to, control.x, control.y, 4);
  const r = (v) => Math.round(v * 10) / 10;
  return `M${r(start.x)},${r(start.y)} Q${r(control.x)},${r(control.y)} ${r(end.x)},${r(end.y)}`;
}

/**
 * @param {{
 *   active: string,
 *   states: string[],
 *   transitions: Array<{ name: string, from: string, to: string }>,
 *   history?: Array<{ from: string, to: string, at: number }>
 * }} fsm
 * @param {{ label: (id: string) => string, note: (id: string) => string, now?: number, selected?: string|null }} text
 *   `selected` is the state whose behavior tree is shown under the diagram.
 */
export function renderFsmSvg(fsm, text) {
  const states = Array.isArray(fsm?.states) ? fsm.states : [];
  const positions = layoutNodes(states);
  const now = text.now ?? Date.now();
  const last = (fsm?.history || []).at(-1);
  const recent = last && now - last.at < RECENT_MS ? last : null;

  // Several guarded transitions can join the same pair; one arrow each.
  const pairs = new Map();
  for (const t of fsm?.transitions || []) {
    if (!positions.has(t.from) || !positions.has(t.to)) continue;
    const key = `${t.from}>${t.to}`;
    if (!pairs.has(key)) pairs.set(key, { from: t.from, to: t.to, names: [] });
    pairs.get(key).names.push(t.name);
  }

  const edges = [...pairs.values()]
    .map((pair) => {
      const classes = ['fsm-edge'];
      if (pair.from === fsm.active) classes.push('is-out');
      if (recent && recent.from === pair.from && recent.to === pair.to) classes.push('is-recent');
      return { ...pair, classes };
    })
    // Highlighted arrows last so they sit on top of the faint ones.
    .sort((a, b) => a.classes.length - b.classes.length)
    .map((edge) => {
      const marker = edge.classes.length > 1 ? 'fsm-arrow-on' : 'fsm-arrow';
      return `<path class="${edge.classes.join(' ')}" d="${edgePath(
        positions.get(edge.from),
        positions.get(edge.to)
      )}" marker-end="url(#${marker})"><title>${escapeXml(
        `${text.label(edge.from)} → ${text.label(edge.to)}\n${edge.names.join('\n')}`
      )}</title></path>`;
    })
    .join('');

  const nodes = states
    .map((id) => {
      const p = positions.get(id);
      const classes = ['fsm-node'];
      if (id === fsm.active) classes.push('is-active');
      if (id === text.selected) classes.push('is-selected');
      return `<g class="${classes.join(' ')}" data-state="${escapeXml(id)}" tabindex="0" role="button" transform="translate(${Math.round(p.x - NODE_W / 2)},${Math.round(
        p.y - NODE_H / 2
      )})"><title>${escapeXml(id)}</title><rect width="${NODE_W}" height="${NODE_H}" rx="8" /><text class="fsm-label" x="${
        NODE_W / 2
      }" y="21">${escapeXml(text.label(id))}</text><text class="fsm-note" x="${NODE_W / 2}" y="37">${escapeXml(
        text.note(id)
      )}</text>${fsm?.trees?.[id] ? `<text class="fsm-bt" x="${NODE_W - 6}" y="11">BT</text>` : ''}</g>`;
    })
    .join('');

  return `<svg class="fsm-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="状態遷移図">
<defs>
<marker id="fsm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fsm-arrow-head" /></marker>
<marker id="fsm-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fsm-arrow-head is-on" /></marker>
</defs>${edges}${nodes}</svg>`;
}
