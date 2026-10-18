import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    action,
    condition,
    describeTree,
    runTree,
    selector,
    sequence
} from '../src/companion/behaviorTree/bt.js';

describe('behavior tree', () => {
    it('runs the first branch that succeeds and leaves the rest unevaluated', async () => {
        const ran = [];
        const tree = selector('root', [
            sequence('a', [
                condition('a?', () => false),
                action('do a', () => ran.push('a'))
            ]),
            sequence('b', [
                condition('b?', () => true),
                action('do b', async () => {
                    ran.push('b');
                    return true;
                })
            ]),
            action('fallback', () => ran.push('fallback'))
        ]);

        assert.equal(await runTree(tree, {}), 'success');
        assert.deepEqual(ran, ['b']);
        const described = describeTree(tree);
        assert.deepEqual(described.children.map((node) => node.status), ['failure', 'success', null]);
        assert.equal(described.children[0].children[1].status, null, 'a sequence stops at its first failure');
    });

    it('clears the previous tick before evaluating again', async () => {
        let open = true;
        const tree = selector('root', [condition('open', () => open), action('wait', () => true)]);
        await runTree(tree, {});
        open = false;
        await runTree(tree, {});
        assert.deepEqual(describeTree(tree).children.map((node) => node.status), ['failure', 'success']);
        open = true;
        await runTree(tree, {});
        assert.deepEqual(describeTree(tree).children.map((node) => node.status), ['success', null]);
    });
});
