import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.dirname(here);
const proxyPath = path.join(sourceRoot, 'src', 'MCPStdioProxy.mjs');
const mockPath = path.join(here, 'fixtures', 'MockMCPServer.mjs');

function createClient(spoolDirectory) {
    const child = spawn(process.execPath, [proxyPath, '--', process.execPath, mockPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            CONTROL_PLANE_API_KEY: 'must-not-reach-backend',
            CONTROL_PLANE_TUNNEL_ID: 'must-not-reach-backend',
            MCP_PROXY_MAX_MESSAGE_BYTES: '65536',
            MCP_PROXY_RESTART_TIMEOUT_MS: '1000',
            MCP_PROXY_SPOOL_DIR: spoolDirectory
        }
    });
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const waiters = new Map();
    output.on('line', line => {
        const message = JSON.parse(line);
        const key = JSON.stringify(message.id);
        const waiter = waiters.get(key);
        if (waiter) {
            waiters.delete(key);
            waiter.resolve(message);
        }
    });
    function request(id, method, params = undefined) {
        return new Promise((resolve, reject) => {
            const key = JSON.stringify(id);
            const timer = setTimeout(() => {
                waiters.delete(key);
                reject(new Error(`request timed out: ${method}`));
            }, 5000);
            waiters.set(key, {
                resolve: value => { clearTimeout(timer); resolve(value); }
            });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
        });
    }
    function notify(method, params = {}) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
    return { child, request, notify };
}

async function initialize(client) {
    const response = await client.request('init', 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'proxy-test', version: '1.0.0' }
    });
    assert.equal(response.result.serverInfo.name, 'mock-mcp');
    client.notify('notifications/initialized');
}

test('proxy owns transport, UI, secret, and backend lifecycle boundaries', async () => {
    const spool = await mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-test-'));
    const client = createClient(spool);
    try {
        await initialize(client);

        const tools = await client.request('tools', 'tools/list');
        const names = tools.result.tools.map(tool => tool.name);
        assert(names.includes('mcp_transport_status'));
        assert.equal(tools.result.tools.find(tool => tool.name === 'mock')._meta, undefined);

        const resources = await client.request('resources', 'resources/list');
        assert.deepEqual(resources.result.resources.map(resource => resource.uri), ['file://mock/data']);
        const templates = await client.request('templates', 'resources/templates/list');
        assert.deepEqual(templates.result.resourceTemplates.map(template => template.uriTemplate), ['file://mock/{id}']);

        const disabledUi = await client.request('disabled-ui', 'resources/read', { uri: 'ui://desktop-commander/mock' });
        assert.equal(disabledUi.error.code, -32002);
        assert.equal(disabledUi.error.data.reason, 'ui_disabled');
        const nonUi = await client.request('non-ui', 'resources/read', { uri: 'file://mock/data' });
        assert.match(nonUi.result.contents[0].text, /mock widget/);

        const environment = await client.request('env', 'tools/call', { name: 'environment', arguments: {} });
        const environmentData = JSON.parse(environment.result.content[0].text);
        assert.deepEqual(environmentData, { hasApiKey: false, hasTunnelId: false });

        const oversized = await client.request('oversize', 'tools/call', { name: 'oversize', arguments: {} });
        assert.equal(oversized.error.code, -32001);
        assert(oversized.error.data.actualBytes > 65536);
        const spoolNames = await readdir(spool);
        assert(spoolNames.some(name => name.endsWith('.jsonrpc')));
        assert(spoolNames.some(name => name.endsWith('.meta.json')));

        const afterOversize = await client.request('after-oversize', 'tools/call', { name: 'mock', arguments: {} });
        assert.equal(afterOversize.result.content[0].text, 'ok');

        const terminated = await client.request('terminate', 'tools/call', { name: 'terminate', arguments: {} });
        assert.equal(terminated.error.code, -32003);

        const afterRestart = await client.request('after-restart', 'tools/list');
        assert(Array.isArray(afterRestart.result.tools));
    } finally {
        client.child.kill('SIGTERM');
        await rm(spool, { recursive: true, force: true });
    }
});
