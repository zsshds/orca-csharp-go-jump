import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rename, symlink, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { NavigationWorker } from '../src/navigation-worker';

test('binding requires explicit choices; sync, query and open enforce panel and version', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-nav-')));
  try {
    await writeFile(path.join(root, 'go.mod'), 'module a');
    const file = path.join(root, 'main.go'); await writeFile(file, '你好😀\nmain');
    const log: any[] = [];
    let finish!: (v: unknown) => void;
    const service = {
      open: async (...args: unknown[]) => { log.push(['open', ...args]); },
      change: async (...args: unknown[]) => { log.push(['change', ...args]); },
      request: async (...args: unknown[]) => { log.push(['request', ...args]); return new Promise(r => { finish = r; }); },
      close: async () => {}, dispose: async () => {}, reconnect: async () => { log.push(['reconnect']); },
    };
    const w = new NavigationWorker({
      workspaces: async () => [{ id: 'one', path: root, name: 'one', hostId: null }],
      start: async () => service,
      executable: async () => 'gopls',
      openFile: async (...args: unknown[]) => { log.push(['cli', ...args]); },
    });
    assert.equal((await w.workspaces()).length, 1);
    const found = await w.discover('panel', 'one', '你好😀\nmain', '.go');
    assert.deepEqual(found.exactMatches, [await (await import('node:fs/promises')).realpath(file)]);
    await assert.rejects(() => w.bind('panel', 'one', path.join(root, 'other.go'), root, '你好😀\nmain', 1));
    const projects = await w.projects('panel', file);
    assert.equal(projects.length, 1);
    await w.bind('panel', 'one', file, projects[0].directory, '你好😀\nmain', 1, 'new');
    await assert.rejects(() => w.sync('panel', 'old data', 2, 'old'), /binding/i);
    assert.throws(() => w.assertBinding('panel', 'old'), /binding/i);
    assert.doesNotThrow(() => w.assertBinding('panel', 'new'));
    await w.sync('panel', '你好😀\nmain!', 2, 'new');
    const p = w.navigate('panel', 'definition', { line: 0, character: 4 }, 2);
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(log.at(-1)[2].position, { line: 0, character: 4 });
    finish([{ uri: pathToFileURL(file).href, range: { start: { line: 1, character: 1 } } }]);
    const result = await p;
    await assert.rejects(() => w.open('other-panel', result.query, 2, result.locations[0]));
    assert.equal((await w.preview('panel', result.query, 2, result.locations[0])).includes('main'), true);
    await assert.rejects(() => w.preview('other-panel', result.query, 2, result.locations[0]));
    await w.open('panel', result.query, 2, result.locations[0]);
    const pendingReveal = await w.pendingReveals('panel');
    assert.equal(pendingReveal.length, 1);
    assert.deepEqual(await w.claimReveal('panel', pendingReveal[0].id), result.locations[0]);
    assert.deepEqual(await w.pendingReveals('panel'), []);
    assert.equal(log.at(-1)[0], 'cli');
    assert.equal(log.at(-1)[2], 'one');
    await w.sync('panel', 'new', 3, 'new');
    await assert.rejects(() => w.open('panel', result.query, 2, result.locations[0]));
    await w.reconnect('panel');
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reconnect rereads executable and reopens every shared document', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-path-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go');
    await writeFile(a, 'a'); await writeFile(b, 'b');
    let executable = 'first'; const events: string[] = [];
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], executable: async () => executable, openFile: async () => {}, start: async (_root, exe) => {
      const id = String(exe); events.push(`start:${id}`);
      return { open: async (uri, _lang, text) => { events.push(`open:${id}:${path.basename(uri)}:${text}`); }, change: async () => {}, request: async () => [], close: async () => {}, reconnect: async () => { events.push(`reconnect:${id}`); }, dispose: async () => { events.push(`dispose:${id}`); } };
    } });
    for (const [panel, file, text] of [['a', a, 'a'], ['b', b, 'b']]) { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); }
    await w.sync('b', 'unsaved', 2); executable = 'second'; await w.reconnect('a');
    assert.ok(events.includes('dispose:first')); assert.ok(events.includes('start:second'));
    assert.ok(events.includes('open:second:a.go:a')); assert.ok(events.includes('open:second:b.go:unsaved'));
    await w.dispose(); assert.ok(events.includes('dispose:second'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed replacement leaves old service disposed and retry restores members', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-retry-')));
  try {
    const file = path.join(root, 'a.go'); await writeFile(file, 'a');
    let executable = 'first'; const events: string[] = [];
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], executable: async () => executable, openFile: async () => {}, start: async (_root, exe) => {
      const id = String(exe); events.push(`start:${id}`); if (id === 'bad') throw new Error('startup failed');
      return { open: async (_uri, _language, text) => { events.push(`open:${id}:${text}`); }, change: async () => {}, request: async () => [], close: async () => {}, reconnect: async () => {}, dispose: async () => { events.push(`dispose:${id}`); } };
    } });
    await w.discover('a', 'x', 'a', '.go'); await w.projects('a', file); await w.bind('a', 'x', file, root, 'a', 1);
    executable = 'bad'; await assert.rejects(w.reconnect('a'), /startup failed/); assert.ok(events.includes('dispose:first'));
    executable = 'good'; await w.reconnect('a'); assert.ok(events.includes('open:good:a'));
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1); await w.dispose(); assert.ok(events.includes('dispose:good'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('edits during slow startup are synced and detach disposes a starting server', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-race-')));
  try {
    const file = path.join(root, 'a.go'); await writeFile(file, 'old');
    let started!: (s: any) => void; const calls: string[] = [];
    const service = { open: async (_u: string, _l: string, t: string) => { calls.push('open:' + t); }, change: async (_u: string, t: string) => { calls.push('change:' + t); }, request: async () => null, close: async () => {}, dispose: async () => { calls.push('dispose'); }, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => new Promise(r => { started = r; }), executable: async () => 'gopls', openFile: async () => {} });
    await w.discover('p', 'x', 'old', '.go'); await w.projects('p', file);
    const binding = w.bind('p', 'x', file, root, 'old', 1); await new Promise(r => setTimeout(r, 10));
    const update = w.sync('p', 'new', 2); started(service); await binding; await update;
    assert.deepEqual(calls, ['open:old', 'change:new']);
    await w.dispose();
    await w.discover('p', 'x', 'old', '.go'); await w.projects('p', file);
    const binding2 = w.bind('p', 'x', file, root, 'old', 1); await new Promise(r => setTimeout(r, 10));
    const detached = w.detach('p'); started(service);
    await assert.rejects(binding2); await detached;
    assert.equal(calls.filter(x => x === 'dispose').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cross-file history survives panel binding, branches and failed opens', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-history-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go'), c = path.join(root, 'c.go');
    await writeFile(a, 'a'); await writeFile(b, 'b'); await writeFile(c, 'c');
    const loc = (file: string, line = 0) => ({ uri: pathToFileURL(file).href, line, character: 0 });
    let targets = [loc(b)]; let fail = false; const opened: string[] = [];
    const service = { open: async () => {}, change: async () => {}, request: async () => targets.map(v => ({ uri: v.uri, range: { start: v } })), close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => service, executable: async () => 'gopls', openFile: async file => { if (fail) throw new Error('failed'); opened.push(file); } });
    const bind = async (panel: string, file: string, text: string) => { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); };
    await bind('a', a, 'a');
    const result = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.open('a', result.query, 1, result.locations[0], { line: 0, character: 0 });
    await bind('b', b, 'b');
    const handoffs = await w.pendingReveals('b');
    await w.claimReveal('b', handoffs[0].id);
    await assert.rejects(() => w.history('a', 'back', { line: 0, character: 0 }), /history/i);
    fail = true; await assert.rejects(() => w.history('b', 'back', { line: 0, character: 0 }), /failed/);
    fail = false; await w.history('b', 'back', { line: 0, character: 0 });
    assert.equal(opened.at(-1), a);
    const back = await w.pendingReveals('a'); await w.claimReveal('a', back.at(-1)!.id);
    await w.history('a', 'forward', { line: 0, character: 0 }); assert.equal(opened.at(-1), b);
    const forward = await w.pendingReveals('b'); await w.claimReveal('b', forward.at(-1)!.id);
    await w.history('b', 'back', { line: 0, character: 0 });
    const again = await w.pendingReveals('a'); await w.claimReveal('a', again.at(-1)!.id);
    targets = [loc(c)]; const next = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.open('a', next.query, 1, next.locations[0], { line: 0, character: 0 });
    await assert.rejects(() => w.history('a', 'forward', { line: 0, character: 0 }), /history/i);
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('history rejects an earlier target replaced with an outside junction', async () => {
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-boundary-')));
  try {
    const root = path.join(tmp, 'root'), dir = path.join(root, 'dir'), outside = path.join(tmp, 'outside');
    await mkdir(root); await mkdir(dir); await mkdir(outside);
    const a = path.join(dir, 'a.go'), b = path.join(root, 'b.go');
    await writeFile(a, 'a'); await writeFile(b, 'b'); await writeFile(path.join(outside, 'a.go'), 'external');
    const service = { open: async () => {}, change: async () => {}, request: async () => ({ uri: pathToFileURL(b).href, range: { start: { line: 0, character: 0 } } }), close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    let opens = 0;
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => service, executable: async () => 'gopls', openFile: async () => { opens++; } });
    await w.discover('a', 'x', 'a', '.go'); await w.projects('a', a); await w.bind('a', 'x', a, root, 'a', 1);
    const result = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1); await w.open('a', result.query, 1, result.locations[0]);
    await w.discover('b', 'x', 'b', '.go'); await w.projects('b', b); await w.bind('b', 'x', b, root, 'b', 1);
    const handoffs = await w.pendingReveals('b'); await w.claimReveal('b', handoffs[0].id);
    await rename(dir, path.join(root, 'old-dir')); await symlink(outside, dir, 'junction');
    await assert.rejects(() => w.history('b', 'back', { line: 0, character: 0 }), /outside/); assert.equal(opens, 1);
    await w.dispose();
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('panels in one project share unsaved documents and retain service until last detach', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-shared-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go'); await writeFile(a, 'a'); await writeFile(b, 'b');
    let starts = 0, disposes = 0; const documents = new Map<string, string>();
    const service = { open: async (uri: string, _lang: string, text: string) => { documents.set(uri, text); }, change: async (uri: string, text: string) => { documents.set(uri, text); }, request: async () => { assert.equal(documents.get(pathToFileURL(b).href), 'unsaved'); return []; }, close: async (uri: string) => { documents.delete(uri); }, dispose: async () => { disposes++; }, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => { starts++; return service; }, executable: async () => 'gopls', openFile: async () => {} });
    for (const [panel, file, text] of [['a', a, 'a'], ['b', b, 'b']]) { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); }
    await w.sync('b', 'unsaved', 2);
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    assert.equal(starts, 1);
    await w.discover('duplicate', 'x', 'a', '.go'); await w.projects('duplicate', a);
    await assert.rejects(() => w.bind('duplicate', 'x', a, root, 'different', 1), /conflicting/);
    await w.detach('duplicate'); assert.equal(documents.get(pathToFileURL(a).href), 'a');
    await w.detach('a'); assert.equal(disposes, 0); await w.detach('b'); assert.equal(disposes, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cross-root unsaved peer blocks queries, recovery works, and concurrent edits invalidate results', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-cross-root-')));
  try {
    const ar = path.join(root, 'a'), br = path.join(root, 'b'); await mkdir(ar); await mkdir(br);
    await writeFile(path.join(ar, 'go.mod'), 'module a'); await writeFile(path.join(br, 'go.mod'), 'module b');
    const a = path.join(ar, 'a.go'), b = path.join(br, 'b.go'); await writeFile(a, 'a'); await writeFile(b, 'b');
    let finish!: (value: unknown) => void, pending = false, requests = 0;
    const makeServer = () => ({ open: async () => {}, change: async () => {}, request: async () => { requests++; return pending ? new Promise(r => { finish = r; }) : []; }, close: async () => {}, dispose: async () => {}, reconnect: async () => {} });
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }, { id: 'other', path: root, name: 'other', hostId: null }], start: async () => makeServer(), executable: async () => 'gopls', openFile: async () => {} });
    for (const [panel, file, dir, text] of [['a', a, ar, 'a'], ['b', b, br, 'b']]) { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, dir, text, 1); }
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.sync('b', 'dirty', 2);
    await assert.rejects(w.navigate('a', 'definition', { line: 0, character: 0 }, 1), /another project.*unsaved/i);
    assert.equal(requests, 1);
    await writeFile(b, 'dirty'); await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    pending = true; const query = w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    while (!finish) await new Promise(r => setTimeout(r, 0));
    await w.sync('b', 'new dirty', 3); finish([]); await assert.rejects(query, /stale/i);
    pending = false; await w.sync('b', 'dirty', 4);
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.sync('b', 'unsaved again', 5); await w.detach('b');
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.discover('other', 'other', 'dirty', '.go'); await w.projects('other', b);
    await w.bind('other', 'other', b, br, 'different workspace draft', 1);
    await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project root aliases share a language server', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-alias-')));
  try {
    const project = path.join(root, 'project'), alias = path.join(root, 'alias'); await mkdir(project); await symlink(project, alias, 'junction');
    await writeFile(path.join(project, 'go.mod'), 'module x'); await writeFile(path.join(project, 'a.go'), 'a'); await writeFile(path.join(project, 'b.go'), 'b');
    let starts = 0;
    const server = { open: async () => {}, change: async () => {}, request: async () => [], close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => { starts++; return server; }, executable: async () => 'gopls', openFile: async () => {} });
    for (const [panel, file, dir, text] of [['a', path.join(project, 'a.go'), project, 'a'], ['b', path.join(alias, 'b.go'), alias, 'b']]) { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, dir, text, 1); }
    assert.equal(starts, 1); await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('separate panels keep independent histories and each handoff has an explicit single-use id', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-handoffs-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go'), c = path.join(root, 'c.go');
    await writeFile(a, 'a'); await writeFile(b, 'b'); await writeFile(c, 'c');
    const uri = (file: string) => pathToFileURL(file).href;
    let line = 1;
    const server = { open: async () => {}, change: async () => {}, request: async () => ({ uri: uri(b), range: { start: { line: line++, character: 0 } } }), close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => server, executable: async () => 'gopls', openFile: async () => {} });
    const bind = async (panel: string, file: string, text: string) => { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); };
    await bind('a', a, 'a'); await bind('c', c, 'c');
    for (let i = 0; i < 2; i++) { const r = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1); await w.open('a', r.query, 1, r.locations[0]); }
    assert.deepEqual(await w.pendingReveals('c'), []);
    await assert.rejects(() => w.history('c', 'back', { line: 0, character: 0 }), /history/i);
    await bind('b', b, 'b'); const handoffs = await w.pendingReveals('b');
    assert.equal(handoffs.length, 2); assert.notEqual(handoffs[0].id, handoffs[1].id);
    await assert.rejects(() => w.claimReveal('c', handoffs[0].id), /match/i);
    assert.equal((await w.claimReveal('b', handoffs[1].id)).line, 2);
    await assert.rejects(() => w.claimReveal('b', handoffs[1].id));
    assert.equal((await w.pendingReveals('b')).length, 1);
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opening and closing peer documents invalidate existing results and pending queries', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-peers-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go'); await writeFile(a, 'a'); await writeFile(b, 'b');
    const aUri = pathToFileURL(a).href; let pending = false; let finish!: (value: unknown) => void;
    const location = { uri: aUri, range: { start: { line: 0, character: 0 } } };
    const server = { open: async () => {}, change: async () => {}, request: async () => pending ? new Promise(r => { finish = r; }) : [location], close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => server, executable: async () => 'gopls', openFile: async () => {} });
    const bind = async (panel: string, file: string, disk: string, text: string) => { await w.discover(panel, 'x', disk, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); };
    await bind('a', a, 'a', 'a');
    const first = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await bind('b', b, 'b', 'unsaved B');
    await assert.rejects(() => w.open('a', first.query, 1, first.locations[0]), /current query/i);
    const second = await w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await w.detach('b');
    await assert.rejects(() => w.open('a', second.query, 1, second.locations[0]), /current query/i);
    await bind('b', b, 'b', 'unsaved B');
    pending = true; const inFlight = w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await new Promise(r => setTimeout(r, 0)); await w.detach('b'); finish([location]);
    await assert.rejects(inFlight, /stale/i);
    const inFlight2 = w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    await new Promise(r => setTimeout(r, 0)); await bind('b', b, 'b', 'unsaved B'); finish([location]);
    await assert.rejects(inFlight2, /stale/i);
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queries started during peer open or close run after the lifecycle barrier', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-barrier-')));
  try {
    const a = path.join(root, 'a.go'), b = path.join(root, 'b.go'); await writeFile(a, 'a'); await writeFile(b, 'b');
    let release!: () => void, entered!: () => void, gate: Promise<void> | undefined, started: Promise<void> | undefined;
    const delay = () => { gate = new Promise(r => { release = r; }); started = new Promise(r => { entered = r; }); };
    const server = { open: async (uri: string) => { if (uri === pathToFileURL(b).href && gate) { entered(); await gate; } }, change: async () => {}, request: async () => [], close: async () => { if (gate) { entered(); await gate; } }, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => server, executable: async () => 'gopls', openFile: async () => {} });
    const bind = async (panel: string, file: string, text: string) => { await w.discover(panel, 'x', text, '.go'); await w.projects(panel, file); await w.bind(panel, 'x', file, root, text, 1); };
    await bind('a', a, 'a'); delay(); const adding = bind('b', b, 'b'); await started;
    const duringOpen = w.navigate('a', 'definition', { line: 0, character: 0 }, 1); release(); await adding;
    assert.deepEqual((await duringOpen).locations, []);
    delay(); const removing = w.detach('b'); await started;
    const duringClose = w.navigate('a', 'definition', { line: 0, character: 0 }, 1); release(); await removing;
    assert.deepEqual((await duringClose).locations, []);
    gate = undefined; await bind('b', b, 'b'); delay(); const removingAgain = w.detach('b'); await started;
    const stale = w.navigate('a', 'definition', { line: 0, character: 0 }, 1);
    const staleRejected = assert.rejects(stale, /stale/i);
    const edited = w.sync('a', 'new', 2); release(); await removingAgain; await edited; await staleRejected;
    gate = undefined; await bind('b', b, 'b'); delay(); const removingThird = w.detach('b'); await started;
    const oldBinding = w.navigate('a', 'definition', { line: 0, character: 0 }, 2);
    const oldBindingRejected = assert.rejects(oldBinding, /stale/i);
    const detachA = w.detach('a'); release(); await removingThird; await detachA; await oldBindingRejected;
    gate = undefined; await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('late result is rejected after a document change', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worker-stale-')));
  try {
    const file = path.join(root, 'a.go'); await writeFile(file, 'x');
    let finish!: (v: unknown) => void;
    const service = { open: async () => {}, change: async () => {}, request: async () => new Promise(r => { finish = r; }), close: async () => {}, dispose: async () => {}, reconnect: async () => {} };
    const w = new NavigationWorker({ workspaces: async () => [{ id: 'x', path: root, name: 'x', hostId: null }], start: async () => service, executable: async () => 'gopls', openFile: async () => {} });
    await w.discover('p', 'x', 'x', '.go'); await w.projects('p', file); await w.bind('p', 'x', file, root, 'x', 1);
    const pending = w.navigate('p', 'references', { line: 0, character: 0 }, 1);
    await new Promise(r => setTimeout(r, 0));
    await w.sync('p', 'y', 2); finish([]);
    await assert.rejects(pending, /stale/i);
    await w.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
