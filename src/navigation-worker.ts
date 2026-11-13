import * as path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { discoverDocuments, findProjectRoots } from './project';
import { normalizeLocations, QueryResults, type NavigationLocation } from './navigation';
import type { ServerExecutable } from './language-server';

export interface Workspace { id: string; name: string; path: string; hostId: string | null }
export interface Server {
  open(uri: string, language: string, text: string): Promise<void>;
  change(uri: string, text: string): Promise<void>;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  close(uri: string): Promise<void>;
  reconnect(): Promise<void>;
  dispose(): Promise<void>;
}
export interface WorkerDependencies {
  workspaces(): Promise<Workspace[]>;
  executable(language: 'go' | 'csharp'): Promise<ServerExecutable>;
  start(root: string, executable: ServerExecutable): Promise<Server>;
  openFile(file: string, workspace: string, location: NavigationLocation): Promise<void>;
  revealAvailable?(panel: string): void;
}
type Discovery = { workspace: Workspace; paths: Set<string>; extension: '.go' | '.cs'; projects?: { file: string; paths: Set<string> } };
type HistoryState = { entries: NavigationLocation[]; index: number; queue: Promise<unknown> };
type Shared = { server?: Server; members: Set<Binding>; queue: Promise<unknown>; failure?: unknown };
type Binding = { history: HistoryState; queryEpoch: number; token?: string; group?: Shared; workspace: Workspace; uri: string; language: 'go' | 'csharp'; root: string; text: string; version: number; results: QueryResults; server?: Server; syncing: Promise<void> };
type Handoff = { id: string; workspace: string; file: string; location: NavigationLocation; history: HistoryState };
const methods = { definition: 'textDocument/definition', typeDefinition: 'textDocument/typeDefinition', implementation: 'textDocument/implementation', references: 'textDocument/references' } as const;
export type NavigationMethod = keyof typeof methods;

