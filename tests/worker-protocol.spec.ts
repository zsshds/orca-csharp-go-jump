import { test } from 'node:test';
import assert from 'node:assert/strict';
import activate, { deactivate } from '../src/worker';

test('worker registers the panel protocol and uses the caller identity', async () => {
  const handlers = new Map<string, Function>();
  const api = {
    panels: { handle: (name: string, fn: Function) => { handlers.set(name, fn); return { dispose() {} }; } },
    host: { call: async (method: string) => method === 'workspace.list' ? { workspaces: [], truncated: false } : { settings: {} } },
    log: () => {},
  };
  activate(api as any);
  for (const name of ['workspaces', 'discover', 'projects', 'attach', 'sync', 'navigate', 'open', 'reconnect', 'detach']) assert.equal(typeof handlers.get(name), 'function');
  assert.deepEqual(await handlers.get('workspaces')!(null, { panel: { id: 'a', surface: 'editor' } }), []);
  await assert.rejects(() => handlers.get('sync')!({ text: 'x', version: 1, bindingToken: 'old' }, { panel: { id: 'unbound', surface: 'editor' } }), /not bound/);
  await deactivate();
});
