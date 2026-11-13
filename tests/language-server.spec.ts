import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanguageServer } from '../src/language-server';
import { StreamMessageWriter } from 'vscode-jsonrpc/node.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const command = { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mock-lsp.cjs', import.meta.url))] };
const uri = pathToFileURL(fileURLToPath(new URL('./emoji.go', import.meta.url))).href;

test('startup failure reports a bounded safe SDK hint without leaking stderr', async () => {
  const script = "process.stderr.write('You must install .NET SDK before running this application. PRIVATE_TOKEN_123'); process.exit(1)";
  await assert.rejects(LanguageServer.start(root, { command: process.execPath, args: ['-e', script] }), (error: any) => {
    assert.match(error.message, /SDK/i);
    assert.doesNotMatch(error.message, /PRIVATE_TOKEN_123/);
    assert.ok(error.message.length < 500);
    return true;
  });
});

test('initialize and synchronize unsaved UTF-16 text in order', async () => {
  const server = await LanguageServer.start(root, command);
  try {
    await server.open(uri, 'go', 'a😀');
    await server.change(uri, '中😀');
    await server.change(uri, '中😀!');
    const events = await server.request<any[]>('test/events', {});
    assert.deepEqual(events.map(e => e[0]), ['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/didChange', 'textDocument/didChange']);
    assert.deepEqual(events[0][1].capabilities.general.positionEncodings, ['utf-16']);
    assert.equal(events[0][1].rootUri, pathToFileURL(root).href.replace(/\/$/, ''));
    assert.equal(events[2][1].textDocument.text, 'a😀');
    assert.equal(events[3][1].textDocument.version, 2);
    assert.equal(events[4][1].textDocument.version, 3);
    assert.equal(events[4][1].contentChanges[0].text, '中😀!');
    await server.close(uri);
    assert.equal((await server.request<any[]>('test/events', {})).at(-1)![0], 'textDocument/didClose');
  } finally { await server.dispose(); }
});

test('responds to server requests and unsupported methods', async () => {
  const server = await LanguageServer.start(root, command);
  try {
    assert.deepEqual(await server.request('test/reverse', {}), { config: [null], unsupported: -32601 });
    await assert.rejects(server.request('test/unknown', {}), /method|unhandled/i);
  } finally { await server.dispose(); }
});

test('timeout, crash, reconnect and disposal settle pending calls', async () => {
  const server = await LanguageServer.start(root, command, { timeoutMs: 200 });
  try {
    await server.open(uri, 'go', 'first');
    await server.change(uri, 'unsaved😀');
    await assert.rejects(server.request('test/hang', {}), /timed out/i);
    await server.reconnect();
    const pending = server.request('test/hang', {});
    const rejected = assert.rejects(pending);
    await server.reconnect();
    await rejected;
    const events = await server.request<any[]>('test/events', {});
    const opened = events.find(e => e[0] === 'textDocument/didOpen');
    assert.equal(opened[1].textDocument.text, 'unsaved😀');
    const crashPending = server.request('test/hang', {});
    const crashRejected = assert.rejects(crashPending);
    await server.request('test/events', {}); // ensures the hung request was sent
    await assert.rejects(server.request('test/crash', {}));
    await crashRejected;
    await server.reconnect();
    assert.equal((await server.request<any[]>('test/events', {})).find(e => e[0] === 'textDocument/didOpen')[1].textDocument.text, 'unsaved😀');
    const last = server.request('test/hang', {});
    const lastRejected = assert.rejects(last);
    await server.dispose();
    await lastRejected;
  } finally { await server.dispose(); }
});

test('starts a Windows cmd executable with spaces and shell metacharacters in its path', { skip: process.platform !== 'win32' }, async () => {
  const server = await LanguageServer.start(root, fileURLToPath(new URL('./fixtures/mock-lsp.cmd', import.meta.url)));
  const pid = await server.request<number>('test/pid', {});
  await server.dispose();
  assert.throws(() => process.kill(pid, 0));
});

