import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function files(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), {withFileTypes:true})) {
    const name = path.posix.join(prefix, entry.name);
    if (name === 'runtime/.gitkeep') continue;
    if (entry.isSymbolicLink()) throw new Error(`설치 리소스의 링크는 지원하지 않습니다: ${name}`);
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();

// Inventory in both directions: matching declared files is not enough when an
// upgrade can leave unregistered modules or backups beside the current files.
export async function verifyInstallation({resources, executable, installed}) {
  const declared = await files(resources);
  const actual = (await files(installed)).filter(name => !['commander-manager.exe','uninstall.exe'].includes(name));
  const declaredSet = new Set(declared), actualSet = new Set(actual);
  const missing = declared.filter(name => !actualSet.has(name));
  const unexpected = actual.filter(name => !declaredSet.has(name));
  const mismatched = [];
  for (const name of declared.filter(name => actualSet.has(name))) {
    if (hash(await fs.readFile(path.join(resources, name))) !== hash(await fs.readFile(path.join(installed, name)))) mismatched.push(name);
  }
  const built = await fs.readFile(executable);
  const packaged = await fs.readFile(path.join(installed, 'commander-manager.exe'));
  const expected = Buffer.from(built);
  const sourceMarker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = expected.indexOf(sourceMarker);
  if (offset >= 0 && expected.indexOf(sourceMarker, offset + 1) < 0) {
    Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS').copy(expected, offset);
  }
  const executableMatches = expected.equals(packaged);
  return {resourcesChecked:declared.length, missing, unexpected, mismatched,
    executableMatches, executableHash:hash(packaged),
    passed:missing.length === 0 && unexpected.length === 0 && mismatched.length === 0 && executableMatches};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installed = process.argv[2];
  if (!installed) throw new Error('설치 폴더를 지정해 주세요.');
  const result = await verifyInstallation({resources:path.join(project,'src-tauri/resources'),
    executable:path.join(project,'src-tauri/target/release/commander-manager.exe'), installed:path.resolve(installed)});
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
