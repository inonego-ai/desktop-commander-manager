import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.resolve(here, '../src-tauri/resources/proxy/PolicyProxy.mjs');
const mockPath = path.resolve(here, 'proxy-backend.mjs');

test('restricted mode hides non-file tools, checks paths, and reloads policy live', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'commander-policy-'));
  const allowed = path.join(base, 'allowed');
  const outside = path.join(base, 'outside');
  const policyFile = path.join(base, 'policy.json');
  const trigger = path.join(base, 'restart.txt');
  const marker = path.join(base, 'notification.executed');
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  await writeFile(policyFile, JSON.stringify({ restricted: true, allowed_folders: [allowed] }));
  const child = spawn(process.execPath, [guardPath, '--', process.execPath, mockPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_ACCESS_POLICY_PATH: policyFile, MCP_PROXY_RESTART_TRIGGER: trigger, MCP_GUARD_NOTIFICATION_MARKER: marker }
  });
  const messages = [];
  const out = readline.createInterface({ input: child.stdout });
  const waiters = new Map();
  out.on('line', text => {
    const value = JSON.parse(text);
    messages.push(value);
    const resolve = waiters.get(String(value.id));
    if (resolve) { waiters.delete(String(value.id)); resolve(value); }
  });
  let n = 0;
  function send(method, params = {}) {
    const id = ++n;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(String(id)); reject(Error('Timed out')); }, 3500);
      waiters.set(String(id), result => { clearTimeout(timeout); resolve(result); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const list = await send('tools/list');
    assert.equal((await send('resources/read', {uri:'file:///secret'})).error.code, -32010);
    // An MCP notification without a request ID must never bypass policy.
    child.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'tools/call', params:{name:'start_process', arguments:{command:'whoami'}}}) + '\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    await assert.rejects(access(marker), {code:'ENOENT'});
    assert.deepEqual(list.result.tools.map(t => t.name), ['read_file']);
    assert.equal((await send('tools/call', { name: 'start_process', arguments: { command: 'whoami' } })).result.isError, true);
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(outside, 'x') } })).result.isError, true);
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: '../relative.txt' } })).result.isError, true);
    assert.equal((await send('tools/call', { name: 'read_multiple_files', arguments: { paths: [path.join(allowed, 'a'), path.join(outside, 'b')] } })).result.isError, true);
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(allowed, 'test'), isUrl: true } })).result.isError, true);
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(allowed, 'x') } })).result.content[0].text, 'ok');
    await symlink(outside, path.join(allowed, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(allowed,'outside-link','x') } })).result.isError,true);
    assert.equal((await send('tools/call', { name: 'write_file', arguments: { path: path.join(allowed, 'new.txt'), content: 'test' } })).result.content[0].text, 'ok');
    await writeFile(policyFile, JSON.stringify({ restricted: false, allowed_folders: [allowed] }));
    assert.equal((await send('resources/read', {uri:'file:///secret'})).result.content[0].text, 'ok');
    assert.equal((await send('tools/call', { name: 'start_process', arguments: { command: 'ignored' } })).result.content[0].text, 'ok');
    await writeFile(policyFile, JSON.stringify({ restricted: true, allowed_folders: [] }));
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(allowed, 'x') } })).result.isError, true);
    await writeFile(policyFile, '{bad json');
    assert.equal((await send('tools/call', { name: 'read_file', arguments: { path: path.join(allowed, 'x') } })).error.code, -32010);
  } finally {
    child.kill();
    await rm(base, { recursive: true, force: true });
  }
});