/** A panel must select a discovery candidate and a project candidate explicitly. */
export class NavigationWorker {
  private discoveries = new Map<string, Discovery>();
  private bindings = new Map<string, Binding>();
  private bindingEpochs = new Map<string, number>();
  private groups = new Map<string, Shared>();
  private async groupKey(b: Binding): Promise<string> { return JSON.stringify([b.workspace.id, await realpath(b.workspace.path), await realpath(b.root), b.language]); }
  private groupOperation<T>(g: Shared, op: () => Promise<T>): Promise<T> {
    const next = g.queue.catch(() => {}).then(op); g.queue = next; return next;
  }
  private invalidateMembers(g: Shared): void {
    for (const member of g.members) member.results.begin(member.version);
  }
  private invalidateOtherProjects(b: Binding): void {
    for (const peer of this.bindings.values()) if (peer !== b && peer.workspace.id === b.workspace.id && peer.language === b.language && (!b.group || peer.group !== b.group)) {
      peer.queryEpoch++; peer.results.begin(peer.version);
    }
  }
  private async checkOtherProjects(b: Binding): Promise<void> {
    const peers = [...this.bindings.values()].filter(peer => peer !== b && peer.workspace.id === b.workspace.id && peer.language === b.language && (!b.group || peer.group !== b.group));
    for (const peer of peers) {
      const version = peer.version, text = peer.text;
      let disk: string;
      try { disk = await readFile(fileURLToPath(peer.uri), 'utf8'); }
      catch { throw new Error('Another project document cannot be checked for unsaved changes; save or close it before navigating'); }
      if (version !== peer.version || text !== peer.text) throw new Error('Stale navigation request: another project changed');
      if (text !== disk) throw new Error('Another project has unsaved changes; save or close its document before navigating');
    }
  }
  private reveals = new Map<string, Handoff>();
  private historyState(b: Binding): HistoryState { return b.history; }
  private async historyOperation<T>(b: Binding, op: (state: HistoryState) => Promise<T>): Promise<T> {
    const state = this.historyState(b);
    const next = state.queue.catch(() => {}).then(() => op(state));
    state.queue = next;
    return next;
  }
  private async checkedFile(b: Binding, location: NavigationLocation): Promise<string> {
    if (!Number.isSafeInteger(location.line) || location.line < 0 || !Number.isSafeInteger(location.character) || location.character < 0) throw new Error('Invalid position');
    let file: string;
    try { file = fileURLToPath(location.uri); } catch { throw new Error('Not a local file'); }
    const [root, real] = await Promise.all([realpath(b.workspace.path), realpath(file)]);
    const relative = path.relative(root, real);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || !(await stat(real)).isFile()) throw new Error('History target is outside the workspace');
    return real;
  }
  private rememberReveal(b: Binding, file: string, location: NavigationLocation, sourceHistory: HistoryState) {
    const id = randomUUID();
    const history: HistoryState = { entries: sourceHistory.entries.map(entry => ({ ...entry })), index: sourceHistory.index, queue: Promise.resolve() };
    this.reveals.set(id, { id, workspace: b.workspace.id, file, location: { ...location }, history });
    for (const [id, target] of this.bindings) if (target.workspace.id === b.workspace.id) {
      void realpath(fileURLToPath(target.uri)).then(real => { if (real === file && this.bindings.get(id) === target) this.deps.revealAvailable?.(id); }).catch(() => {});
    }
  }
  constructor(private readonly deps: WorkerDependencies) {}
  async workspaces(): Promise<Workspace[]> { return (await this.deps.workspaces()).filter(w => w.hostId === null && path.isAbsolute(w.path)); }
  async discover(panel: string, workspaceId: string, text: string, extension: '.go' | '.cs') {
    if (extension !== '.go' && extension !== '.cs') throw new Error('Unsupported extension');
    const workspace = (await this.workspaces()).find(w => w.id === workspaceId);
    if (!workspace) throw new Error('Local workspace not found');
    const found = await discoverDocuments(workspace.path, text, extension);
    this.discoveries.set(panel, { workspace, extension, paths: new Set([...found.exactMatches, ...found.fallbackCandidates]) });
    return found;
  }
  async projects(panel: string, file: string) {
    const discovery = this.discoveries.get(panel);
    if (!discovery?.paths.has(file)) throw new Error('File must be selected from discovery results');
    const projects = await findProjectRoots(file, discovery.workspace.path);
    if (!projects.some(p => path.relative(p.directory, discovery.workspace.path) === '')) projects.push({ directory: discovery.workspace.path, markers: [] });
    discovery.projects = { file, paths: new Set(projects.map(p => p.directory)) };
    return projects;
  }
  async bind(panel: string, workspaceId: string, file: string, root: string, text: string, version: number, token?: string) {
    const epoch = (this.bindingEpochs.get(panel) ?? 0) + 1;
    this.bindingEpochs.set(panel, epoch);
    const discovery = this.discoveries.get(panel);
    if (!discovery || discovery.workspace.id !== workspaceId || !discovery.paths.has(file) || discovery.projects?.file !== file || !discovery.projects.paths.has(root)) throw new Error('Explicit file and project selections required');
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid version');
    // Re-check both file and project paths immediately before using either.
    const current = await findProjectRoots(file, discovery.workspace.path);
    if (path.relative(root, discovery.workspace.path) !== '' && !current.some(p => p.directory === root)) throw new Error('Project no longer available');
    if (this.bindingEpochs.get(panel) !== epoch) throw new Error('Stale binding attempt');
    await this.detach(panel, true);
    if (this.bindingEpochs.get(panel) !== epoch) throw new Error('Stale binding attempt');
    const language = discovery.extension === '.go' ? 'go' : 'csharp';
    const [documentPath, workspaceReal] = await Promise.all([realpath(file), realpath(discovery.workspace.path)]);
    const relativeDocument = path.relative(workspaceReal, documentPath);
    if (path.isAbsolute(relativeDocument) || relativeDocument === '..' || relativeDocument.startsWith(`..${path.sep}`)) throw new Error('File is outside workspace');
    if (this.bindingEpochs.get(panel) !== epoch) throw new Error('Stale binding attempt');
    const binding: Binding = { history: { entries: [], index: -1, queue: Promise.resolve() }, queryEpoch: 0, token, workspace: discovery.workspace, uri: pathToFileURL(documentPath).href, language, root, text, version, results: new QueryResults(discovery.workspace.path), syncing: Promise.resolve() };
    this.bindings.set(panel, binding);
    this.invalidateOtherProjects(binding);
    this.discoveries.delete(panel);
    // Binding survives start failure: reconnect can retry without blocking editing.
    binding.syncing = this.start(panel, binding);
    await binding.syncing;
    return { uri: binding.uri, language, root };
  }
  private async start(panel: string, binding: Binding) {
    const key = await this.groupKey(binding);
    const text = binding.text;
    let group = this.groups.get(key);
    if (!group) { group = { members: new Set(), queue: Promise.resolve() }; this.groups.set(key, group); }
    binding.group = group;
    const g = group;
    await this.groupOperation(g, async () => {
      if (this.bindings.get(panel) !== binding) throw new Error('Document detached during startup');
      const realDocument = await realpath(fileURLToPath(binding.uri));
      for (const member of g.members) if (await realpath(fileURLToPath(member.uri)) === realDocument) throw new Error('File already bound in another panel; conflicting unsaved documents are not supported');
      if (!g.server) g.server = await this.deps.start(binding.root, await this.deps.executable(binding.language));
      if (this.bindings.get(panel) !== binding) { if (!g.members.size) { await g.server.dispose(); g.server = undefined; } throw new Error('Document detached during startup'); }
      this.invalidateMembers(g);
      try { await g.server.open(binding.uri, binding.language, text); }
      catch (error) { if (!g.members.size) { await g.server.dispose(); g.server = undefined; } throw error; }
      finally { this.invalidateMembers(g); }
      if (this.bindings.get(panel) !== binding) { await g.server.close(binding.uri); if (!g.members.size) { await g.server.dispose(); g.server = undefined; } throw new Error('Document detached during startup'); }
      g.members.add(binding); binding.server = g.server;
    });
  }
  private binding(panel: string): Binding {
    const b = this.bindings.get(panel); if (!b) throw new Error('Document is not bound'); return b;
  }
  assertBinding(panel: string, token: unknown): void {
    if (typeof token !== 'string' || !token || this.binding(panel).token !== token) throw new Error('Stale binding token');
  }
  async sync(panel: string, text: string, version: number, token?: string) {
    const b = this.binding(panel);
    if (b.token !== token) throw new Error('Stale binding token');
    if (!Number.isSafeInteger(version) || version <= b.version) throw new Error('Document version must increase');
    b.version = version; b.text = text;
    this.invalidateOtherProjects(b);
    for (const member of b.group?.members ?? [b]) { member.queryEpoch++; member.results.begin(member.version); }
    b.syncing = b.syncing.catch(() => {}).then(async () => {
      const g = b.group;
      if (g) await this.groupOperation(g, async () => {
        try { if (this.bindings.get(panel) === b && b.server) await b.server.change(b.uri, text); }
        catch (error) { g.failure = error; throw error; }
      });
    });
    await b.syncing;
  }
  async navigate(panel: string, method: NavigationMethod, position: { line: number; character: number }, version: number) {
    const b = this.binding(panel);
    if (!(method in methods) || !Number.isSafeInteger(position?.line) || position.line < 0 || !Number.isSafeInteger(position?.character) || position.character < 0) throw new Error('Invalid navigation request');
    if (version !== b.version) throw new Error('Stale document version');
    const epoch = ++b.queryEpoch;
    b.results.begin(version);
    await b.syncing;
    await Promise.all([...b.group?.members ?? []].map(member => member.syncing));
    await b.group?.queue.catch(() => {});
    await this.checkOtherProjects(b);
    if (b.group?.failure) throw new Error('Project synchronization failed; reconnect before navigating');
    if (version !== b.version || this.bindings.get(panel) !== b || epoch !== b.queryEpoch) throw new Error('Stale navigation request');
    if (!b.server) throw new Error('Language server unavailable; reconnect');
    const query = b.results.begin(version);
    const params: Record<string, unknown> = { textDocument: { uri: b.uri }, position };
    if (method === 'references') params.context = { includeDeclaration: true };
    const value = await b.server.request(methods[method], params);
    if (epoch !== b.queryEpoch) throw new Error('Stale navigation result');
    await this.checkOtherProjects(b);
    if (epoch !== b.queryEpoch) throw new Error('Stale navigation result');
    const locations = normalizeLocations(value);
    if (this.bindings.get(panel) !== b || !b.results.complete(query, b.version, locations)) throw new Error('Stale navigation result');
    return { query, locations };
  }
  async preview(panel: string, query: number, version: number, location: NavigationLocation): Promise<string> {
    const b = this.binding(panel);
    const file = await b.results.authorize(query, version, location);
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('File is too large for preview');
    const text = await readFile(file, 'utf8');
    await b.results.authorize(query, version, location);
    if (this.bindings.get(panel) !== b || version !== b.version) throw new Error('Stale navigation result');
    const lines = text.split(/\r\n|\r|\n/);
    return lines.slice(Math.max(0, location.line - 2), location.line + 3).join('\n').slice(0, 4000);
  }
  async open(panel: string, query: number, version: number, location: NavigationLocation, source?: { line: number; character: number }) {
    const b = this.binding(panel);
    return this.historyOperation(b, async history => {
      if (version !== b.version || this.bindings.get(panel) !== b) throw new Error('Stale document version');
      const file = await b.results.authorize(query, version, location);
      const origin: NavigationLocation = { uri: b.uri, line: source?.line ?? 0, character: source?.character ?? 0 };
      const originFile = await this.checkedFile(b, origin);
      origin.uri = pathToFileURL(originFile).href;
      if (this.bindings.get(panel) !== b || version !== b.version) throw new Error('Stale navigation result');
      await b.results.authorize(query, version, location);
      await this.deps.openFile(file, b.workspace.id, location);
      const current = history.entries[history.index];
      const sameFile = current && current.uri === origin.uri;
      const entries = history.entries.slice(0, history.index + 1);
      if (sameFile) entries[entries.length - 1] = origin; else entries.push(origin);
      entries.push({ ...location, uri: pathToFileURL(file).href });
      history.entries = entries; history.index = entries.length - 1;
      this.rememberReveal(b, file, location, history);
    });
  }
  async history(panel: string, direction: 'back' | 'forward', source: { line: number; character: number }, version?: number): Promise<void> {
    const b = this.binding(panel);
    return this.historyOperation(b, async history => {
      if (version !== undefined && version !== b.version) throw new Error('Stale document version');
      if (direction !== 'back' && direction !== 'forward') throw new Error('Invalid history direction');
      const current = history.entries[history.index];
      if (!current || await this.checkedFile(b, current) !== await this.checkedFile(b, { uri: b.uri, ...source })) throw new Error('Current editor does not match navigation history');
      const next = history.index + (direction === 'back' ? -1 : 1);
      const target = history.entries[next];
      if (!target) throw new Error('No navigation history in that direction');
      const file = await this.checkedFile(b, target);
      const activeVersion = b.version;
      if (this.bindings.get(panel) !== b) throw new Error('Document is no longer bound');
      await this.deps.openFile(file, b.workspace.id, target);
      if (this.bindings.get(panel) !== b || activeVersion !== b.version) throw new Error('Document changed while opening history');
      history.entries[history.index] = { uri: current.uri, ...source };
      history.index = next;
      this.rememberReveal(b, file, target, history);
    });
  }
  async pendingReveals(panel: string): Promise<{ id: string; location: NavigationLocation }[]> {
    const b = this.binding(panel);
    const file = await this.checkedFile(b, { uri: b.uri, line: 0, character: 0 });
    if (this.bindings.get(panel) !== b) throw new Error('Document is no longer bound');
    return [...this.reveals.values()].filter(value => value.workspace === b.workspace.id && value.file === file).map(value => ({ id: value.id, location: { ...value.location } }));
  }
  async claimReveal(panel: string, id: string): Promise<NavigationLocation> {
    const b = this.binding(panel);
    const value = this.reveals.get(id);
    if (!value || value.workspace !== b.workspace.id) throw new Error('Unknown navigation handoff');
    const file = await this.checkedFile(b, value.location);
    const boundFile = await this.checkedFile(b, { uri: b.uri, line: 0, character: 0 });
    if (this.bindings.get(panel) !== b || this.reveals.get(id) !== value || file !== value.file || boundFile !== file) throw new Error('Navigation handoff does not match this editor');
    this.reveals.delete(id);
    b.history = value.history;
    return { ...value.location };
  }
  async reconnect(panel: string) {
    const b = this.binding(panel); b.results.begin(b.version);
    for (const member of b.group?.members ?? [b]) { member.queryEpoch++; member.results.begin(member.version); }
    b.syncing = b.syncing.catch(() => {}).then(async () => {
      if (b.group?.members.has(b)) await this.groupOperation(b.group, async () => {
        const group = b.group!;
        const old = group.server;
        group.server = undefined;
        for (const member of group.members) member.server = undefined;
        try {
          if (old) await old.dispose();
          const executable = await this.deps.executable(b.language);
          const server = await this.deps.start(b.root, executable);
          try {
            for (const member of group.members) await server.open(member.uri, member.language, member.text);
          } catch (error) { await server.dispose(); throw error; }
          group.server = server;
          for (const member of group.members) member.server = server;
          group.failure = undefined;
        } catch (error) { group.failure = error; throw error; }
      }); else await this.start(panel, b);
    });
    await b.syncing;
  }
  async detach(panel: string, internal = false) {
    if (!internal) this.bindingEpochs.set(panel, (this.bindingEpochs.get(panel) ?? 0) + 1);
    const b = this.bindings.get(panel); if (b) this.invalidateOtherProjects(b);
    this.bindings.delete(panel); this.discoveries.delete(panel);
    if (b?.group?.members.has(b)) this.invalidateMembers(b.group);
    if (b) {
      await b.syncing.catch(() => {});
      const g = b.group;
      if (g) await this.groupOperation(g, async () => {
        if (g.members.delete(b) && g.server) {
          this.invalidateMembers(g);
          try { await g.server.close(b.uri); } catch { /* Disposal must still proceed. */ }
          finally { this.invalidateMembers(g); }
        }
        if (!g.members.size && g.server) { const server = g.server; g.server = undefined; await server.dispose(); }
      });
    }
  }
  async dispose() { await Promise.all([...this.bindings.keys()].map(panel => this.detach(panel))); }
}
