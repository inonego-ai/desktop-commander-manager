import readline from 'node:readline';
import fs from 'node:fs';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'tools/call' && !Object.hasOwn(request, 'id')) {
    if (process.env.MCP_GUARD_NOTIFICATION_MARKER) fs.writeFileSync(process.env.MCP_GUARD_NOTIFICATION_MARKER, 'executed');
    return;
  }
  const result = request.method === 'tools/list'
    ? { tools: [{ name: 'read_file' }, { name: 'start_process' }] }
    : { content: [{ type: 'text', text: 'ok' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
