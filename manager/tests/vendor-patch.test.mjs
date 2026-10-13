import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const patchScript = path.join(here, '..', 'scripts', 'Patch-DesktopCommander.mjs');
const snippet = `import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
export class TextFileHandler {
    async readFromEndWithReadline(filePath, requestedLines, mimeType, includeStatusMessage = true, fileTotalLines, signal, encoding, start) {
        const rl = createInterface({
            input: createReadStream(filePath, { signal, encoding, start }),
            crlfDelay: Infinity
        });
        const buffer = [];
        for await (const line of rl) {
            buffer.push(line);
        }
        rl.close();
        return buffer;
    }
    /**
     * Read from start/middle using readline
     */
    async readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage = true, fileTotalLines, signal, encoding, start) {
        const rl = createInterface({
            input: createReadStream(filePath, { signal, encoding, start }),
            crlfDelay: Infinity
        });
        const result = [];
        let lineNumber = 0;
        for await (const line of rl) {
            if (lineNumber >= offset && result.length < length) {
                result.push(line);
            }
            if (result.length >= length)
                break;
            lineNumber++;
        }
        rl.close();
        return result;
    }
    /**
     * Read from estimated byte position for very large files
     */
    async readFromEstimatedPosition(filePath, offset, length, mimeType, includeStatusMessage = true, fileTotalLines, signal) {
        const rl = createInterface({
            input: createReadStream(filePath, { signal }),
            crlfDelay: Infinity
        });
        let sampleLines = 0;
        let bytesRead = 0;
        for await (const line of rl) {
            bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
            sampleLines++;
            if (bytesRead >= 10000)
                break;
        }
        rl.close();
        if (sampleLines === 0) return [];
        const fd = {close: async()=>{}};
        try {
            const startPosition = 1;
            const stream = createReadStream(filePath, { start: startPosition, signal });
            const rl2 = createInterface({
                input: stream,
                crlfDelay: Infinity
            });
            const result = [];
            let firstLineSkipped = false;
            for await (const line of rl2) {
                if (!firstLineSkipped && startPosition > 0) {
                    firstLineSkipped = true;
                    continue;
                }
                if (result.length < length) {
                    result.push(line);
                }
                else {
                    break;
                }
            }
            rl2.close();
            return result;
        }
        finally {
            await fd.close();
        }
    }
}
`;

test('reproducible vendor patch closes partial-read streams and rejects unknown versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-patch-'));
  const packageDir = path.join(root, 'node_modules', '@wonderwhy-er', 'desktop-commander');
  const distDir = path.join(packageDir, 'dist', 'utils', 'files');
  try {
    await fs.mkdir(distDir, { recursive: true });
    const file = path.join(distDir, 'text.js');
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ version:'0.2.50',type:'module' }));
    await fs.writeFile(file, snippet);
    const patch = spawnSync(process.execPath, [patchScript, root], {encoding:'utf8'});
    assert.equal(patch.status, 0, patch.stderr);
    const newText = await fs.readFile(file, 'utf8');
    assert.match(newText, /inputStream\.destroy\(\)/);
    assert.match(newText, /sampleStream\.destroy\(\)/);
    assert.match(newText, /stream\.destroy\(\)/);
    const syntax = spawnSync(process.execPath, ['--check',file], {encoding:'utf8'});
    assert.equal(syntax.status, 0, syntax.stderr);
    const sample = path.join(root,'test.txt');
    await fs.writeFile(sample,'one\ntwo\nthree\nfour\nfive\n');
    const {TextFileHandler} = await import('file://'+file);
    const output = await new TextFileHandler().readFromStartWithReadline(sample,0,1,'text/plain');
    assert.deepEqual(output,['one']);
    const second = spawnSync(process.execPath,[patchScript,root],{encoding:'utf8'});
    assert.equal(second.status,0, 'rebuild with an already patched runtime is idempotent');
    assert.equal(await fs.readFile(file,'utf8'),newText);
    await fs.writeFile(path.join(packageDir,'package.json'),JSON.stringify({version:'0.2.52'}));
    const unknown = spawnSync(process.execPath,[patchScript,root],{encoding:'utf8'});
    assert.notEqual(unknown.status,0,'refuse other package versions');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
