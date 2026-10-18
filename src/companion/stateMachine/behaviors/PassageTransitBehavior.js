import { AsyncTickBehavior } from './AsyncTickBehavior.js';
import {
    action,
    condition,
    runTree,
    selector,
    sequence
} from '../../behaviorTree/bt.js';

/**
 * Runs the one passage job the tracker selected: walk into reach, activate the
 * block, report the result. Nothing else touches a door, so a blocked passage
 * can no longer strand a normal behavior in front of a gate.
 *
 * Movement is stopped in exactly one place — immediately before an activation,
 * so the click cannot race the bot's own walk. Every other branch leaves the
 * pathfinder alone; stopping on a tick that is only waiting for the server was
 * costing a goal reset and a path reset per tick, for nothing.
 */
export class PassageTransitBehavior extends AsyncTickBehavior {
    /** @param {object} targets */
    constructor(targets) {
        super('passage_transit');
        this.targets = targets;
        /** @type {string|null} Job this behavior has issued a move for. */
        this._movedFor = null;
        this.tree = this._buildTree();
    }

    onStateEntered() {
        super.onStateEntered();
        this.targets.activeId = 'passage_transit';
        this._movedFor = null;
        this.targets.ctx.doors?.resumePassage?.();
    }

    onStateExited() {
        // Combat and hazard escape pause the deadline instead of consuming it.
        this.targets.ctx.doors?.suspendPassage?.();
        this._movedFor = null;
        super.onStateExited();
    }

    async runTick() {
        if (this.targets.paused) return;
        await runTree(this.tree, this.targets.ctx);
    }

    _buildTree() {
        /** @type {{ action?: string, target?: any, range?: number, reason?: string }} */
        let step = {};
        /** @type {string|null} Job as it stood when this tick started. */
        let job = null;
        const stepIs = (name) => () => step.action === name;
        return sequence('扉・ゲートを通る', [
            condition('通過の手続きがある', (ctx) => Boolean(ctx.doors?.passagePending)),
            action('期限タイマーを再開', (ctx) => {
                ctx.doors.resumePassage?.();
                return true;
            }),
            selector('次の手順', [
                sequence('たどり着けない', [
                    // Only a move this behavior issued for this job can prove the
                    // passage is out of reach. A follow route that died before
                    // the job started says nothing about it, and used to fail the
                    // job on the entry tick.
                    condition('自分の移動が行き詰まった', (ctx) => {
                        job = jobToken(ctx.doors.passageJob);
                        if (this._movedFor && this._movedFor !== job) this._movedFor = null;
                        const movement = ctx.movement;
                        return this._movedFor === job
                            && Boolean(movement?.isBlocked || movement?.isUnreachable);
                    }),
                    action('通過を失敗にする', (ctx) => {
                        ctx.doors.failPassage?.('unreachable');
                        return true;
                    })
                ]),
                sequence('手順に従う', [
                    action('扉の状態から手順を決める', (ctx) => {
                        step = ctx.doors.advancePassage();
                        return true;
                    }),
                    selector('手順ごとの動作', [
                        sequence('近づく', [
                            condition('手が届かない', stepIs('move')),
                            action('扉へ歩く', (ctx) => {
                                this._movedFor = job;
                                ctx.movement?.goToward?.(step.target, step.range);
                                return true;
                            })
                        ]),
                        // Movement is stopped in exactly one place — immediately
                        // before an activation, so the click cannot race the
                        // bot's own walk.
                        sequence('開け閉めする', [
                            condition('操作できる位置にいる', stepIs('activate')),
                            action('止まって操作する', async (ctx) => {
                                ctx.movement?.stop?.();
                                await ctx.doors.activatePassage();
                                return true;
                            })
                        ]),
                        sequence('失敗', [
                            condition('続けられない', stepIs('fail')),
                            action('失敗を記録', (ctx) => {
                                ctx.doors.failPassage?.(step.reason || 'unknown');
                                return true;
                            })
                        ]),
                        sequence('完了', [
                            condition('通り抜けて閉め終えた', stepIs('done')),
                            action('完了を記録', (ctx) => {
                                ctx.doors.finishPassage?.();
                                return true;
                            })
                        ]),
                        // Waiting for the server to publish the requested block state.
                        action('サーバーの反映を待つ', () => true)
                    ])
                ])
            ])
        ]);
    }
}

/** @param {{ intent: string, key: string }|null} job */
function jobToken(job) {
    return job ? `${job.intent}:${job.key}` : null;
}
