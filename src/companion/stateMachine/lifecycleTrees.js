import { action, sequence } from '../behaviorTree/bt.js';
import { beginDeathReturnAfterSpawn, captureDeathState } from '../deathRecovery.js';
import { applyJumpHitboxFix } from '../hitboxFix.js';

export function createLifecycleTrees() {
    const fixHitbox = () => action('段差移動の互換性を整える', async (ctx) => {
        await applyJumpHitboxFix(ctx.bot);
        return true;
    });
    return {
        spawn: sequence('スポーンの準備', [
            fixHitbox(),
            action('最初の装備を整える', async (ctx) => {
                await ctx.agent.companion.autoEquip.equipBest();
                return true;
            })
        ]),
        ready: action('ゲーム内で準備完了を知らせる', ({ agent }) => {
            void agent.companion?.dialogue?.speakNotice('boot_ready', { name: agent.name })
                .catch(() => console.warn('[companion] ready notice failed'));
            return true;
        }),
        death: action('死亡地点を記録して操作を止める', (ctx) => {
            captureDeathState(ctx);
            const pos = ctx.deathRecovery.deathPos;
            console.log('[companion] death recorded', pos
                ? `at ${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
                : '(no position)');
            return true;
        }),
        respawn: sequence('リスポーンの準備', [
            action('死亡地点に戻る準備をして知らせる', (ctx) => {
                if (ctx.bot.entity?.position) ctx.stuck?.reset?.(ctx.bot.entity.position);
                if (beginDeathReturnAfterSpawn(ctx)) {
                    console.log('[companion] death return started after respawn');
                    const { x, y, z } = ctx.deathRecovery.deathPos;
                    void ctx.agent.companion?.dialogue?.speakNotice('death_return_start', {
                        x: Math.floor(x), y: Math.floor(y), z: Math.floor(z)
                    }).catch(() => console.warn('[companion] death return notice failed'));
                }
                return true;
            }),
            fixHitbox()
        ])
    };
}
