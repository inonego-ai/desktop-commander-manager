/** Release preflight: guard against accidental inclusion of local credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenNames = new Set(['.env', 'connection.json', 'settings.json',
  'backend-restart.request', 'commander-manager.yaml', 'credentials.json']);
const forbiddenExts = new Set(['.pem', '.p12', '.pfx', '.token', '.secret']);
const keyShape = /\bsk-(?:proj-|svcacct-|admin-|org-)?[A-Za-z0-9_-]{20,}\b/;
const dirs = ['src', 'src-tauri/src', 'src-tauri/resources', 'scripts', 'tests'];
const excludes = new Set(['.git', 'node_modules', 'target', 'dist', '.tmp']);
let count = 0;
const failures = [];
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
if (failures.length) {
  process.stderr.write(`Release preflight failed: personal files or possible API keys found:\n${failures.join('\n')}\n`);
  process.exit(1);
}
console.log(`Release preflight passed: ${count} files inspected; no local credential files or recognizable API keys found.`);
