/**
 * Equip better armor/weapons when inventory changes (e.g. player gave gear).
 */
export class AutoEquip {
    /**
     * @param {import('../../agent.js').Agent} agent
     */
    constructor(agent) {
        this.agent = agent;
        this._lastRun = 0;
        this._pending = false;
        /** When true, skip auto-equip (e.g. while giving all items away). */
        this._paused = false;
    }

    start() {
        const bot = this.agent.bot;
        bot.on('playerCollect', (collector) => {
            if (collector === bot.entity) {
                this._schedule();
            }
        });
        // Also when items appear in inventory (toss from player nearby)
        bot.inventory.on('updateSlot', () => this._schedule());
    }

    pause() {
        this._paused = true;
        this._pending = false;
    }

    resume() {
        this._paused = false;
    }

    get isPaused() {
        return this._paused;
    }

    /**
     * @param {import('../CompanionContext.js').CompanionContext} [_ctx]
     */
    async maybeRun(_ctx) {
        if (this._paused) return;
        if (Date.now() - this._lastRun < 2000) return;
        if (!this._pending && Date.now() - this._lastRun < 15000) return;
        this._pending = false;
        this._lastRun = Date.now();
        await this.equipBest();
    }

    _schedule() {
        if (this._paused) return;
        this._pending = true;
    }

    async equipBest() {
        const bot = this.agent.bot;
        if (this._paused) return;
        try {
            if (bot.armorManager?.equipAll) {
                await bot.armorManager.equipAll();
            }
            await equipHighestAttack(bot);
        } catch (err) {
            console.warn('[companion] AutoEquip failed:', err.message || err);
        }
    }
}

const TIER_SCORE = {
    wood: 1,
    wooden: 1,
    leather: 1,
    gold: 2,
    golden: 2,
    stone: 3,
    chainmail: 3,
    iron: 4,
    diamond: 5,
    netherite: 6
};

function tierOf(name) {
    for (const [key, score] of Object.entries(TIER_SCORE)) {
        if (name.includes(key)) return score;
    }
    return 0;
}

async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(
        (item) => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe'))
    );
    if (weapons.length === 0) {
        weapons = bot.inventory.items().filter(
            (item) => item.name.includes('pickaxe') || item.name.includes('shovel')
        );
    }
    if (weapons.length === 0) return;

    weapons.sort((a, b) => {
        const dmg = (b.attackDamage || 0) - (a.attackDamage || 0);
        if (dmg !== 0) return dmg;
        return tierOf(b.name) - tierOf(a.name);
    });

    const best = weapons[0];
    const held = bot.heldItem;
    if (held && held.name === best.name) return;
    if (held && (held.attackDamage || 0) > (best.attackDamage || 0)) return;
    if (held && tierOf(held.name) > tierOf(best.name)) return;

    await bot.equip(best, 'hand');
    console.log(`[companion] equipped weapon: ${best.name}`);
}
