const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const events = [];
const sync = process.argv[2] ? JSON.parse(process.argv[2]) : 1;
let diskText = process.argv[4] || '';
function offset(position) {
  const lines = diskText.split('\n');
  return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character;
}
if (process.argv[3]) require('node:fs').appendFileSync(process.argv[3], `${process.pid}\n`);
conn.onRequest('initialize', async (p) => {
  events.push(['initialize', p]);
  return { capabilities: { positionEncoding: 'utf-16', textDocumentSync: sync } };
});
conn.onNotification('initialized', () => { events.push(['initialized']); });
for (const method of ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']) {
  conn.onNotification(method, p => {
    events.push([method, p]);
    if (method === 'textDocument/didOpen') diskText = p.textDocument.text;
    if (method === 'textDocument/didChange') for (const change of p.contentChanges) {
      diskText = change.range ? diskText.slice(0, offset(change.range.start)) + change.text + diskText.slice(offset(change.range.end)) : change.text;
    }
  });
}
conn.onRequest('test/events', () => events);
conn.onRequest('test/text', () => diskText);
conn.onRequest('test/pid', () => process.pid);
conn.onRequest('test/reverse', async () => {
  const config = await conn.sendRequest('workspace/configuration', { items: [{ section: 'test' }] });
  let unsupported;
  try { await conn.sendRequest('unsupported/serverRequest', {}); } catch (e) { unsupported = e.code; }
  return { config, unsupported };
});
conn.onRequest('test/register', async () => {
  try { await conn.sendRequest('client/registerCapability', { registrations: [{ id: 'x', method: 'workspace/didChangeWatchedFiles', registerOptions: { watchers: [] } }] }); return 'accepted'; }
  catch (e) { return e.code; }
});
conn.onRequest('test/hang', () => new Promise(() => {}));
conn.onRequest('test/crash', () => { process.exit(7); });
conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));
conn.listen();
