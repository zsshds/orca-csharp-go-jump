import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLocations, QueryResults, NavigationHistory } from '../src/navigation';

test('normalizes locations and links without changing UTF-16 positions', () => {
  const uri = pathToFileURL(path.resolve('a.go')).href;
  const a = { line: 2, character: 5 };
  assert.deepEqual(normalizeLocations([{ uri, range: { start: a } }, { targetUri: uri, targetSelectionRange: { start: a } }]), [{ uri, line: 2, character: 5 }, { uri, line: 2, character: 5 }]);
  assert.deepEqual(normalizeLocations(null), []);
});

test('only current query results inside the real workspace can open', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'nav-'));
  try {
    const root = path.join(tmp, 'workspace'); await mkdir(root);
    const good = path.join(root, 'good.go'); const other = path.join(root, 'other.go'); const outside = path.join(tmp, 'outside.go');
    await Promise.all([good, other, outside].map(file => writeFile(file, 'hello')));
    const results = new QueryResults(root);
    const location = (file: string) => ({ uri: pathToFileURL(file).href, line: 0, character: 0 });
    const escaped = path.join(root, 'escape'); await symlink(tmp, escaped, 'junction');
    const escapedTarget = location(path.join(escaped, 'outside.go'));
    const token = results.begin(1);
    results.complete(token, 1, [location(good), location(outside), escapedTarget, { uri: 'https://example.com', line: 0, character: 0 }]);
    assert.equal(await results.authorize(token, 1, location(good)), await realpath(good));
    await assert.rejects(() => results.authorize(token, 1, location(other)));
    await assert.rejects(() => results.authorize(token, 1, location(outside)));
    await assert.rejects(() => results.authorize(token, 1, escapedTarget));
    await assert.rejects(() => results.authorize(token, 1, { uri: 'https://example.com', line: 0, character: 0 }));
    results.begin(2);
    await assert.rejects(() => results.authorize(token, 1, location(good)));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('late results and changed document versions cannot replace current results', () => {
  const results = new QueryResults('.');
  const first = results.begin(1); const second = results.begin(2);
  assert.equal(results.complete(first, 1, []), false);
  assert.equal(results.complete(second, 3, []), false);
  assert.equal(results.complete(second, 2, []), true);
});

test('history goes back and forward and drops the forward branch', () => {
  const history = new NavigationHistory();
  const a = { uri: 'file:///a', line: 0, character: 0 }, b = { uri: 'file:///b', line: 1, character: 2 }, c = { uri: 'file:///c', line: 0, character: 0 };
  history.push(a); history.push(b);
  assert.deepEqual(history.back(), a); assert.deepEqual(history.forward(), b);
  history.back(); history.push(c); assert.equal(history.forward(), undefined);
});
