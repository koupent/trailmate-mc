/**
 * Draw one state's behavior tree as a nested list.
 *
 * The tree comes from `fsm.trees[state]` in `/api/status`, built by the bot
 * from its live nodes. Results are only meaningful for the active state;
 * other states show their structure without results.
 */

const KIND_TEXT = {
  selector: ['どれか', '上から試し、最初に成立したものを実行'],
  sequence: ['順番', '上から順に、すべて成立したら成立'],
  condition: ['条件', '状況の確認'],
  action: ['動作', '実際に行うこと'],
  subtree: ['中身', '別のツリーに任せる']
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusMark(node) {
  if (node.status === 'success') return '<span class="bt-mark" title="今回成立">✓</span>';
  if (node.status === 'failure') return '<span class="bt-mark" title="今回不成立">×</span>';
  return '';
}

/**
 * @param {{ label: string, kind: string, status: string|null, mode?: string, children?: object[] }} node
 * @param {{ live: boolean, mode?: string|null }} opts
 *   `live`: show this tick's results. `mode`: the player-selected mode.
 */
function renderNode(node, opts) {
  const classes = ['bt-node', `bt-${node.kind}`];
  if (opts.live) classes.push(`is-${node.status || 'skipped'}`);
  if (node.mode) {
    classes.push('is-mode-branch');
    if (node.mode === opts.mode) classes.push('is-current-mode');
  }
  const [kindText, kindHint] = KIND_TEXT[node.kind] || [node.kind, ''];
  const children = node.children?.length
    ? `<ul>${node.children.map((child) => renderNode(child, opts)).join('')}</ul>`
    : '';
  return `<li class="${classes.join(' ')}"><div class="bt-row"><span class="bt-kind" title="${escapeHtml(
    kindHint
  )}">${escapeHtml(kindText)}</span><span class="bt-label">${escapeHtml(node.label)}</span>${
    opts.live ? statusMark(node) : ''
  }</div>${children}</li>`;
}

/**
 * @param {object|null|undefined} tree
 * @param {{ live: boolean, mode?: string|null }} opts
 */
export function renderBtTree(tree, opts) {
  if (!tree) return '<div class="empty">この状態にはツリーがありません</div>';
  return `<ul class="bt-tree${opts.live ? ' is-live' : ''}">${renderNode(tree, opts)}</ul>`;
}