test('preserves filesystem root URI', async () => {
  const filesystemRoot = process.platform === 'win32' ? `${process.cwd().slice(0, 2)}\\` : '/';
  const server = await LanguageServer.start(filesystemRoot, command);
  try { assert.equal((await server.request<any[]>('test/events', {}))[0][1].rootUri, pathToFileURL(filesystemRoot).href); }
  finally { await server.dispose(); }
});

test('obeys numeric and object synchronization capabilities', async () => {
  for (const [sync, expected] of [
    [0, []], [1, ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']],
    [2, ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']],
    [{ openClose: false, change: 1 }, ['textDocument/didChange']],
    [{ openClose: true, change: 0 }, ['textDocument/didOpen', 'textDocument/didClose']],
    [{ openClose: true, change: 2 }, ['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']],
    [{}, []],
  ] as const) {
    const server = await LanguageServer.start(root, { ...command, args: [...command.args, JSON.stringify(sync)] });
    try {
      await server.open(uri, 'go', 'a😀\r\n中');
      await server.change(uri, 'new');
      await server.close(uri);
      const events = (await server.request<any[]>('test/events', {})).filter(e => e[0].startsWith('textDocument/'));
      assert.deepEqual(events.map(e => e[0]), expected);
      const change = events.find(e => e[0] === 'textDocument/didChange');
      if (change && (sync === 2 || (typeof sync === 'object' && 'change' in sync && sync.change === 2))) assert.deepEqual(change[1].contentChanges, [{ range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }, text: 'new' }]);
      if (change && !(sync === 2 || (typeof sync === 'object' && 'change' in sync && sync.change === 2))) assert.deepEqual(change[1].contentChanges, [{ text: 'new' }]);
    } finally { await server.dispose(); }
  }
});

test('incremental synchronization ranges use UTF-16 code units', async () => {
  const server = await LanguageServer.start(root, { ...command, args: [...command.args, '2'] });
  try {
    await server.open(uri, 'go', 'a😀');
    await server.change(uri, 'x');
    const event = (await server.request<any[]>('test/events', {})).find(e => e[0] === 'textDocument/didChange');
    assert.deepEqual(event[1].contentChanges[0].range.end, { line: 0, character: 3 });
  } finally { await server.dispose(); }
});

test('rejects unsupported dynamic capability registration', async () => {
  const server = await LanguageServer.start(root, command);
  try { assert.equal(await server.request('test/register', {}), -32601); }
  finally { await server.dispose(); }
});

test('offline edits are accepted and retries are idempotent', async () => {
  const server = await LanguageServer.start(root, command);
  try {
    await assert.rejects(server.request('test/crash', {}));
    await server.open(uri, 'go', 'offline');
    await server.open(uri, 'go', 'offline');
    await server.change(uri, 'unsaved');
    await server.change(uri, 'unsaved');
    await server.reconnect();
    const events = await server.request<any[]>('test/events', {});
    assert.equal(events.find(e => e[0] === 'textDocument/didOpen')[1].textDocument.text, 'unsaved');
  } finally { await server.dispose(); }
});

test('concurrent reconnect and disposal leave no child processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-pids-'));
  const pids = join(dir, 'pids');
  const server = await LanguageServer.start(root, { ...command, args: [...command.args, '1', pids] });
  try {
    await Promise.all([server.reconnect(), server.reconnect(), server.reconnect()]);
    const inFlight = server.reconnect();
    const settled = Promise.allSettled([inFlight]);
    await new Promise(resolve => setImmediate(resolve));
    await server.dispose();
    await settled;
    const ids = (await readFile(pids, 'utf8')).trim().split(/\s+/).map(Number);
    for (let i = 0; i < 40; i++) {
      if (ids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const pid of ids) assert.throws(() => process.kill(pid, 0), `process ${pid} survived`);
  } finally { await server.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('unsynchronized peer document blocks navigation until reconnect or close', async () => {
  const peer = pathToFileURL(fileURLToPath(new URL('./peer.go', import.meta.url))).href;
  const server = await LanguageServer.start(root, { ...command, args: [...command.args, JSON.stringify({ openClose: true, change: 0 })] });
  const params = { textDocument: { uri }, position: { line: 0, character: 0 } };
  try {
    await server.open(uri, 'go', 'a'); await server.open(peer, 'go', 'b'); await server.change(peer, 'unsaved');
    await assert.rejects(server.request('textDocument/definition', params), /synchroniz/i);
    await server.reconnect();
    await assert.rejects(server.request('textDocument/definition', params), error => !/synchroniz/i.test(String(error)));
    await server.change(peer, 'again'); await assert.rejects(server.request('textDocument/definition', params), /synchroniz/i);
    await server.close(peer);
    await assert.rejects(server.request('textDocument/definition', params), error => !/synchroniz/i.test(String(error)));
  } finally { await server.dispose(); }
});

test('rejects document requests when server cannot receive unsaved text', async () => {
  const server = await LanguageServer.start(root, { ...command, args: [...command.args, JSON.stringify({ openClose: true, change: 0 })] });
  try {
    await server.open(uri, 'go', 'original');
    await server.change(uri, 'unsaved');
    await assert.rejects(server.request('textDocument/definition', { textDocument: { uri }, position: { line: 0, character: 0 } }), /sync/i);
  } finally { await server.dispose(); }
});

test('unknown incremental baseline never changes server disk text', async () => {
  const spec = { ...command, args: [...command.args, JSON.stringify({ openClose: false, change: 2 }), '', 'disk content'] };
  const server = await LanguageServer.start(root, spec);
  try {
    await server.open(uri, 'go', 'different local text');
    await assert.rejects(server.change(uri, 'unsaved'), /incremental.*sync/i);
    await assert.rejects(server.change(uri, 'unsaved'), /incremental.*sync/i);
    assert.equal(await server.request('test/text', {}), 'disk content');
    assert.equal((await server.request<any[]>('test/events', {})).filter(e => e[0] === 'textDocument/didChange').length, 0);
    await server.reconnect();
    await assert.rejects(server.change(uri, 'more unsaved'), /incremental.*sync/i);
    assert.equal(await server.request('test/text', {}), 'disk content');
    assert.equal((await server.request<any[]>('test/events', {})).filter(e => e[0] === 'textDocument/didChange').length, 0);
  } finally { await server.dispose(); }
});

test('start rejects when initialized write fails', async () => {
  const original = StreamMessageWriter.prototype.write;
  StreamMessageWriter.prototype.write = function(message: any) {
    return message.method === 'initialized' ? Promise.reject(new Error('injected initialized write failure')) : original.call(this, message);
  };
  try { await assert.rejects(LanguageServer.start(root, command), /initialized write failure/i); }
  finally { StreamMessageWriter.prototype.write = original; }
});

test('reconnect rejects when final didOpen replay write fails', async () => {
  const server = await LanguageServer.start(root, command);
  await server.open(uri, 'go', 'unsaved');
  const original = StreamMessageWriter.prototype.write;
  StreamMessageWriter.prototype.write = function(message: any) {
    return message.method === 'textDocument/didOpen' ? Promise.reject(new Error('injected replay write failure')) : original.call(this, message);
  };
  try {
    await assert.rejects(server.reconnect(), /replay write failure/i);
    await assert.rejects(server.request('test/events', {}));
  } finally { StreamMessageWriter.prototype.write = original; await server.dispose(); }
});

test('request write failure propagates to its caller', async () => {
  const original = StreamMessageWriter.prototype.write;
  StreamMessageWriter.prototype.write = function(message: any) {
    return message.method === 'test/events' ? Promise.reject(new Error('injected request write failure')) : original.call(this, message);
  };
  let server: LanguageServer | undefined;
  try {
    server = await LanguageServer.start(root, command);
    await assert.rejects(server.request('test/events', {}), /injected request write failure/i);
  } finally { StreamMessageWriter.prototype.write = original; await server?.dispose(); }
});

test('missing executable is reported', async () => {
  await assert.rejects(LanguageServer.start(root, 'missing-lsp-executable-238471'), /missing-lsp-executable-238471/i);
});
