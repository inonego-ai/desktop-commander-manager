/**
 * Local policy boundary between MCPStdioProxy and Desktop Commander.
 * Restricted mode deliberately exposes only a small, audited subset of
 * direct file tools. Shell/process/search/config tools are not reachable.
 * Policy reloads for every request, so adding/removing folders is live.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const delimiter = process.argv.indexOf('--');
if (delimiter < 0 || !process.argv[delimiter + 1]) {
  throw new Error('Usage: node PolicyProxy.mjs -- <backend command> [args...]');
}

const policyFile = process.env.MCP_ACCESS_POLICY_PATH;
const restartFile = process.env.MCP_PROXY_RESTART_TRIGGER;
if (!policyFile || !restartFile) {
  throw new Error('Missing MCP_ACCESS_POLICY_PATH or MCP_PROXY_RESTART_TRIGGER. Refusing unguarded startup.');
}

const allowedToolFields = new Map([
  ['read_file', ['path']],
  ['read_multiple_files', ['paths']],
  ['write_file', ['path']],
  ['edit_block', ['file_path']],
  ['create_directory', ['path']],
  ['list_directory', ['path']],
  ['list_directory_with_sizes', ['path']],
  ['get_file_info', ['path']],
  ['move_file', ['source', 'destination']]
]);
const pendingList = new Set();
const idKey = id => `${typeof id}:${JSON.stringify(id)}`;
const backend = spawn(process.argv[delimiter + 1], process.argv.slice(delimiter + 2), {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env
});
backend.stderr.pipe(process.stderr, { end: false });
backend.on('error', error => { process.stderr.write(`policy backend error: ${error.message}\n`); process.exitCode = 1; });
backend.on('exit', (code, signal) => { process.stderr.write(`policy backend exited: ${code ?? signal}\n`); process.exit(code ?? 1); });
function stopBackend() {
  if (!backend.pid || backend.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 4500 });
  } else {
    backend.kill('SIGTERM');
  }
}
const requestInput = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const responseInput = readline.createInterface({ input: backend.stdout, crlfDelay: Infinity });

function policy() {
  const settings = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  if (typeof settings.restricted !== 'boolean' || !Array.isArray(settings.allowed_folders)) {
    throw new Error('Invalid access policy');
  }
  return settings;
}

function canonical(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Missing file path');
  if (process.platform === 'win32') {
    if (/^\\\\\.\\/.test(input) || /^\\\\\?\\GLOBALROOT/i.test(input)) throw new Error('Device paths are not supported');
    if (!path.win32.isAbsolute(input)) throw new Error('Only absolute paths are allowed');
  } else if (!path.isAbsolute(input)) throw new Error('Only absolute paths are allowed');
  const remaining = [];
  let probe = path.resolve(input);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error('No existing ancestor for path');
    remaining.unshift(path.basename(probe));
    probe = parent;
  }
  let resolved = fs.realpathSync.native(probe);
  for (const segment of remaining) resolved = path.join(resolved, segment);
  return process.platform === 'win32' ? resolved.replace(/^\\\\\?\\/, '').toLowerCase() : resolved;
}

function within(target, roots) {
  const candidate = canonical(target);
  return roots.some(root => {
    const base = canonical(root);
    const relative = path.relative(base, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function authorizeTool(name, args, settings) {
  if (!settings.restricted) return true;
  const fields = allowedToolFields.get(name);
  if (!fields || args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  if (args.isUrl === true) return false;
  if (!fields.every(field => Object.hasOwn(args, field))) return false;
  const names = Object.keys(args);
  if (names.some(field => /^(?:command|shell|url|uri|cwd|working_directory|origin)$/i.test(field))) return false;
  try {
    return fields.every(field => {
      const value = args[field];
      if (Array.isArray(value)) return value.length > 0 && value.every(p => typeof p === 'string' && within(p, settings.allowed_folders));
      return typeof value === 'string' && within(value, settings.allowed_folders);
    });
  } catch { return false; }
}

function rejectCall(msg, reason) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: msg.id,
    result: { isError: true, content: [{ type: 'text', text: reason }] }
  }) + '\n');
}

function rejectMethod(msg) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: msg.id,
    error: { code: -32010, message: 'This MCP operation is not available in restricted mode.' }
  }) + '\n');
}

requestInput.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  let settings;
  try { settings = policy(); } catch (err) {
    // Fail closed if policy becomes unreadable or corrupted, including OFF mode.
    if (Object.hasOwn(msg, 'id')) rejectMethod(msg);
    return;
  }
  if (settings.restricted) {
    const hasID = Object.hasOwn(msg, 'id');
    if (msg.method === 'tools/call') {
      // MCP tool calls must be requests, never notifications: a notification
      // without an ID would otherwise bypass the authorization branch.
      if (!hasID) return;
      if (!authorizeTool(msg.params?.name, msg.params?.arguments, settings)) {
        rejectCall(msg, 'Directory restriction blocked this tool or path.'); return;
      }
    } else if (['notifications/initialized', 'notifications/cancelled', 'notifications/cancelled_request'].includes(msg.method)) {
      // Harmless protocol notifications still need to reach the backend.
    } else if (!hasID || !['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'].includes(msg.method)) {
      // All other notifications and requests, including resources/read,
      // must be denied while restricted. Never forward an unapproved method.
      if (hasID) rejectMethod(msg);
      return;
    }
  }
  if (msg.method === 'tools/list' && Object.hasOwn(msg, 'id')) pendingList.add(idKey(msg.id));
  backend.stdin.write(line + '\n');
});

responseInput.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }
  const key = idKey(msg.id);
  if (pendingList.delete(key) && Array.isArray(msg.result?.tools)) {
    try {
      if (policy().restricted) {
        msg.result.tools = msg.result.tools.filter(tool => allowedToolFields.has(tool?.name));
      }
    } catch { msg.result.tools = []; }
  }
  process.stdout.write(JSON.stringify(msg) + '\n');
});

let lastRestart = (() => { try { return fs.readFileSync(restartFile, 'utf8'); } catch { return ''; } })();
const timer = setInterval(() => {
  let token = '';
  try { token = fs.readFileSync(restartFile, 'utf8'); } catch {}
  if (token && token !== lastRestart) {
    // Exiting the guarded child causes the existing transport proxy to
    // rebuild it and replay the MCP initialize session.
    stopBackend();
    process.exit(0);
  }
  lastRestart = token;
}, 300);
timer.unref();
requestInput.on('close', () => { stopBackend(); process.exit(0); });
