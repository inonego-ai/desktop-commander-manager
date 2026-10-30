import process from 'node:process';
import readline from 'node:readline';

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initializeParams;

input.on('line', line => {
    const message = JSON.parse(line);
    const { id, method, params } = message;

    if (method === 'initialize') {
        initializeParams = params;
        return send({
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: 'mock-mcp', version: '1.0.0' }
            }
        });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                tools: [{
                    name: 'mock',
                    description: 'Mock tool',
                    inputSchema: { type: 'object' },
                    _meta: {
                        'ui/resourceUri': 'ui://desktop-commander/mock',
                        'openai/outputTemplate': 'ui://desktop-commander/mock'
                    }
                }]
            }
        });
    }
    if (method === 'resources/list') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                resources: [
                    { uri: 'ui://desktop-commander/mock', name: 'Mock UI' },
                    { uri: 'file://mock/data', name: 'Mock data' }
                ]
            }
        });
    }
    if (method === 'resources/templates/list') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                resourceTemplates: [
                    { uriTemplate: 'ui://desktop-commander/{id}', name: 'Mock UI template' },
                    { uriTemplate: 'file://mock/{id}', name: 'Mock data template' }
                ]
            }
        });
    }
    if (method === 'resources/read') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                contents: [{
                    uri: params?.uri,
                    mimeType: 'text/html;profile=mcp-app',
                    text: '<!doctype html><html><body>mock widget</body></html>'
                }]
            }
        });
    }
    if (method !== 'tools/call') return;

    const name = params?.name;
    if (name === 'initialize_parameters') {
        return send({ jsonrpc: '2.0', id, result: { content: [{type:'text', text:JSON.stringify(initializeParams)}] } });
    }
    if (name === 'oversize') {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'x'.repeat(100000) }] } });
    }
    if (name === 'delayed') {
        return setTimeout(() => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'late result' }] } }), 1600);
    }
    if (name === 'block') {
        const until = Date.now() + 4000;
        while (Date.now() < until) {}
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'blocked result' }] } });
    }
    if (name === 'terminate') {
        return setImmediate(() => process.exit(17));
    }
    if (name === 'environment') {
        return send({
            jsonrpc: '2.0', id,
            result: {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        hasApiKey: Boolean(process.env.CONTROL_PLANE_API_KEY),
                        hasTunnelId: Boolean(process.env.CONTROL_PLANE_TUNNEL_ID)
                    })
                }]
            }
        });
    }

    return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'ok' }] }
    });
});
