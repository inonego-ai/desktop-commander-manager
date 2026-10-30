import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions/index.mjs';

for (const name of ['CONTROL_PLANE_API_KEY', 'CONTROL_PLANE_TUNNEL_ID']) {
    delete process.env[name];
}

const MAX_MESSAGE_BYTES = envInt('MCP_PROXY_MAX_MESSAGE_BYTES', 8 * 1024 * 1024, 64 * 1024);
const RESTART_TIMEOUT_MS = envInt('MCP_PROXY_RESTART_TIMEOUT_MS', 10_000, 1_000);
const RESTART_TRIGGER = process.env.MCP_BACKEND_RESTART_TRIGGER;
const SPOOL_MAX_FILES = envInt('MCP_PROXY_SPOOL_MAX_FILES', 20, 1);
const SPOOL_MAX_BYTES = envInt('MCP_PROXY_SPOOL_MAX_BYTES', 512 * 1024 * 1024, 1024 * 1024);
const SPOOL_MAX_AGE_MS = envInt('MCP_PROXY_SPOOL_MAX_AGE_MS', 24 * 60 * 60 * 1000, 60 * 1000);
const READ_CHUNK_MAX_BYTES = 256 * 1024;
const OVERSIZE_ERROR_CODE = -32001;
const BACKEND_UNAVAILABLE_ERROR_CODE = -32003;
const FORWARD_UI_METADATA = /^(1|true|yes)$/i.test(process.env.MCP_PROXY_FORWARD_UI_METADATA ?? '');
const FORWARD_PROTOCOL_LOGGING = /^(1|true|yes)$/i.test(process.env.MCP_PROXY_FORWARD_PROTOCOL_LOGGING ?? '');
const UI_META_KEYS = new Set(['ui', 'ui/resourceUri', 'openai/outputTemplate', 'openai/widgetAccessible']);
const UI_RESOURCE_PREFIX = 'ui://desktop-commander/';
const UI_RESOURCE_UNAVAILABLE_ERROR_CODE = -32002;
const UI_CAPABILITY_EXTENSIONS = ['io.modelcontextprotocol/ui', 'openai/form'];

