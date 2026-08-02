/**
 * 小さな階層型所有権方針。各Capabilityは固有の評価を維持し、ここでは
 * 移動・視線・行動を発行できるコンテキストだけを決める。
 *
 * @param {{
 *   recoveryActive?: boolean,
 *   recoveryEmergency?: boolean,
 *   combatActive?: boolean,
 *   transferActive?: boolean,
 *   upperMode?: 'follow' | 'wait'
 * }} input
 * @returns {'survival' | 'recovery' | 'combat' | 'transfer' | 'follow' | 'wait'}
 */
export function selectControlOwner(input = {}) {
    if (input.recoveryActive && input.recoveryEmergency) return 'survival';
    if (input.recoveryActive) return 'recovery';
    if (input.combatActive) return 'combat';
    if (input.transferActive) return 'transfer';
    return input.upperMode === 'wait' ? 'wait' : 'follow';
}

/** 現在の CompanionContext 状態から所有権方針を解決する。 */
export function currentControlOwner(ctx, upperMode = 'follow', now = Date.now()) {
    const fsmId = ctx?.agent?.companion?.manager?.getActiveFsmId?.();
    if (fsmId === 'combat') {
        return 'combat';
    }

    const reflexes = ctx?.agent?.reflexes;
    const combatActive = Boolean(
        reflexes?.isControllingMovement
        || reflexes?.wantsCombat
        || ctx?.bot?.pvp?.target
    );
    const recoveryActive = Boolean(ctx?.deathRecovery?.active);
    if (fsmId === 'duty' && recoveryActive) {
        return selectControlOwner({
            recoveryActive: true,
            recoveryEmergency: now < (ctx.deathRecovery.emergencyUntil || 0),
            combatActive: false,
            transferActive: Boolean(ctx?.itemTransfer?.active),
            upperMode
        });
    }

    return selectControlOwner({
        recoveryActive,
        recoveryEmergency: recoveryActive
            && now < (ctx.deathRecovery.emergencyUntil || 0),
        combatActive,
        transferActive: Boolean(ctx?.itemTransfer?.active),
        upperMode
    });
}
