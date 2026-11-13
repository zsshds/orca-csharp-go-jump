import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as mutableFs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolveDocument, findProjectRoot, discoverDocuments, findProjectRoots } from '../src/project.js';

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orca-project-')));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'workspace-other');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  try { await run(root, outside); } finally { await fs.rm(base, { recursive: true, force: true }); }
}
async function put(file: string, text = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

test('unreadable entries preserve candidates and report incomplete scan', async () => fixture(async root => {
  await put(path.join(root, 'good.go'), 'x'); await put(path.join(root, 'bad.go'), 'x');
  const original = mutableFs.readFile;
  (mutableFs as any).readFile = async (file: any, ...args: any[]) => {
    if (String(file).endsWith('bad.go')) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    return (original as any)(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    const result = await discoverDocuments(root, 'x', '.go');
    assert.deepEqual(result.exactMatches, [path.join(root, 'good.go')]);
    assert.equal(result.complete, false);
    assert.equal(result.errors[0].path, path.join(root, 'bad.go'));
    assert.match(result.errors[0].reason, /EACCES|access denied/);
    await assert.rejects(resolveDocument(root, 'x', '.go'));
  } finally { (mutableFs as any).readFile = original; syncBuiltinESMExports(); }
}));

test('resolves exact content and retains every candidate of the requested extension', async () => fixture(async root => {
  await put(path.join(root, 'a.go'), 'same\n');
  await put(path.join(root, 'nested', 'b.go'), 'same\n');
  await put(path.join(root, 'c.go'), 'same');
  await put(path.join(root, 'd.cs'), 'same\n');
  assert.deepEqual((await resolveDocument(root, 'same\n', '.go')).sort(), [path.join(root, 'a.go'), path.join(root, 'nested', 'b.go')].sort());
  assert.deepEqual(await resolveDocument(root, 'missing', '.go'), []);
}));

test('skips dependency directories and symlinks escaping the real workspace', async () => fixture(async (root, outside) => {
  await put(path.join(root, 'src', 'a.go'), 'match');
  await put(path.join(root, 'node_modules', 'bad.go'), 'match');
  await put(path.join(root, 'vendor', 'bad.go'), 'match');
  await put(path.join(root, 'bin', 'bad.go'), 'match');
  await put(path.join(root, 'build', 'source.go'), 'match');
  await put(path.join(outside, 'escape.go'), 'match');
  await fs.symlink(outside, path.join(root, 'escape'), 'junction');
  const result = await discoverDocuments(root, 'match', '.go');
  assert.deepEqual(result.exactMatches, [path.join(root, 'bin', 'bad.go'), path.join(root, 'build', 'source.go'), path.join(root, 'src', 'a.go'), path.join(root, 'vendor', 'bad.go')].sort());
  assert.equal(result.complete, false);
  await assert.rejects(resolveDocument(root, 'match', '.go'));
  await assert.rejects(findProjectRoot(path.join(root, 'escape', 'escape.go'), root));
}));

test('prefers an enclosing Go workspace marker and falls back to workspace', async () => fixture(async root => {
  const file = path.join(root, 'module', 'pkg', 'x.go');
  await put(file);
  await put(path.join(root, 'go.work'));
  assert.equal(await findProjectRoot(file, root), root);
  await put(path.join(root, 'module', 'go.mod'));
  assert.equal(await findProjectRoot(file, root), root);
  assert.deepEqual((await findProjectRoots(file, root)).map(x => x.directory), [path.join(root, 'module'), root]);
  await fs.rm(path.join(root, 'module', 'go.mod'));
  await fs.rm(path.join(root, 'go.work'));
  assert.equal(await findProjectRoot(file, root), root);
}));

test('prefers an enclosing C# solution and stays inside workspace', async () => fixture(async (root, outside) => {
  const file = path.join(root, 'project', 'src', 'a.cs');
  await put(file);
  await put(path.join(outside, 'outer.sln'));
  await put(path.join(root, 'root.sln'));
  assert.equal(await findProjectRoot(file, root), root);
  await put(path.join(root, 'project', 'app.csproj'));
  assert.equal(await findProjectRoot(file, root), root);
  assert.deepEqual((await findProjectRoots(file, root)).map(x => x.directory), [path.join(root, 'project'), root]);
  await fs.rm(path.join(root, 'project', 'app.csproj'));
  await fs.rm(path.join(root, 'root.sln'));
  await put(path.join(root, 'project', 'app.slnx'));
  assert.equal(await findProjectRoot(file, root), path.join(root, 'project'));
  await assert.rejects(findProjectRoot(path.join(outside, 'outer.cs'), root));
}));

test('offers explicit fallback candidates for unsaved text and marks incomplete scans', async () => fixture(async root => {
  await put(path.join(root, 'a.cs'), 'disk');
  await put(path.join(root, 'node_modules', 'hidden.cs'), 'edited');
  const result = await discoverDocuments(root, 'edited', '.cs');
  assert.deepEqual(result.exactMatches, []);
  assert.deepEqual(result.fallbackCandidates, [path.join(root, 'a.cs')]);
  assert.deepEqual(result.skippedDirectories, [path.join(root, 'node_modules')]);
  assert.equal(result.complete, false);
  const exact = await discoverDocuments(root, 'disk', '.cs');
  assert.deepEqual(exact.exactMatches, [path.join(root, 'a.cs')]);
  assert.deepEqual(exact.fallbackCandidates, []);
  assert.equal(exact.complete, false);
}));

test('includes in-workspace junction aliases without cycles and excludes escaping targets', async () => fixture(async (root, outside) => {
  await put(path.join(root, 'real', 'a.go'), 'text');
  await put(path.join(outside, 'x.go'), 'text');
  await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
  await fs.symlink(root, path.join(root, 'real', 'cycle'), 'junction');
  await fs.symlink(outside, path.join(root, 'escape'), 'junction');
  const result = await discoverDocuments(root, 'text', '.go');
  assert.deepEqual(result.exactMatches, [path.join(root, 'alias', 'a.go'), path.join(root, 'real', 'a.go')].sort());
  assert.equal(result.complete, true);
}));

test('keeps nonmatching candidates when another file matches unsaved text', async () => fixture(async root => {
  await put(path.join(root, 'a.cs'), 'old');
  await put(path.join(root, 'b.cs'), 'edited');
  const result = await discoverDocuments(root, 'edited', '.cs');
  assert.deepEqual(result.exactMatches, [path.join(root, 'b.cs')]);
  assert.deepEqual(result.fallbackCandidates, [path.join(root, 'a.cs')]);
}));

test('uses logical ancestors of an internal junction for project markers', async () => fixture(async root => {
  await put(path.join(root, 'shared', 'a.go'));
  await put(path.join(root, 'project', 'go.mod'));
  await fs.symlink(path.join(root, 'shared'), path.join(root, 'project', 'src'), 'junction');
  const file = path.join(root, 'project', 'src', 'a.go');
  assert.deepEqual(await findProjectRoots(file, root), [{ directory: path.join(root, 'project'), markers: ['go.mod'] }]);
  assert.equal(await findProjectRoot(file, root), path.join(root, 'project'));
}));

test('recognizes in-workspace linked project markers but not external targets', async t => fixture(async (root, outside) => {
  await put(path.join(root, 'markers', 'go-marker'));
  await put(path.join(root, 'markers', 'cs-marker'));
  await put(path.join(outside, 'external-marker'));
  await put(path.join(root, 'go', 'a.go'));
  await put(path.join(root, 'cs', 'a.cs'));
  try {
    await fs.symlink(path.join(root, 'markers', 'go-marker'), path.join(root, 'go', 'go.mod'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('Creating file symlinks requires privileges on this host');
    return;
  }
  await fs.symlink(path.join(root, 'markers', 'cs-marker'), path.join(root, 'cs', 'app.csproj'), 'file');
  await fs.symlink(path.join(outside, 'external-marker'), path.join(root, 'cs', 'external.sln'), 'file');
  assert.deepEqual(await findProjectRoots(path.join(root, 'go', 'a.go'), root), [{ directory: path.join(root, 'go'), markers: ['go.mod'] }]);
  assert.deepEqual(await findProjectRoots(path.join(root, 'cs', 'a.cs'), root), [{ directory: path.join(root, 'cs'), markers: ['app.csproj'] }]);
}));

test('checks linked marker targets before accepting them', async t => fixture(async (root, outside) => {
  const dir = path.join(root, 'project');
  await put(path.join(dir, 'a.cs'));
  await put(path.join(dir, 'app.csproj'));
  await put(path.join(dir, 'app.sln'));
  await put(path.join(dir, 'external.sln'));
  await put(path.join(outside, 'target'));
  const originalReaddir = mutableFs.readdir;
  const originalRealpath = mutableFs.realpath;
  t.mock.method(mutableFs, 'readdir', (async (...args: any[]) => {
    const entries = await (originalReaddir as any)(...args);
    if (args[0] !== dir || !args[1]?.withFileTypes) return entries;
    return entries.map((entry: any) => /\.(csproj|sln)$/.test(entry.name)
      ? { name: entry.name, isFile: () => false, isSymbolicLink: () => true } : entry);
  }) as typeof mutableFs.readdir);
  t.mock.method(mutableFs, 'realpath', (async (name: any, ...args: any[]) =>
    (originalRealpath as any)(name === path.join(dir, 'external.sln') ? path.join(outside, 'target') : name, ...args)
  ) as typeof mutableFs.realpath);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await findProjectRoots(path.join(dir, 'a.cs'), root), [{ directory: dir, markers: ['app.csproj', 'app.sln'] }]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}));

test('accepts discovered paths when the workspace itself is a junction', async () => fixture(async (root, outside) => {
  await put(path.join(root, 'go.mod'));
  await put(path.join(root, 'a.go'), 'text');
  const alias = path.join(outside, 'workspace-link');
  await fs.symlink(root, alias, 'junction');
  const result = await discoverDocuments(alias, 'text', '.go');
  assert.equal(await findProjectRoot(result.exactMatches[0], alias), root);
}));

test('terminates at a Windows drive root with different drive-letter casing', { skip: process.platform !== 'win32' }, async t => {
  const root = 'C:\\';
  const file = 'C:\\a.go';
  let reads = 0;
  t.mock.method(mutableFs, 'realpath', (async (name: any) => String(name).toLowerCase() === 'c:\\' ? root : file) as typeof mutableFs.realpath);
  t.mock.method(mutableFs, 'stat', (async (name: any) => ({
    isDirectory: () => String(name) === root,
    isFile: () => String(name) === file,
  })) as typeof mutableFs.stat);
  t.mock.method(mutableFs, 'readdir', (async () => {
    if (++reads > 2) throw new Error('drive root was scanned repeatedly');
    return [];
  }) as typeof mutableFs.readdir);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await findProjectRoots(file, 'c:\\'), []);
    assert.equal(reads, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('reports invalid workspaces and missing files rather than silently succeeding', async () => fixture(async root => {
  await assert.rejects(resolveDocument(path.join(root, 'missing'), '', '.cs'));
  await assert.rejects(findProjectRoot(path.join(root, 'missing.cs'), root));
  await assert.rejects(resolveDocument(path.join(root, 'not-directory.cs'), '', '.cs'));
}));
