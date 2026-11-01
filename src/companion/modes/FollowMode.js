import { Mode } from '../Mode.js';
import { lockOwner, notifyOwnerLocked } from '../ownerLock.js';
import { applyOwnerWorkRetreat } from '../ownerWorkMovement.js';
import { yieldsOutsideMachine } from '../ControlPriority.js';
import {
    FOLLOW_GOAL_RANGE,
    LAST_KNOWN_ARRIVE_RANGE
} from '../movement/followConstants.js';
import { resolveFollowPhase } from '../movement/followPhase.js';
import { ColumnClimber } from '../movement/climbColumn.js';
import { wouldPathPassNearPlayer } from '../movement/playerPathClearance.js';
import { tryOpportunisticCollect } from '../utils/opportunisticCollector.js';
import { action, condition, FAILURE, runTree, selector, sequence } from '../behaviorTree/bt.js';

/**
 * Lock onto the first player seen in FOV and keep following.
 *
 * The lock is kept until wait / a different owner is set via dialogue.
 * When the owner entity is unloaded, walk toward the last known position;
 * after arriving, wait in place until the entity reappears.
 *
 * While nearby players hold weapons or work tools, maintain a shared safe
 * position outside every equipped player's view and proximity.
 */
export class FollowMode extends Mode {
    constructor() {
        super({
            id: 'follow',
            description: 'Follow the owner closely and stay nearby'
        });
        /** @type {{ x: number, y: number, z: number }|null} */
        this._lastOwnerPos = null;
        /** @type {string|null} */
        this._lastOwnerDim = null;
        /** True after reaching last-known pos while owner is still missing. */
        this._waitingAtLastKnown = false;
        /** Manual ladder / vine climb; pathfinder never moves vertically here. */
        this._climb = new ColumnClimber();
        this._climbConsulted = false;
        this.tree = this._buildTree();
    }

    async onEnter() {
        this._waitingAtLastKnown = false;
    }

