import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

// Exercise the actual packaged backend, not a mock or package.json existence
// check. All Commander configuration and telemetry files stay temporary.
export async function verifyRuntime(resources) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'commander-runtime-check-'));
  const runtime = path.join(resources, 'runtime');
  const node = path.join(runtime, 'node.exe');
  const backend = path.join(runtime, 'node_modules/@wonderwhy-er/desktop-commander/dist/index.js');
  const proxy = path.join(resources, 'proxy/MCPStdioProxy.mjs');
  await mkdir(path.join(temp, 'home'));
  const child = spawn(node, [proxy, '--', node, backend, '--no-onboarding'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, USERPROFILE: path.join(temp, 'home'), HOME: path.join(temp, 'home'),
      APPDATA: path.join(temp, 'appdata'), LOCALAPPDATA: path.join(temp, 'localappdata'),
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', MCP_BACKEND_RESTART_TRIGGER: '',
      MCP_PROXY_SPOOL_DIR: path.join(temp, 'spool') }
  });
  let stderr = '', sequence = 0;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const pending = new Map();
  const output = readline.createInterface({ input: child.stdout });
  output.on('line', line => {
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    } catch { /* Non-JSON output cannot satisfy a request. */ }
  });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`${method}: 응답 시간 초과`));
    }, 20000);
    pending.set(id, message => {
      clearTimeout(timer); pending.delete(id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const params = { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'manager-release-check', version: '1' } };
    const initialized = await request('initialize', params);
    assert.ok(initialized.serverInfo?.name, '실제 백엔드 초기화 응답이 필요합니다.');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await request('tools/list', {});
    assert.ok(catalog.tools.some(tool => tool.name === 'get_usage_stats'));
    assert.ok(!catalog.tools.some(tool => /^plan_|^task_|^goal_/.test(tool.name)),
      '제거된 Goal/Plan 도구가 배포되면 안 됩니다.');
    const command = await request('tools/call', { name: 'get_usage_stats', arguments: {} });
    assert.ok(command.content?.length && !command.isError, '실제 커맨더 명령이 성공해야 합니다.');
    for (let i = 0; i < 3; i++) await request('initialize', params);
    const state = JSON.parse((await request('tools/call', {
      name: 'mcp_transport_status', arguments: {}
    })).content[0].text);
    assert.equal(state.backendGeneration, 1, '초기화 및 명령 중 백엔드가 재시작되면 안 됩니다.');
    assert.equal(state.sessionInitialized, true);
    assert.equal(state.cachedInitializeResponses, 3);
    return { tools: catalog.tools.length, backendGeneration: state.backendGeneration,
      cachedInitializeResponses: state.cachedInitializeResponses, commandSucceeded: true };
  } catch (error) {
    // Return only the missing package/error category, never raw user paths or
    // protocol contents. Full stderr remains in the locally installed log.
    const missing = /Cannot find package '([^']+)'/.exec(stderr)?.[1];
    throw new Error(`실제 MCP 런타임 검사 실패: ${error.message}${missing ? ` (누락 패키지: ${missing})` : ''}`);
  } finally {
    child.stdin.end();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
      await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve); });
      await exited;
    }
    output.close();
    await rm(temp, {recursive:true, force:true, maxRetries:5, retryDelay:200});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await verifyRuntime(path.resolve(process.argv[2]))));
}
