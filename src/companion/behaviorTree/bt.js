/**
 * Minimal behavior tree for the inside of each companion state.
 *
 * The state machine decides *which* state owns the bot (macro); the tree of
 * that state decides *what to do this tick* (micro).
 *
 * Trees are evaluated from the root on every tick, with no RUNNING memory:
 * the companion re-decides each tick, exactly as the code it replaced did.
 * Every node keeps the result of its last evaluation so the dashboard can
 * show which path the tick took. Nodes left `null` were not evaluated.
 */

export const SUCCESS = 'success';
export const FAILURE = 'failure';

class BtNode {
    /**
     * @param {'selector'|'sequence'|'condition'|'action'|'subtree'} kind
     * @param {string} label Japanese text shown on the dashboard.
     * @param {BtNode[]} children
     * @param {((ctx: any) => unknown)|null} fn
     * @param {{ mode?: string }} [opts]
     */
    constructor(kind, label, children, fn, opts = {}) {
        this.kind = kind;
        this.label = label;
        this.children = children;
        this.fn = fn;
        this.mode = opts.mode ?? null;
        /** @type {'success'|'failure'|null} */
        this.status = null;
    }

    async tick(ctx) {
        this.status = await this._evaluate(ctx);
        return this.status;
    }

    async _evaluate(ctx) {
        if (this.kind === 'selector') {
            for (const child of this.children) {
                if (await child.tick(ctx) === SUCCESS) return SUCCESS;
            }
            return FAILURE;
        }
        if (this.kind === 'sequence') {
            for (const child of this.children) {
                if (await child.tick(ctx) !== SUCCESS) return FAILURE;
            }
            return SUCCESS;
        }
        const result = await this.fn(ctx);
        return result === true || result === SUCCESS ? SUCCESS : FAILURE;
    }

    reset() {
        this.status = null;
        for (const child of this.children) child.reset();
    }
}

/** Try children in order; succeed on the first that succeeds. */
export function selector(label, children, opts) {
    return new BtNode('selector', label, children, null, opts);
}

/** Run children in order; fail on the first that fails. */
export function sequence(label, children, opts) {
    return new BtNode('sequence', label, children, null, opts);
}

/** A check without side effects worth showing: truthy → success. */
export function condition(label, fn) {
    return new BtNode('condition', label, [], fn);
}

/** Does something: `true` → success (it acted), anything else → failure. */
export function action(label, fn) {
    return new BtNode('action', label, [], fn);
}

/**
 * A tree owned by another object that runs it with its own per-tick setup
 * (e.g. FollowMode). `run` must evaluate `tree` and return its status.
 */
export function subtree(label, tree, run, opts) {
    return new BtNode('subtree', label, [tree], run, opts);
}

/** Evaluate a tree from the root, clearing the previous tick's results. */
export async function runTree(root, ctx) {
    root.reset();
    return root.tick(ctx);
}

/**
 * Plain data for the dashboard.
 * @param {BtNode} node
 * @returns {{ label: string, kind: string, status: string|null, mode?: string, children?: object[] }}
 */
export function describeTree(node) {
    const out = { label: node.label, kind: node.kind, status: node.status };
    if (node.mode) out.mode = node.mode;
    if (node.children.length) out.children = node.children.map(describeTree);
    return out;
}
