const MAX_MONTHLY_USD = 200;
const REFRESH_MS = 5 * 60 * 1000;

export class ClaudeChatBudget {
    constructor() {
        const localBudget = Number(process.env.CLAUDE_MONTHLY_BUDGET_USD?.trim() || MAX_MONTHLY_USD);
        this.localUsd = Number.isFinite(localBudget) ? Math.min(MAX_MONTHLY_USD, Math.max(0, localBudget)) : 0;
        this.adminKey = process.env.ANTHROPIC_ADMIN_API_KEY?.trim();
        this.workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
        this.usd = this.localUsd;
        this.limitKnown = !this.adminKey && !this.workspaceId;
        this.nextRefreshAt = 0;
    }

    get fraction() {
        return this.limitKnown ? this.speechFraction : 0;
    }

    get speechFraction() {
        return this.usd / MAX_MONTHLY_USD;
    }

    refresh(now) {
        if (!this.adminKey || !this.workspaceId || now < this.nextRefreshAt) return;
        this.nextRefreshAt = now + REFRESH_MS;
        void this._readConsoleLimit().then((usd) => {
            this.usd = Math.min(usd, this.localUsd);
            this.limitKnown = true;
        }).catch(() => {
            this.limitKnown = false;
            console.warn('[companion] Claude Console spend limit unavailable; Claude generation paused');
        });
    }

    async _readConsoleLimit() {
        const url = new URL('https://api.anthropic.com/v1/organizations/spend_limits');
        url.searchParams.set('workspace_id', this.workspaceId);
        const response = await fetch(url, {
            redirect: 'error',
            headers: {
                'x-api-key': this.adminKey,
                'anthropic-version': '2026-10-21',
                'anthropic-beta': 'spend-limit-reads-2026-09-26'
            },
            signal: AbortSignal.timeout(6000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { data } = await response.json();
        const limit = data.find((row) => row.scope?.type === 'workspace'
            && row.scope.workspace_id === this.workspaceId && row.period === 'monthly'
            && row.currency === 'USD' && row.is_enabled);
        const cents = Number(limit?.amount ?? NaN);
        if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Missing monthly USD limit');
        return cents / 100;
    }
}
