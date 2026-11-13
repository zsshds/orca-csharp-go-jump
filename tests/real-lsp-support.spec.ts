import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executable, serverExecutable, hasLocation, realLspBudget, cleanupRealLsp } from './real-lsp-support';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('cleanup waits for child exit and retries transient directory locks', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  let attempts = 0;
  await cleanupRealLsp({
    child, dispose: async () => { child.kill(); }, root: 'test-only', timeoutMs: 4000, retryMs: 10,
    remove: async () => {
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'do not delete while child is running');
      if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    },
  });
  assert.equal(attempts, 3);
});

test('cleanup failure preserves original failure and is reported', async () => {
  const original = new Error('navigation failure');
  const logs: unknown[] = [];
  await assert.rejects(cleanupRealLsp({ root: 'test-only', primaryError: original, timeoutMs: 100, retryMs: 1,
    remove: async () => { throw new Error('cleanup failure'); }, report: error => logs.push(error),
  }), error => error === original);
  assert.equal(logs.length, 1);
  assert.match(String(logs[0]), /cleanup failure/);
});

test('cleanup has a bounded wait for an unresponsive disposal', async () => {
  const started = Date.now();
  await assert.rejects(cleanupRealLsp({ root: 'test-only', timeoutMs: 50, retryMs: 1,
    dispose: () => new Promise<void>(() => {}), remove: async () => {},
  }), /timed out/i);
  assert.ok(Date.now() - started < 2000);
});

test('overall timeout covers the shared deadline, in-flight request and cleanup reserve', () => {
  assert.ok(realLspBudget.deadlineMs > realLspBudget.requestTimeoutMs);
  assert.ok(realLspBudget.testTimeoutMs >= realLspBudget.deadlineMs + realLspBudget.requestTimeoutMs + realLspBudget.pollMs + realLspBudget.cleanupReserveMs);
});

test('explicit missing service path fails; absent default service may skip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-lsp-path-'));
  try {
    for (const variable of ['GOPLS_PATH', 'CSHARP_LS_PATH']) {
      await assert.rejects(serverExecutable('missing', join(root, 'missing.exe'), variable, [root], true), new RegExp(variable));
    }
    assert.equal(await serverExecutable('missing', undefined, 'GOPLS_PATH', [root], true), undefined);
    await assert.rejects(serverExecutable('missing', '', 'GOPLS_PATH', [root], true), /GOPLS_PATH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows PATH lookup detects a bat executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-lsp-bat-'));
  try {
    const path = join(root, 'gopls.bat');
    await writeFile(path, 'not executed');
    assert.equal(await executable('gopls', [root], true), path);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('navigation location requires exact URI, line and UTF-16 character', () => {
  const actual = [{ uri: 'file:///test', line: 2, character: 8 }];
  assert.equal(hasLocation(actual, { uri: 'file:///test', line: 2, character: 8 }), true);
  assert.equal(hasLocation(actual, { uri: 'file:///test', line: 2, character: 9 }), false);
  assert.equal(hasLocation(actual, { uri: 'file:///other', line: 2, character: 8 }), false);
  assert.equal(hasLocation(actual, { uri: 'file:///test', line: 3, character: 8 }), false);
});
