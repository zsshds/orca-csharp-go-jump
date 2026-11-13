import type { OrcaWorkerApi } from 'orca/worker';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LanguageServer } from './language-server';
import { NavigationWorker } from './navigation-worker';

const execFileAsync = promisify(execFile);
let worker: NavigationWorker | undefined;

export default function activate(orca: OrcaWorkerApi): void {
  const instance = new NavigationWorker({
    workspaces: async () => {
      const result = await orca.host.call('workspace.list');
      if (result.truncated) throw new Error('Workspace list is incomplete');
      return result.workspaces;
    },
    executable: async language => {
      const { settings } = await orca.host.call('settings.get');
      const value = settings[language === 'go' ? 'goServerPath' : 'csharpServerPath'];
      return typeof value === 'string' && value.trim() ? value.trim() : language === 'go' ? 'gopls' : 'csharp-ls';
    },
    start: (root, executable) => LanguageServer.start(root, executable),
    revealAvailable: panel => orca.panels.post('revealAvailable', null, { panel }),
    openFile: async (file, id, location) => {
      const result = await orca.host.call('workspace.list');
      const workspace = result.workspaces.find(w => w.id === id && w.hostId === null);
      if (result.truncated || !workspace) throw new Error('Local workspace is no longer available');
      // On Windows execute the native binary rather than a cmd shim. Never invoke a shell.
      await execFileAsync(process.platform === 'win32' ? 'orca.exe' : 'orca', [
        'file', 'open', file, '--line', String(location.line + 1), '--column', String(location.character + 1),
        '--worktree', `path:${workspace.path}`, '--focus', '--environment', 'local', '--json',
      ], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    },
  });
  worker = instance;
  const handle = (name: string, run: (panel: string, input: any) => unknown) => {
    orca.panels.handle(name, async (input, context) => {
      if (context.panel.surface !== 'editor') throw new Error('Only editor panels may use navigation');
      return run(context.panel.id, input ?? {});
    });
  };
  handle('workspaces', () => instance.workspaces());
  handle('discover', (p, i) => instance.discover(p, i.workspaceId, i.text, i.extension));
  handle('projects', (p, i) => instance.projects(p, i.file));
  handle('attach', (p, i) => {
    if (typeof i.bindingToken !== 'string' || !i.bindingToken) throw new Error('Binding token required');
    return instance.bind(p, i.workspaceId, i.file, i.root, i.text, i.version, i.bindingToken);
  });
  const bound = (name: string, run: (panel: string, input: any) => unknown) => handle(name, (p, i) => { instance.assertBinding(p, i.bindingToken); return run(p, i); });
  bound('sync', (p, i) => instance.sync(p, i.text, i.version, i.bindingToken));
  bound('navigate', (p, i) => instance.navigate(p, i.method, i.position, i.version));
  bound('preview', (p, i) => instance.preview(p, i.query, i.version, i.location));
  bound('open', (p, i) => instance.open(p, i.query, i.version, i.location, i.source));
  bound('history', (p, i) => instance.history(p, i.direction, i.source, i.version));
  bound('reconnect', p => instance.reconnect(p));
  bound('pendingReveals', p => instance.pendingReveals(p));
  bound('claimReveal', (p, i) => instance.claimReveal(p, i.id));
  handle('detach', (p, i) => { if (i.bindingToken) instance.assertBinding(p, i.bindingToken); return instance.detach(p); });
}

export async function deactivate(): Promise<void> {
  const current = worker; worker = undefined;
  await current?.dispose();
}