    async onExit(ctx) {
        this._climb.release(ctx);
        // FSM では combat/duty へ一瞬でも遷移するたびに呼ばれる。
        // ここで stop すると追従ゴールが毎回消え、棒立ち・duty 往復の原因になる。
        // 待機への切替は WaitMode.onEnter が stop する。
        if (!ctx.agent?.companion?.manager?.getActiveFsmId) {
            ctx.movement.stop();
        }
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @returns {Promise<'success'|'failure'>}
     */
    async tick(ctx) {
        this._climbConsulted = false;
        try {
            ctx.movement.tickHoldWatchdog();
            if (yieldsOutsideMachine(ctx, 'follow')) {
                const owner = ctx.ownerEntity;
                if (owner) this._rememberOwner(ctx, owner);
                return FAILURE;
            }
            return await runTree(this.tree, ctx);
        } finally {
            // Every branch that ends before the climb node — the owner
            // disappearing, a pickup, a boat — must let go of forward.
            if (!this._climbConsulted) this._climb.release(ctx);
        }
    }

    /**
     * What following means, in priority order. The first branch that acts
     * owns the tick; later ones are not evaluated.
     */
    _buildTree() {
        return selector('追従の手順', [
            sequence('オーナーを探す', [
                condition('オーナーが未決定', (ctx) => !ctx.ownerName),
                action('見えたプレイヤーをオーナーにする', async (ctx) => {
                    this._clearLastKnown();
                    await this._searchOwner(ctx);
                    return true;
                })
            ]),
            sequence('オーナーを見失った', [
                condition('オーナーが見えない', (ctx) => !ctx.ownerEntity),
                action('最後に見た場所へ向かう', (ctx) => {
                    this._seekLastKnown(ctx);
                    return true;
                })
            ]),
            sequence('オーナーのそばで動く', [
                action('オーナーの位置を記録', (ctx) => {
                    this._rememberOwner(ctx, ctx.ownerEntity);
                    this._waitingAtLastKnown = false;
                    return true;
                }),
                selector('いまやることを選ぶ', [
                    action('ボートに一緒に乗る', (ctx) => Boolean(
                        ctx.boatPassenger?.tryBoard?.(ctx.ownerEntity)
                    )),
                    // Skip follow only while a climb hold is still making progress.
                    condition('登り動作を続けている', (ctx) => Boolean(ctx.movement.isHeld)),
                    action('作業中のプレイヤーから離れる', (ctx) => Boolean(applyOwnerWorkRetreat(ctx))),
                    action('手が届くアイテムを拾う（歩かない）', (ctx) => Boolean(tryOpportunisticCollect(ctx))),
                    // A* plans no usable upward move over vines, so the wall is
                    // climbed by hand. The climb owns the walk into the column
                    // as well, and holds the tick for it.
                    action('はしご・つるを登る', (ctx) => {
                        this._climbConsulted = true;
                        return this._climb.tick(ctx);
                    }),
                    sequence('オーナーのすぐそば', [
                        condition('十分に近い', (ctx) => resolveFollowPhase(ctx, ctx.ownerEntity) === 'near'),
                        action('立ち止まる', (ctx) => {
                            ctx.movement.stop();
                            return true;
                        })
                    ]),
                    action('オーナーについて行く', (ctx) => {
                        const owner = ctx.ownerEntity;
                        ctx.movement.followEntity(owner, FOLLOW_GOAL_RANGE, {
                            endpointVisibilityTarget: owner,
                            followDistance: ctx.config?.follow_distance
                        });
                        return true;
                    })
                ])
            ])
        ]);
    }

    /**
     * Keep the last-known owner position current while another follow-mode
     * job (planting) owns the tick, so losing the owner then still leads back.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    trackOwner(ctx) {
        if (ctx.ownerEntity) this._rememberOwner(ctx, ctx.ownerEntity);
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     * @param {import('prismarine-entity').Entity} owner
     */
    _rememberOwner(ctx, owner) {
        const pos = owner.position;
        this._lastOwnerPos = { x: pos.x, y: pos.y, z: pos.z };
        this._lastOwnerDim = ctx.bot.game?.dimension ?? null;
    }

    _clearLastKnown() {
        this._lastOwnerPos = null;
        this._lastOwnerDim = null;
        this._waitingAtLastKnown = false;
    }

    /**
     * Walk to last-known owner position; wait in place after arrival.
     * @param {import('../CompanionContext.js').CompanionContext} ctx
     */
    _seekLastKnown(ctx) {
        const bot = ctx.bot;
        const dim = bot.game?.dimension ?? null;

        if (!this._lastOwnerPos || (this._lastOwnerDim != null && dim != null && this._lastOwnerDim !== dim)) {
            return;
        }

        if (this._waitingAtLastKnown) return;
        if (ctx.movement.isHeld) return;

        const target = this._lastOwnerPos;
        const dist = bot.entity.position.distanceTo(target);
        if (dist <= LAST_KNOWN_ARRIVE_RANGE) {
            this._waitingAtLastKnown = true;
            ctx.movement.stop();
            return;
        }

        const pushGuard = createPushGuard(ctx);
        ctx.movement.goToward(target, LAST_KNOWN_ARRIVE_RANGE, {
            rejectIf: pushGuard(target)
        });
    }

    async _searchOwner(ctx) {
        const candidate = ctx.worldState.visiblePlayers[0];
        if (candidate) {
            const changed = lockOwner(ctx, candidate.name);
            if (changed) {
                this._clearLastKnown();
                void notifyOwnerLocked(ctx, candidate.name).catch(() => {});
            }
            return;
        }
        if (Math.random() < 0.05) {
            await ctx.bot.look(ctx.bot.entity.yaw + (Math.random() - 0.5), 0, true);
        }
    }
}

/**
 * @param {import('../CompanionContext.js').CompanionContext} ctx
 * @returns {(target: { x: number, y: number, z: number }) => () => boolean}
 */
function createPushGuard(ctx) {
    return (target) => () => wouldPathPassNearPlayer(ctx, target);
}
