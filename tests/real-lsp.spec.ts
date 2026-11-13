import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LanguageServer } from '../src/language-server';
import { normalizeLocations } from '../src/navigation';
import { executable, serverExecutable, hasLocation, realLspBudget, cleanupRealLsp } from './real-lsp-support';

// These tests launch real programs only after explicit opt-in. No installer is run.
const enabled = process.env.ORCA_REAL_LSP_TEST === '1';
function position(text: string, needle: string) {
  const offset = text.indexOf(needle);
  assert.notEqual(offset, -1, `missing fixture marker ${needle}`);
  const lines = text.slice(0, offset).split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

for (const language of ['go', 'csharp'] as const) {
  test(`real ${language} server: cross-file navigation and unsaved Unicode`, { timeout: realLspBudget.testTimeoutMs }, async t => {
    const deadline = Date.now() + realLspBudget.deadlineMs;
    if (!enabled) { t.skip('Set ORCA_REAL_LSP_TEST=1 to run installed real servers; no dependencies are installed'); return; }
    const variableName = language === 'go' ? 'GOPLS_PATH' : 'CSHARP_LS_PATH';
    const serverPath = await serverExecutable(language === 'go' ? 'gopls' : 'csharp-ls', process.env[variableName], variableName);
    const sdk = await executable(language === 'go' ? 'go' : 'dotnet');
    if (!serverPath || !sdk) { t.skip(`Missing ${!serverPath ? (language === 'go' ? 'gopls' : 'csharp-ls') : (language === 'go' ? 'Go' : '.NET SDK')} on PATH`); return; }
    const root = await mkdtemp(join(tmpdir(), 'orca-real-lsp-'));
    let server: LanguageServer | undefined;
    let child: ChildProcess | undefined;
    let primaryError: unknown;
    let failed = false;
    try {
      await cp(fileURLToPath(new URL(`./fixtures/real-${language}/`, import.meta.url)), root, { recursive: true });
      const definitionName = language === 'go' ? 'speaker.go' : 'Speaker.cs';
      const usageName = language === 'go' ? 'usage.go' : 'Usage.cs';
      const definitionUri = pathToFileURL(join(root, definitionName)).href;
      const usageUri = pathToFileURL(join(root, usageName)).href;
      const definition = await readFile(join(root, definitionName), 'utf8');
      const usage = await readFile(join(root, usageName), 'utf8');
      server = await LanguageServer.start(root, serverPath, { timeoutMs: realLspBudget.requestTimeoutMs });
      // Production API exposes no process-exit promise; capture the current child for best-effort cleanup.
      child = (server as unknown as { process?: ChildProcess }).process;
      await server.open(definitionUri, language, definition);
      await server.open(usageUri, language, usage);
      const interfaceName = language === 'go' ? 'Speaker' : 'ISpeaker';
      const usageInterface = position(usage, interfaceName);
      const interfaceDefinition = position(definition, interfaceName);
      const variable = position(usage, language === 'go' ? 'speaker.Speak' : 'speaker.Speak');
      const query = async (method: string, uri: string, pos: { line: number; character: number }) => {
        const params = { textDocument: { uri }, position: pos, ...(method === 'references' ? { context: { includeDeclaration: true } } : {}) };
        return normalizeLocations(await server!.request(`textDocument/${method}`, params));
      };
      // Project loading is asynchronous. Retry empty results, but never convert errors into skips.
      const expectLocation = async (method: string, uri: string, pos: { line: number; character: number }, expectedUri: string, expectedPosition: { line: number; character: number }) => {
        let found = false;
        while (!found && Date.now() < deadline) {
          const locations = await query(method, uri, pos);
          found = hasLocation(locations, { uri: expectedUri, ...expectedPosition });
          if (!found && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, realLspBudget.pollMs));
        }
        assert.ok(found, `${language} ${method} did not return expected ${expectedUri}:${expectedPosition.line}:${expectedPosition.character} before the shared deadline`);
      };
      await expectLocation('definition', usageUri, usageInterface, definitionUri, interfaceDefinition);
      await expectLocation('typeDefinition', usageUri, variable, definitionUri, interfaceDefinition);
      await expectLocation('implementation', definitionUri, interfaceDefinition, definitionUri, position(definition, 'Greeter'));
      await expectLocation('references', definitionUri, interfaceDefinition, usageUri, usageInterface);
      // The new reference exists only in didChange, after Unicode (including a surrogate pair).
      const extra = language === 'go' ? '\n/* 中文 😀 */ var another Speaker\n' : '\npublic class Extra { /* 中文 😀 */ ISpeaker field; }\n';
      const unsaved = usage + extra;
      await server.change(usageUri, unsaved);
      const marker = language === 'go' ? 'another Speaker' : 'ISpeaker field';
      const reference = position(unsaved, marker);
      if (language === 'go') reference.character += 'another '.length;
      await expectLocation('references', definitionUri, interfaceDefinition, usageUri, reference);
      assert.equal(await readFile(join(root, usageName), 'utf8'), usage, 'unsaved change must not modify fixture on disk');
    } catch (error) {
      primaryError = error;
      failed = true;
    } finally {
      await cleanupRealLsp({ root, child, dispose: server ? () => server!.dispose() : undefined, primaryError, hasPrimaryError: failed });
    }
  });
}
