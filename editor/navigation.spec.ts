import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorNavigation } from './navigation';

test('editor synchronizes changes before queries and flushes before opening', async () => {
  const calls: any[] = [];
  let text = '中文😀';
  const location = { uri: 'file:///a.go', line: 0, character: 4 };
  const editor = new EditorNavigation(async (method, input) => {
    calls.push([method, input]);
    if (method === 'navigate') return { query: 4, locations: [location] };
    return null;
  }, () => text, async () => { calls.push(['flush']); });
  editor.bind(); text += '!'; editor.changed();
  const result = await editor.navigate('definition', { line: 0, character: 4 });
  await editor.open(result.query, result.locations[0]);
  assert.deepEqual(calls.map(c => c[0]), ['sync', 'navigate', 'flush', 'open']);
  assert.equal(calls[0][1].text, '中文😀!');
  assert.equal(calls[1][1].position.character, 4);
});

test('edits during attach wait until worker binding exists', async () => {
  let finish!: () => void; const gate = new Promise<void>(r => { finish = r; });
  const calls: string[] = []; const editor = new EditorNavigation(async method => { calls.push(method); return method === 'navigate' ? { query: 1, locations: [] } : null; }, () => 'new', async () => {});
  editor.bind(gate); editor.changed(); await new Promise(r => setTimeout(r, 0)); assert.deepEqual(calls, []);
  finish(); await editor.navigate('definition', { line: 0, character: 0 });
  assert.deepEqual(calls, ['sync', 'navigate']);
});

test('history flushes before requesting a cross-file move and rejects failed flush', async () => {
  const calls: string[] = []; let fail = false;
  const editor = new EditorNavigation(async method => { calls.push(method); }, () => 'text', async () => { calls.push('flush'); if (fail) throw new Error('conflict'); });
  editor.bind(); await editor.history('back', { line: 3, character: 4 });
  assert.deepEqual(calls, ['flush', 'history']);
  fail = true; await assert.rejects(() => editor.history('forward', { line: 0, character: 0 }), /conflict/);
  assert.deepEqual(calls, ['flush', 'history', 'flush']);
});

test('reconnect clears failed attach gate and restores querying', async () => {
  const calls: string[] = [];
  const editor = new EditorNavigation(async method => { calls.push(method); return { query: 1, locations: [] }; }, () => 'x', async () => {});
  editor.bind(Promise.reject(new Error('startup failed')));
  await assert.rejects(() => editor.navigate('definition', { line: 0, character: 0 }), /startup failed/);
  await editor.reconnect();
  await editor.navigate('definition', { line: 0, character: 0 });
  assert.deepEqual(calls, ['reconnect', 'navigate']);
});

test('queued edits from an old binding never run on a new binding', async () => {
  let finish!: () => void; const ready = new Promise<void>(r => { finish = r; }); const calls: string[] = [];
  const editor = new EditorNavigation(async (method, input) => { calls.push(method + ':' + input.text); }, () => 'old', async () => {});
  editor.bind(ready); editor.changed(); editor.unbind(); editor.bind(); finish();
  await new Promise(r => setTimeout(r, 0)); assert.deepEqual(calls, []);
});

test('navigation opening uses the clicked position as the history source', async () => {
  let openInput: any;
  const editor = new EditorNavigation(async (method, input) => { if (method === 'open') openInput = input; return { query: 1, locations: [] }; }, () => '', async () => {});
  editor.bind();
  await editor.open(1, { uri: 'file:///target.go', line: 0, character: 0 }, { line: 2, character: 4 });
  assert.deepEqual(openInput.source, { line: 2, character: 4 });
});

test('queued reconnect from old binding cannot reconnect the new binding', async () => {
  let finish!: () => void; const gate = new Promise<void>(r => { finish = r; });
  const calls: string[] = [];
  const editor = new EditorNavigation(async method => { calls.push(method); }, () => '', async () => {});
  editor.bind(gate); const old = editor.reconnect(); editor.unbind(); editor.bind(); finish();
  await assert.rejects(old, /stale/i); assert.deepEqual(calls, []);
});

test('multi-result selection retains the original clicked source', async () => {
  let openInput: any;
  const locations = [{ uri: 'file:///one.go', line: 0, character: 0 }, { uri: 'file:///two.go', line: 2, character: 1 }];
  const editor = new EditorNavigation(async (method, input) => { if (method === 'navigate') return { query: 3, locations }; if (method === 'open') openInput = input; }, () => '', async () => {});
  editor.bind(); const result = await editor.navigate('definition', { line: 4, character: 6 });
  await editor.open(result.query, result.locations[1]);
  assert.deepEqual(openInput.source, { line: 4, character: 6 });
});

test('edits discard pending queries, and flush failure never opens', async () => {
  let finish!: (value: any) => void; const calls: string[] = [];
  const editor = new EditorNavigation(async (method) => { calls.push(method); if (method === 'navigate') return new Promise(resolve => { finish = resolve; }); return null; }, () => 'x', async () => { throw new Error('conflict'); });
  editor.bind(); const pending = editor.navigate('definition', { line: 0, character: 0 });
  await new Promise(r => setTimeout(r, 0)); editor.changed(); finish({ query: 1, locations: [] });
  await assert.rejects(pending, /stale/i);
  await assert.rejects(() => editor.open(1, { uri: 'file:///x', line: 0, character: 0 }), /conflict/);
  assert.equal(calls.includes('open'), false);
});
