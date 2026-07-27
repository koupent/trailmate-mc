/**
 * Base contract for companion behavior modes.
 * Register new modes with ModeManager so the dialogue layer can discover them.
 */
export class Mode {
    /**
     * @param {{ id: string, description: string }} options
     */
    constructor({ id, description }) {
        if (!id) throw new Error('Mode requires an id');
        this.id = id;
        this.description = description || id;
    }

    /**
     * @param {import('./CompanionContext.js').CompanionContext} _ctx
     */
    async onEnter(_ctx) {}

    /**
     * @param {import('./CompanionContext.js').CompanionContext} _ctx
     */
    async onExit(_ctx) {}

    /**
     * @param {import('./CompanionContext.js').CompanionContext} _ctx
     */
    async tick(_ctx) {}
}
