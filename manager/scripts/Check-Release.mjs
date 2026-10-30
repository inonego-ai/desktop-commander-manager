/** Release preflight: guard against accidental inclusion of local credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntime } from './Verify-Runtime.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenNames = new Set(['.env', 'connection.json', 'settings.json',
  'backend-restart.request', 'commander-manager.yaml', 'credentials.json']);
const forbiddenExts = new Set(['.pem', '.p12', '.pfx', '.token', '.secret']);
const keyShape = /\bsk-(?:proj-|svcacct-|admin-|org-)?[A-Za-z0-9_-]{20,}\b/;
const dirs = ['src', 'src-tauri/src', 'src-tauri/resources', 'scripts', 'tests'];
const excludes = new Set(['.git', 'node_modules', 'target', 'dist', '.tmp']);
let count = 0;
const failures = [];
const versions = [
  JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8')).version,
  JSON.parse(fs.readFileSync(path.join(project,'src-tauri/tauri.conf.json'),'utf8')).version,
  fs.readFileSync(path.join(project,'src-tauri/Cargo.toml'),'utf8').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]
];
if (!versions[0] || versions.some(version => version !== versions[0])) {
  failures.push('프런트엔드·Rust·설치 프로그램 버전이 일치하지 않습니다.');
}
function audit(dir) {
  if (!fs.existsSync(dir)) return;
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = dirent.name;
    const full = path.join(dir, name);
    const relative = path.relative(project, full).replaceAll('\\', '/');
    if (dirent.isDirectory()) {
      if (excludes.has(name)) continue;
      if (name === 'profiles' || name === 'state' || name === 'credentials') failures.push(relative);
      else audit(full);
      continue;
    }
    if (!dirent.isFile()) continue;
    count++;
    if (forbiddenNames.has(name) || name.startsWith('.env.') || forbiddenExts.has(path.extname(name))) failures.push(relative);
    if (full.includes(`${path.sep}runtime${path.sep}`)) continue; // vendor binaries: name rules checked, contents excluded
    const stat = fs.statSync(full);
    if (stat.size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(full);
    if (content.includes(0)) continue;
    if (keyShape.test(content.toString('utf8'))) failures.push(`${relative} (API key pattern)`);
  }
}
for (const dir of dirs) audit(path.join(project, dir));

// Verify the packaged extension registry matches the source exactly.
// This rejects leftover Goal/Plan code from an earlier installation or build.
const sourceRoot = path.resolve(project, '../src');
const bundledProxy = path.join(project, 'src-tauri/resources/proxy');
const requiredProxyFiles = [
  'MCPStdioProxy.mjs', 'extensions/index.mjs', 'extensions/registry.mjs'
];
function proxyFiles(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isSymbolicLink()) { failures.push(`배포 리소스에 링크가 있습니다: ${name}`); return []; }
    return entry.isDirectory() ? proxyFiles(path.join(directory, entry.name), name + '/') : [name];
  });
}
if (fs.existsSync(bundledProxy)) {
  if (JSON.stringify(proxyFiles(bundledProxy).sort()) !== JSON.stringify([...requiredProxyFiles].sort())) {
    failures.push('배포 프록시에 누락되거나 선언되지 않은 확장 파일이 있습니다.');
  }
  for (const relative of requiredProxyFiles) {
    const source = path.join(sourceRoot, relative);
    const packaged = path.join(bundledProxy, relative);
    if (!fs.existsSync(source) || !fs.existsSync(packaged) ||
        !fs.readFileSync(source).equals(fs.readFileSync(packaged))) {
      failures.push(`릴리스용 MCP 프록시 파일이 현재 소스와 다릅니다: ${relative}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(`릴리스 사전 검사 실패:\n${failures.join('\n')}\n`);
  process.exit(1);
}
await verifyRuntime(path.join(project, 'src-tauri/resources'));
console.log(`릴리스 사전 검사 통과: ${count}개 파일 검사, 확장 레지스트리 일치, MCP 초기화 및 명령 성공, 인증 정보 노출 없음.`);
