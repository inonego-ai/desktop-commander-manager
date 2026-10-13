/**
 * Reproducible, fail-closed compatibility fix for Desktop Commander 0.2.50.
 * Patches three readline helpers that leave fs.createReadStream handles open
 * after an early break, which can block Windows atomic saves (e.g. Unity).
 * Must be run only against a fresh, verified v0.2.50 npm install.
 */
import fs from 'node:fs';
import path from 'node:path';

const runtime = process.argv[2];
if (!runtime) throw new Error('Usage: node Patch-DesktopCommander.mjs <runtime directory>');
const pkgDir = path.join(runtime, 'node_modules', '@wonderwhy-er', 'desktop-commander');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
if (pkg.version !== '0.2.50') throw new Error(`Unrecognized Desktop Commander version ${pkg.version}; refusing to patch`);
const file = path.join(pkgDir, 'dist', 'utils', 'files', 'text.js');
const original = fs.readFileSync(file, 'utf8');
const alreadyPatched = (original.match(/inputStream\.destroy\(\);/g) ?? []).length === 2
  && (original.match(/sampleStream\.destroy\(\);/g) ?? []).length === 1
  && (original.match(/stream\.destroy\(\);/g) ?? []).length === 1;
if (alreadyPatched) {
  console.log(`Desktop Commander ${pkg.version} file stream cleanup patch already applied.`);
  process.exit(0);
}
let updated = original;

function replaceOnce(text, from, to, title) {
  const start = text.indexOf(from);
  if (start === -1 || text.indexOf(from, start + from.length) !== -1) {
    throw new Error(`Unexpected upstream layout: ${title}; refusing to patch`);
  }
  return text.slice(0, start) + to + text.slice(start + from.length);
}
function patchMethod(name, endMarker, fixes) {
  const first = updated.indexOf(`    async ${name}(`);
  if (first < 0) throw new Error(`Missing ${name}`);
  const end = endMarker ? updated.indexOf(endMarker, first) : updated.lastIndexOf('\n}');
  if (end < first) throw new Error(`Missing end marker for ${name}`);
  let block = updated.slice(first, end);
  for (const [from, to, label] of fixes) block = replaceOnce(block, from, to, `${name}:${label}`);
  updated = updated.slice(0, first) + block + updated.slice(end);
}

const streamOld = `        const rl = createInterface({\n            input: createReadStream(filePath, { signal, encoding, start }),\n            crlfDelay: Infinity\n        });`;
const streamNew = `        const inputStream = createReadStream(filePath, { signal, encoding, start });\n        const rl = createInterface({\n            input: inputStream,\n            crlfDelay: Infinity\n        });`;
const forStart = '        for await (const line of rl) {';
const tryForStart = '        try {\n            for await (const line of rl) {';
const closeOld = '        rl.close();';
const closeNew = '        } finally {\n            rl.close();\n            inputStream.destroy();\n        }';
patchMethod('readFromEndWithReadline', '    /**\n     * Read from start/middle', [
  [streamOld, streamNew, 'read stream'], [forStart, tryForStart, 'try'], [closeOld, closeNew, 'cleanup']
]);
patchMethod('readFromStartWithReadline', '    /**\n     * Read from estimated byte position', [
  [streamOld, streamNew, 'read stream'], [forStart, tryForStart, 'try'], [closeOld, closeNew, 'cleanup']
]);
patchMethod('readFromEstimatedPosition', null, [
  [
    `        const rl = createInterface({\n            input: createReadStream(filePath, { signal }),\n            crlfDelay: Infinity\n        });`,
    `        const sampleStream = createReadStream(filePath, { signal });\n        const rl = createInterface({\n            input: sampleStream,\n            crlfDelay: Infinity\n        });`,
    'sampling stream'
  ],
  [forStart, tryForStart, 'sample try'],
  [closeOld, '        } finally {\n            rl.close();\n            sampleStream.destroy();\n        }', 'sample cleanup'],
  ['            for await (const line of rl2) {', '            try {\n                for await (const line of rl2) {', 'position try'],
  ['            rl2.close();', '            } finally {\n                rl2.close();\n                stream.destroy();\n            }', 'position cleanup']
]);
if (original === updated) throw new Error('Patch had no effect');
// Write only after all hunks have matched. Fail closed if upstream changes.
fs.writeFileSync(file, updated);
console.log(`Patched v${pkg.version} streaming file handle cleanup in ${path.relative(runtime, file)}`);
