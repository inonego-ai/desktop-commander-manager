// Register trusted local MCP extensions without coupling the transport to a product feature.
export class ExtensionRegistry {
    #extensions = [];

    register(extension) {
        if (!extension || !Array.isArray(extension.tools) || typeof extension.intercept !== 'function') {
            throw new TypeError('An extension must expose tools and intercept(message, respond).');
        }
        const names = new Set(this.tools.map(tool => tool.name));
        for (const tool of extension.tools) {
            if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)) {
                throw new Error('An extension tool name must be unique and nonempty.');
            }
            names.add(tool.name);
        }
        this.#extensions.push(extension);
        return this;
    }

    get tools() {
        return this.#extensions.flatMap(extension => extension.tools);
    }

    async intercept(message, respond) {
        for (const extension of this.#extensions) {
            if (await extension.intercept(message, respond)) return true;
        }
        return false;
    }
}