function envInt(name, fallback, minimum) {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function idKey(id) {
    return `${typeof id}:${JSON.stringify(id)}`;
}

function hasID(message) {
    return message && Object.prototype.hasOwnProperty.call(message, 'id');
}

function isRequest(message) {
    return message?.jsonrpc === '2.0' && typeof message.method === 'string' && hasID(message);
}

function isResponse(message) {
    return message?.jsonrpc === '2.0' && !('method' in message) && hasID(message);
}

function isProtocolLogNotification(message) {
    return message?.jsonrpc === '2.0' && message?.method === 'notifications/message';
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function initializeFingerprint(message) {
    const params = message?.params ?? {};
    return createHash('sha256').update(stableJson({
        protocolVersion: params.protocolVersion ?? null,
        capabilities: params.capabilities ?? {},
        clientInfo: params.clientInfo ?? null
    })).digest('hex');
}

function normalizeInitializeRequest(message) {
    if (FORWARD_UI_METADATA || message?.method !== 'initialize') return;
    const extensions = message.params?.capabilities?.extensions;
    if (!extensions || typeof extensions !== 'object') return;
    // A client UI extension cannot change a backend session whose UI surface
    // this proxy has disabled. Apply the same boundary before forwarding and
    // before comparing cached initialization; preserve all other capabilities.
    for (const name of UI_CAPABILITY_EXTENSIONS) delete extensions[name];
    if (Object.keys(extensions).length === 0) delete message.params.capabilities.extensions;
}

function serialize(message) {
    return JSON.stringify(message);
}

function byteLength(serialized) {
    return Buffer.byteLength(`${serialized}\n`, 'utf8');
}

function writeLine(stream, serialized) {
    return new Promise((resolve, reject) => {
        stream.write(`${serialized}\n`, 'utf8', error => error ? reject(error) : resolve());
    });
}

function toolResult(payload, isError = false) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

const separatorIndex = process.argv.indexOf('--');
if (separatorIndex < 0 || !process.argv[separatorIndex + 1]) {
    throw new Error('Usage: node MCPStdioProxy.mjs -- <command> [args...]');
}

const childCommand = process.argv[separatorIndex + 1];
const childArgs = process.argv.slice(separatorIndex + 2);
const proxyDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.dirname(proxyDirectory);
const spoolDirectory = process.env.MCP_PROXY_SPOOL_DIR || path.join(sourceRoot, '.tmp', 'spool');
const proxyInstanceID = randomUUID();

const PROXY_TOOLS = [
    {
        name: 'mcp_transport_status',
        description: '로컬 MCP 연결 상태, 실행 상태, 메시지 크기 제한 및 임시 보관 현황을 확인합니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { title: 'MCP 연결 상태', readOnlyHint: true }
    },
    {
        name: 'mcp_transport_list_spooled_responses',
        description: '크기 제한 때문에 임시 보관된 MCP 응답 목록을 확인합니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { title: '보관된 MCP 응답 목록', readOnlyHint: true }
    },
    {
        name: 'mcp_transport_read_spooled_response',
        description: '보관된 MCP 응답의 지정 범위를 읽습니다. 원본 바이트 복원에는 base64 인코딩을 사용하세요.',
        inputSchema: {
            type: 'object', properties: {
                responseId: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
                length: { type: 'integer', minimum: 1, maximum: READ_CHUNK_MAX_BYTES },
                encoding: { type: 'string', enum: ['utf8', 'base64'] }
            }, required: ['responseId'], additionalProperties: false
        }, annotations: { title: '보관된 MCP 응답 읽기', readOnlyHint: true }
    }
];

class MCPStdioProxy {
    constructor() {
        this.child = null;
        this.childGeneration = 0;
        this.childReady = false;
        this.shuttingDown = false;
        this.expectedExit = null;
        this.restartPromise = null;
        this.parentQueue = Promise.resolve();
        this.childOutputQueue = Promise.resolve();
        this.parentWriteQueue = Promise.resolve();
        this.childWriteQueue = Promise.resolve();
        this.pending = new Map();
        this.internal = new Map();
        this.internalSequence = 0;
        this.initializeTemplate = null;
        this.initializeResponseTemplate = null;
        this.initializeFingerprint = null;
        this.initializedNotification = null;
        this.initializeCompleted = false;
        this.sessionInitialized = false;
        this.cachedInitializeResponses = 0;
        this.suppressedInitializedNotifications = 0;
        this.suppressedProtocolLogNotifications = 0;
        this.strippedUiToolMetadata = 0;
        this.strippedUiMetadataFields = 0;
        this.filteredUiResources = 0;
        this.suppressedUiResourceReads = 0;
        this.rejectedUiToolCalls = 0;
        this.restartToken = '';
        this.restartTimer = null;
    }

    log(message) {
        process.stderr.write(`[mcp-stdio-proxy] ${message}\n`);
    }

    nextChildID(kind = 'request') {
        this.internalSequence += 1;
        return `__mcp_proxy_${proxyInstanceID}_${kind}_${this.internalSequence}`;
    }

    async start() {
        await fs.mkdir(spoolDirectory, { recursive: true });
        await this.cleanupSpool();
        await this.spawnChild(false);
        if (RESTART_TRIGGER) {
            this.restartToken = await fs.readFile(RESTART_TRIGGER, 'utf8').catch(() => '');
            this.restartTimer = setInterval(() => {
                void this.checkManagerRestart().catch(error => this.log('restart request failed: ' + error));
            }, 300);
            this.restartTimer.unref();
        }
        const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
        input.on('line', line => {
            this.parentQueue = this.parentQueue.then(() => this.handleParentLine(line)).catch(error => this.log(`parent message failed: ${error}`));
        });
        input.on('close', () => void this.shutdown());
        process.on('SIGINT', () => void this.shutdown());
        process.on('SIGTERM', () => void this.shutdown());
        this.log(`started child=${childCommand} maxBytes=${MAX_MESSAGE_BYTES}`);
    }

    async checkManagerRestart() {
        const token = await fs.readFile(RESTART_TRIGGER, 'utf8').catch(() => '');
        if (!token || token === this.restartToken || this.shuttingDown) return;
        this.restartToken = token;
        await this.restartChild('manager requested Desktop Commander restart');
    }

    async spawnChild(replaySession) {
        this.childGeneration += 1;
        const generation = this.childGeneration;
        const child = spawn(childCommand, childArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true });
        this.child = child;
        this.childReady = !replaySession;
        this.log(`backend started pid=${child.pid} generation=${generation}`);
        child.stderr.on('data', chunk => process.stderr.write(chunk));
        const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        output.on('line', line => {
            this.childOutputQueue = this.childOutputQueue.then(() => this.handleChildLine(line, generation)).catch(error => this.log(`child message failed: ${error}`));
        });
        child.once('exit', (code, signal) => void this.handleChildExit(child, code, signal));
        child.once('error', error => this.log(`child process error: ${error}`));
        if (replaySession) await this.replaySession();
    }

    async replaySession() {
        if (!this.sessionInitialized || !this.initializeTemplate) {
            this.childReady = true;
            return;
        }
        this.log('reinitializing restarted backend');
        const initializeResponse = await this.sendInternalRequest(this.initializeTemplate, RESTART_TIMEOUT_MS);
        if (initializeResponse?.error) throw new Error(`backend reinitialize failed: ${initializeResponse.error.message || 'unknown error'}`);
        const normalizedInitializeResponse = structuredClone(initializeResponse);
        this.normalizeInitializeResponse(normalizedInitializeResponse);
        this.initializeResponseTemplate = normalizedInitializeResponse;
        const initialized = this.initializedNotification || { jsonrpc: '2.0', method: 'notifications/initialized', params: {} };
        await this.writeChild(serialize(initialized));
        this.childReady = true;
        this.log('backend session restored');
    }

    async ensureChildReady() {
        if (this.restartPromise) await this.restartPromise;
        if (!this.child || this.child.exitCode !== null || !this.childReady) {
            await this.restartChild('backend unavailable or not ready');
        }
        if (this.restartPromise) await this.restartPromise;
        if (!this.childReady) throw new Error('MCP backend is not ready');
    }

    writeParent(serialized) {
        this.parentWriteQueue = this.parentWriteQueue.catch(() => {}).then(() => writeLine(process.stdout, serialized));
        return this.parentWriteQueue;
    }

    writeChild(serialized) {
        if (!this.child?.stdin || this.child.stdin.destroyed) return Promise.reject(new Error('MCP backend stdin is unavailable'));
        this.childWriteQueue = this.childWriteQueue.catch(() => {}).then(() => writeLine(this.child.stdin, serialized));
        return this.childWriteQueue;
    }

    async handleParentLine(line) {
        let message;
        try { message = JSON.parse(line); }
        catch { this.log('dropped invalid JSON from tunnel client'); return; }
        normalizeInitializeRequest(message);
        if (await this.handleDisabledUiRequest(message)) return;
        if (await extensions.intercept(message, serialized => this.writeParent(serialized))) return;
        if (await this.handleLocalToolCall(message)) return;

        if (message?.method === 'initialize' && isRequest(message) && this.initializeResponseTemplate) {
            const fingerprint = initializeFingerprint(message);
            if (fingerprint === this.initializeFingerprint) {
                const cachedResponse = structuredClone(this.initializeResponseTemplate);
                cachedResponse.id = message.id;
                this.cachedInitializeResponses += 1;
                await this.writeParent(serialize(cachedResponse));
                return;
            }
            if (this.pending.size > 0) {
                await this.writeParent(serialize(this.backendError(message.id, 'Initialize parameters changed while requests are still active.')));
                return;
            }
            const previous = this.initializeTemplate?.params ?? {};
            const current = message.params ?? {};
            const changed = ['protocolVersion', 'capabilities', 'clientInfo'].flatMap(key => {
                if (stableJson(previous[key]) === stableJson(current[key])) return [];
                if (key === 'protocolVersion') return [key];
                return [...new Set([...Object.keys(previous[key] ?? {}), ...Object.keys(current[key] ?? {})])]
                    .filter(field => stableJson(previous[key]?.[field]) !== stableJson(current[key]?.[field]))
                    .map(field => `${key}.${field}`);
            });
            this.log(`initialize changed fields=${changed.join(',')}`);
            await this.resetSessionForInitialize();
        }

        await this.ensureChildReady();
        if (message?.method === 'initialize' && isRequest(message)) {
            this.log(`initialize forwarded generation=${this.childGeneration}`);
            this.initializeTemplate = structuredClone(message);
            this.initializeFingerprint = initializeFingerprint(message);
        }
        if (message?.method === 'notifications/initialized') {
            this.initializedNotification = structuredClone(message);
            if (this.sessionInitialized) {
                this.suppressedInitializedNotifications += 1;
                return;
            }
            this.sessionInitialized = this.initializeCompleted;
        }
        if (!isRequest(message)) {
            await this.writeChild(serialize(message));
            return;
        }
        const entry = this.trackRequest(message.id, message.method, message.params);
        if (!entry) {
            await this.writeParent(serialize(this.backendError(message.id, 'Duplicate in-flight JSON-RPC id at the proxy boundary.')));
            return;
        }
        try { await this.writeChild(serialize(message)); }
        catch (error) {
            this.removePending(entry);
            await this.writeParent(serialize(this.backendError(message.id, `Failed to write request to backend: ${error.message}`)));
            void this.restartChild('backend write failed');
        }
    }

    async resetSessionForInitialize() {
        this.initializeTemplate = null;
        this.initializeResponseTemplate = null;
        this.initializeFingerprint = null;
        this.initializedNotification = null;
        this.initializeCompleted = false;
        this.sessionInitialized = false;
        await this.restartChild('initialize compatibility changed');
    }

    trackRequest(id, method, params) {
        const key = idKey(id);
        if (this.pending.has(key)) return null;
        const entry = { key, id, method, params, startedAt: Date.now() };
        this.pending.set(key, entry);
        return entry;
    }

    removePending(entry) {
        this.pending.delete(entry.key);
    }

    async sendInternalRequest(template, timeoutMs) {
        const message = structuredClone(template);
        const internalID = this.nextChildID('internal');
        message.id = internalID;
        const key = idKey(internalID);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.internal.delete(key);
                reject(new Error('internal MCP request timed out'));
            }, timeoutMs);
            timer.unref?.();
            this.internal.set(key, { resolve, reject, timer });
            this.writeChild(serialize(message)).catch(error => {
                clearTimeout(timer);
                this.internal.delete(key);
                reject(error);
            });
        });
    }

    async handleChildLine(line, generation) {
        if (generation !== this.childGeneration) return;
        let message;
        try { message = JSON.parse(line); }
        catch { this.log('dropped invalid JSON from MCP backend'); return; }
        if (isResponse(message)) return this.handleChildResponse(message);
        await this.forwardNonResponse(message);
    }

    async handleChildResponse(message) {
        const key = idKey(message.id);
        const internal = this.internal.get(key);
        if (internal) {
            clearTimeout(internal.timer);
            this.internal.delete(key);
            internal.resolve(message);
            return;
        }
        const entry = this.pending.get(key);
        if (entry) {
            this.removePending(entry);
            if (entry.method === 'initialize') {
                this.log(`initialize response generation=${this.childGeneration} success=${!message.error}`);
                this.initializeCompleted = !message.error;
                if (this.initializeCompleted) {
                    this.normalizeInitializeResponse(message);
                    this.initializeResponseTemplate = structuredClone(message);
                }
            }
            if (entry.method === 'tools/list') this.injectProxyTools(message);
            if (!FORWARD_UI_METADATA && entry.method === 'resources/list') this.filterUiResources(message);
            if (!FORWARD_UI_METADATA && entry.method === 'resources/templates/list') this.filterUiResourceTemplates(message);
            await this.forwardResponse(message, { method: entry.method, startedAt: entry.startedAt });
            return;
        }
        this.log(`dropped orphan backend response id=${JSON.stringify(message.id)}`);
    }

    normalizeInitializeResponse(message) {
        if (message?.error || !message?.result) return;
        const capabilities = message.result.capabilities ?? (message.result.capabilities = {});
        if (!FORWARD_PROTOCOL_LOGGING) delete capabilities.logging;
    }

    injectProxyTools(message) {
        const tools = message?.result?.tools;
        if (!Array.isArray(tools)) return;
        if (!FORWARD_UI_METADATA) {
            for (const tool of tools) this.stripUiMetadata(tool);
        }
        const names = new Set(tools.map(tool => tool?.name));
        for (const tool of [...PROXY_TOOLS, ...extensions.tools]) if (!names.has(tool.name)) tools.push(tool);
    }

    stripUiMetadata(tool) {
        if (!tool?._meta || typeof tool._meta !== 'object' || Array.isArray(tool._meta)) return;
        let removed = 0;
        for (const key of Object.keys(tool._meta)) {
            if (UI_META_KEYS.has(key) || key.startsWith('openai/widget')) {
                delete tool._meta[key];
                removed += 1;
            }
        }
        if (removed === 0) return;
        this.strippedUiToolMetadata += 1;
        this.strippedUiMetadataFields += removed;
        if (Object.keys(tool._meta).length === 0) delete tool._meta;
    }

    filterUiResources(message) {
        const resources = message?.result?.resources;
        if (!Array.isArray(resources)) return;
        const before = resources.length;
        message.result.resources = resources.filter(resource => !String(resource?.uri ?? '').startsWith(UI_RESOURCE_PREFIX));
        this.filteredUiResources += before - message.result.resources.length;
    }

    filterUiResourceTemplates(message) {
        const templates = message?.result?.resourceTemplates;
        if (!Array.isArray(templates)) return;
        const before = templates.length;
        message.result.resourceTemplates = templates.filter(template => !String(template?.uriTemplate ?? '').startsWith(UI_RESOURCE_PREFIX));
        this.filteredUiResources += before - message.result.resourceTemplates.length;
    }

    async handleDisabledUiRequest(message) {
        if (FORWARD_UI_METADATA || !isRequest(message)) return false;
        if (message.method === 'resources/read' && String(message.params?.uri ?? '').startsWith(UI_RESOURCE_PREFIX)) {
            this.suppressedUiResourceReads += 1;
            await this.writeParent(serialize({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                    code: UI_RESOURCE_UNAVAILABLE_ERROR_CODE,
                    message: 'Desktop Commander UI resources are not exposed by this transport.',
                    data: { uri: message.params.uri, reason: 'ui_disabled' }
                }
            }));
            return true;
        }
        if (message.method === 'tools/call' && message.params?.arguments?.origin === 'ui') {
            this.rejectedUiToolCalls += 1;
            await this.writeParent(serialize({
                jsonrpc: '2.0', id: message.id,
                error: { code: -32602, message: '이 연결은 위젯에서 직접 보내는 도구 요청을 지원하지 않습니다.' }
            }));
            return true;
        }
        return false;
    }

    async forwardResponse(message, context) {
        const serialized = serialize(message);
        const actualBytes = byteLength(serialized);
        if (actualBytes <= MAX_MESSAGE_BYTES) {
            await this.writeParent(serialized);
            return;
        }
        const spool = await this.spoolMessage(serialized, { reason: 'oversized_response', ...context });
        const replacement = {
            jsonrpc: '2.0', id: message.id,
            error: {
                code: OVERSIZE_ERROR_CODE,
                message: 'MCP response exceeded the transport-safe payload limit and was preserved locally.',
                data: {
                    actualBytes, maxBytes: MAX_MESSAGE_BYTES,
                    responseId: spool.id, sha256: spool.sha256,
                    recovery: 'Use mcp_transport_read_spooled_response to read the preserved response in bounded chunks.'
                }
            }
        };
        await this.writeParent(serialize(replacement));
        this.log(`preserved oversized response id=${spool.id} bytes=${actualBytes}`);
    }

    async forwardNonResponse(message) {
        if (isProtocolLogNotification(message) && !FORWARD_PROTOCOL_LOGGING) {
            this.suppressedProtocolLogNotifications += 1;
            const level = String(message?.params?.level ?? 'info').toLowerCase();
            if (['warning', 'error', 'critical', 'alert', 'emergency'].includes(level)) {
                let data;
                try { data = typeof message?.params?.data === 'string' ? message.params.data : JSON.stringify(message?.params?.data); }
                catch { data = String(message?.params?.data); }
                this.log(`backend ${level}: ${data}`);
            }
            return;
        }

        const serialized = serialize(message);
        if (byteLength(serialized) <= MAX_MESSAGE_BYTES) {
            await this.writeParent(serialized);
            return;
        }
        const spool = await this.spoolMessage(serialized, { reason: 'oversized_non_response', method: message?.method ?? null });
        if (isRequest(message)) {
            const error = { jsonrpc: '2.0', id: message.id, error: { code: OVERSIZE_ERROR_CODE, message: 'Outbound MCP request exceeded the transport-safe payload limit.', data: { responseId: spool.id } } };
            await this.writeChild(serialize(error));
        }
        this.log(`preserved oversized non-response id=${spool.id}`);
    }

    async spoolMessage(serialized, context) {
        const buffer = Buffer.from(`${serialized}\n`, 'utf8');
        const id = `${Date.now()}-${randomUUID()}`;
        const responsePath = path.join(spoolDirectory, `${id}.jsonrpc`);
        const metadataPath = path.join(spoolDirectory, `${id}.meta.json`);
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const metadata = {
            id, createdAt: new Date().toISOString(), bytes: buffer.byteLength, sha256,
            ...context
        };
        await fs.writeFile(responsePath, buffer);
        await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        await this.cleanupSpool();
        return metadata;
    }

    async listSpool() {
        const names = await fs.readdir(spoolDirectory).catch(() => []);
        const metadata = [];
        for (const name of names.filter(name => name.endsWith('.meta.json'))) {
            try {
                const value = JSON.parse(await fs.readFile(path.join(spoolDirectory, name), 'utf8'));
                metadata.push(value);
            } catch {}
        }
        return metadata.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    async cleanupSpool() {
        const names = await fs.readdir(spoolDirectory).catch(() => []);
        const responseIDs = new Set(names.filter(name => name.endsWith('.jsonrpc')).map(name => name.slice(0, -'.jsonrpc'.length)));
        const metadataIDs = new Set(names.filter(name => name.endsWith('.meta.json')).map(name => name.slice(0, -'.meta.json'.length)));
        for (const id of new Set([...responseIDs, ...metadataIDs])) {
            if (responseIDs.has(id) && metadataIDs.has(id)) continue;
            await fs.rm(path.join(spoolDirectory, `${id}.jsonrpc`), { force: true }).catch(() => {});
            await fs.rm(path.join(spoolDirectory, `${id}.meta.json`), { force: true }).catch(() => {});
        }

        const items = await this.listSpool();
        let totalBytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
        const cutoff = Date.now() - SPOOL_MAX_AGE_MS;
        for (let index = items.length - 1; index >= 0; index -= 1) {
            const item = items[index];
            const createdAt = Date.parse(item.createdAt);
            const expired = Number.isFinite(createdAt) && createdAt < cutoff;
            const overLimit = items.length > SPOOL_MAX_FILES || totalBytes > SPOOL_MAX_BYTES;
            if (!expired && !overLimit) break;
            await fs.rm(path.join(spoolDirectory, `${item.id}.jsonrpc`), { force: true }).catch(() => {});
            await fs.rm(path.join(spoolDirectory, `${item.id}.meta.json`), { force: true }).catch(() => {});
            totalBytes -= Number(item.bytes) || 0;
            items.splice(index, 1);
        }
    }

    async handleLocalToolCall(message) {
        if (message?.method !== 'tools/call' || !hasID(message)) return false;
        const name = message.params?.name;
        if (!PROXY_TOOLS.some(tool => tool.name === name)) return false;
        try {
            let payload;
            if (name === 'mcp_transport_status') payload = await this.statusPayload();
            else if (name === 'mcp_transport_list_spooled_responses') payload = { responses: await this.listSpool() };
            else payload = await this.readSpool(message.params?.arguments ?? {});
            await this.writeParent(serialize({ jsonrpc: '2.0', id: message.id, result: toolResult(payload) }));
        } catch (error) {
            await this.writeParent(serialize({
                jsonrpc: '2.0', id: message.id,
                result: toolResult({ error: error instanceof Error ? error.message : String(error) }, true)
            }));
        }
        return true;
    }

    async statusPayload() {
        const spool = await this.listSpool();
        return {
            backendPid: this.child?.pid ?? null, backendGeneration: this.childGeneration,
            backendReady: this.childReady, activeRequests: this.pending.size,
            sessionInitialized: this.sessionInitialized,
            initializeResponseCached: Boolean(this.initializeResponseTemplate),
            cachedInitializeResponses: this.cachedInitializeResponses,
            suppressedInitializedNotifications: this.suppressedInitializedNotifications,
            suppressedProtocolLogNotifications: this.suppressedProtocolLogNotifications,
            forwardUiMetadata: FORWARD_UI_METADATA,
            forwardProtocolLogging: FORWARD_PROTOCOL_LOGGING,
            strippedUiToolMetadata: this.strippedUiToolMetadata,
            strippedUiMetadataFields: this.strippedUiMetadataFields,
            filteredUiResources: this.filteredUiResources,
            suppressedUiResourceReads: this.suppressedUiResourceReads,
            rejectedUiToolCalls: this.rejectedUiToolCalls,
            maxMessageBytes: MAX_MESSAGE_BYTES, spoolMaxAgeMs: SPOOL_MAX_AGE_MS,
            preservedResponses: spool.length,
            preservedBytes: spool.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
        };
    }

    async readSpool(args) {
        const responseID = String(args.responseId ?? '');
        if (!/^[A-Za-z0-9._-]+$/.test(responseID)) throw new Error('Invalid responseId');
        const metadataPath = path.join(spoolDirectory, `${responseID}.meta.json`);
        const responsePath = path.join(spoolDirectory, `${responseID}.jsonrpc`);
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        if (metadata.id !== responseID) throw new Error('Spool metadata ID mismatch');
        const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
        const requested = Number.isSafeInteger(args.length) ? args.length : 64 * 1024;
        const length = Math.max(1, Math.min(requested, READ_CHUNK_MAX_BYTES));
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        const handle = await fs.open(responsePath, 'r');
        try {
            const remaining = Math.max(0, metadata.bytes - offset);
            const readLength = Math.min(length, remaining);
            const buffer = Buffer.alloc(readLength);
            const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
            const data = buffer.subarray(0, bytesRead).toString(encoding);
            return {
                responseId: responseID, offset, bytesRead, nextOffset: offset + bytesRead,
                totalBytes: metadata.bytes, complete: offset + bytesRead >= metadata.bytes,
                encoding, data, sha256: metadata.sha256, reason: metadata.reason
            };
        } finally {
            await handle.close();
        }
    }

    backendError(id, message) {
        return {
            jsonrpc: '2.0', id,
            error: {
                code: BACKEND_UNAVAILABLE_ERROR_CODE, message,
                data: { recovery: 'The proxy kept the tunnel-facing MCP transport alive and is restoring the backend.' }
            }
        };
    }

    async restartChild(reason) {
        if (this.restartPromise) return this.restartPromise;
        this.restartPromise = this.performRestart(reason).finally(() => { this.restartPromise = null; });
        return this.restartPromise;
    }

    async performRestart(reason) {
        this.log(`restarting backend reason=${reason}`);
        this.childReady = false;
        for (const entry of [...this.pending.values()]) {
            this.removePending(entry);
            await this.writeParent(serialize(this.backendError(entry.id, `MCP backend restarted before completing ${entry.method}.`)));
        }
        for (const [key, internal] of this.internal) {
            clearTimeout(internal.timer);
            internal.reject(new Error('backend restarted'));
            this.internal.delete(key);
        }
        await this.terminateChild();
        await this.spawnChild(this.sessionInitialized);
    }

    async terminateChild() {
        const child = this.child;
        if (!child) return;
        this.expectedExit = child;
        if (child.exitCode === null) {
            if (process.platform === 'win32' && child.pid) {
                // Terminate the owned process tree, including PowerShell children.
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                    windowsHide: true, stdio: 'ignore'
                });
                // Do not block the MCP event loop while Windows stops the
                // backend and any PowerShell processes it created.
                await new Promise(resolve => {
                    const finish = () => { clearTimeout(timer); resolve(); };
                    const timer = setTimeout(() => {
                        killer.kill();
                        resolve();
                    }, RESTART_TIMEOUT_MS);
                    killer.once('exit', finish);
                    killer.once('error', finish);
                });
            }
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                await Promise.race([
                    new Promise(resolve => child.once('exit', resolve)),
                    new Promise(resolve => setTimeout(resolve, RESTART_TIMEOUT_MS))
                ]);
                if (child.exitCode === null) child.kill('SIGKILL');
            }
        }
        if (this.child === child) this.child = null;
        this.expectedExit = null;
    }

    async handleChildExit(child, code, signal) {
        if (this.child === child) {
            this.child = null;
            this.childReady = false;
        }
        if (this.shuttingDown || this.expectedExit === child) return;
        this.log(`backend exited pid=${child.pid} generation=${this.childGeneration} code=${code} signal=${signal ?? ''}`);
        try { await this.restartChild('backend process exited'); }
        catch (error) { this.log(`backend restart failed: ${error}`); }
    }

    async shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        if (this.restartTimer) clearInterval(this.restartTimer);
        this.pending.clear();
        for (const internal of this.internal.values()) {
            clearTimeout(internal.timer);
            internal.reject(new Error('proxy shutting down'));
        }
        this.internal.clear();
        await this.terminateChild().catch(() => {});
        process.exit(0);
    }
}

const proxy = new MCPStdioProxy();
proxy.start().catch(error => {
    process.stderr.write(`[mcp-stdio-proxy] fatal: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
});
