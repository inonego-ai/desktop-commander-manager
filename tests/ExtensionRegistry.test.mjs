import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionRegistry } from '../src/extensions/registry.mjs';
import { extensions } from '../src/extensions/index.mjs';

test('extension host starts empty and supports explicit local tools', async () => {
    assert.deepEqual(extensions.tools, []);
    const registry = new ExtensionRegistry();
    let received;
    registry.register({
        tools: [{ name: 'example_extension', inputSchema: { type: 'object' } }],
        async intercept(message, respond) {
            if (message.method !== 'tools/call' || message.params?.name !== 'example_extension') return false;
            received = message.params.arguments;
            await respond(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));
            return true;
        }
    });
    assert.deepEqual(registry.tools.map(t => t.name), ['example_extension']);
    assert.equal(await registry.intercept({ method: 'tools/list' }, () => {}), false);
    let result;
    assert.equal(await registry.intercept({
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'example_extension', arguments: { demo: 1 } }
    }, serialized => { result = JSON.parse(serialized); }), true);
    assert.deepEqual(received, { demo: 1 });
    assert.equal(result.id, 7);
    assert.throws(() => registry.register({ tools: [{ name: 'example_extension' }], intercept: async () => false }), /unique/);
    assert.throws(() => registry.register({ tools: [], intercept: null }), /intercept/);
});
