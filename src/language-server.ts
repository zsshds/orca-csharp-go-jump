import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, parse } from 'node:path';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, ResponseError, ErrorCodes, type MessageConnection } from 'vscode-jsonrpc/node.js';

export type ServerExecutable = string | { command: string; args?: string[] };
export interface LanguageServerOptions { timeoutMs?: number }
type Document = { languageId: string; text: string; version: number; synced: boolean };

/** One server instance per project root and language. */
export class LanguageServer {
  private readonly docs = new Map<string, Document>();
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private writeFailure?: Promise<never>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private sync: { openClose: boolean; change: 0 | 1 | 2 } = { openClose: false, change: 0 };
  private constructor(private readonly root: string, private readonly executable: ServerExecutable, private readonly timeoutMs: number) {}

  static async start(root: string, executable: ServerExecutable, options: LanguageServerOptions = {}): Promise<LanguageServer> {
    const server = new LanguageServer(resolve(root), executable, options.timeoutMs ?? 10000);
    try { await server.launch(); return server; } catch (error) { await server.dispose(); throw error; }
  }

  private get rootUri(): string {
    const uri = pathToFileURL(this.root).href;
    return this.root === parse(this.root).root ? uri : uri.replace(/\/$/, '');
  }

  private async launch(): Promise<void> {
    if (this.disposed) throw new Error('Language server disposed');
    const spec = typeof this.executable === 'string' ? { command: this.executable, args: [] } : this.executable;
    let command = spec.command;
    let args = spec.args ?? [];
    let windowsVerbatimArguments = false;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
      if ([command, ...args].some(s => /["\r\n%!]/.test(s))) throw new Error('Unsafe characters in Windows command');
      args = ['/d', '/s', '/c', `"${[command, ...args].map(s => `"${s}"`).join(' ')}"`];
      command = process.env.ComSpec || 'cmd.exe';
      windowsVerbatimArguments = true;
    }
    const child = spawn(command, args, { cwd: this.root, stdio: 'pipe', windowsVerbatimArguments });
    this.process = child;
    // Capture a small bounded prefix only for classifying known dependency errors;
    // never show raw stderr, which may contain source paths or secrets.
    let diagnostics = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (diagnostics.length < 16384) diagnostics += chunk.slice(0, 16384 - diagnostics.length); });
    child.stdin.on('error', () => { if (this.process === child) this.drop(); });
    const writer = new StreamMessageWriter(child.stdin);
    let rejectWrite!: (error: unknown) => void;
    const writeFailure = new Promise<never>((_, reject) => { rejectWrite = reject; });
    void writeFailure.catch(() => {});
    this.writeFailure = writeFailure;
    const write = writer.write.bind(writer);
    // vscode-jsonrpc 8 rethrows request writer failures inside an async Promise
    // executor. Dispose to reject pending requests, and propagate all other writes.
    writer.write = message => write(message).catch(error => {
      rejectWrite(error);
      if (this.process === child) this.drop();
      if ('method' in message && 'id' in message) return;
      throw error;
    });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), writer);
    this.connection = connection;
    child.on('error', () => { if (this.process === child) this.drop(); });
    child.on('exit', () => { if (this.process === child) this.drop(); });
    connection.onRequest('workspace/configuration', (params: { items?: unknown[] }) => (params.items ?? []).map(() => null));
    connection.onRequest('workspace/workspaceFolders', () => [{ uri: this.rootUri, name: this.root.split(/[\\/]/).pop() || this.root }]);
    connection.onRequest('client/registerCapability', () => { throw new ResponseError(ErrorCodes.MethodNotFound, 'Dynamic capability registration is not supported'); });
    connection.onRequest('client/unregisterCapability', () => { throw new ResponseError(ErrorCodes.MethodNotFound, 'Dynamic capability registration is not supported'); });
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest((method) => { throw new ResponseError(ErrorCodes.MethodNotFound, `Unsupported server request: ${method}`); });
    connection.listen();
    const ensureConnected = () => {
      if (this.disposed || this.process !== child || this.connection !== connection) throw new Error('Language server disconnected during initialization');
    };
    try {
      await new Promise<void>((resolveSpawn, reject) => {
        child.once('spawn', resolveSpawn);
        child.once('error', (error) => reject(new Error(`Cannot start language server ${spec.command}: ${error.message}`)));
      });
      ensureConnected();
      const rootUri = this.rootUri;
      const result = await this.send<{ capabilities?: { positionEncoding?: string; textDocumentSync?: number | { openClose?: boolean; change?: number } } }>('initialize', {
        processId: process.pid, rootUri, capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true } },
        workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() || this.root }],
      });
      ensureConnected();
      if (result.capabilities?.positionEncoding && result.capabilities.positionEncoding !== 'utf-16') throw new Error(`Unsupported position encoding: ${result.capabilities.positionEncoding}`);
      const sync = result.capabilities?.textDocumentSync;
      const kind = typeof sync === 'number' ? sync : sync?.change ?? 0;
      if (kind !== 0 && kind !== 1 && kind !== 2) throw new Error(`Unsupported text synchronization kind: ${kind}`);
      this.sync = { openClose: typeof sync === 'number' ? sync !== 0 : sync?.openClose === true, change: kind };
      ensureConnected();
      await connection.sendNotification('initialized', {});
      ensureConnected();
      for (const [uri, doc] of this.docs) {
        doc.version = 1;
        doc.synced = false;
        if (this.sync.openClose) {
          ensureConnected();
          await connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: doc.languageId, version: doc.version, text: doc.text } });
          ensureConnected();
          doc.synced = true;
        }
      }
      ensureConnected();
    } catch (error) {
      if (this.process === child) this.drop();
      const hint = /(?:\.net|dotnet).{0,120}(?:sdk|runtime|install)|(?:sdk|runtime).{0,120}(?:\.net|dotnet)/is.test(diagnostics)
        ? ' Check the .NET SDK/runtime installation and csharp-ls requirements.'
        : /(?:gopls|go).{0,100}(?:not found|not installed|missing)|(?:not found|not installed|missing).{0,100}(?:gopls|go)/is.test(diagnostics)
          ? ' Check that Go and gopls are installed and available on PATH.' : '';
      if (hint) throw new Error(`Language server failed during startup.${hint}`, { cause: error });
      throw error;
    }
  }

  private drop(): void {
    const connection = this.connection; const child = this.process;
    this.connection = undefined; this.process = undefined; this.writeFailure = undefined;
    for (const doc of this.docs.values()) doc.synced = false;
    connection?.dispose();
    if (child && !child.killed) {
      const executable = typeof this.executable === 'string' ? this.executable : this.executable.command;
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable) && child.pid) {
        // cmd.exe launches the actual server as a descendant; killing only cmd leaks it.
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      }
      child.kill();
    }
  }

  private async send<T>(method: string, params: unknown): Promise<T> {
    const connection = this.connection;
    if (!connection) throw new Error('Language server is not connected');
    const failure = this.writeFailure;
    if (!failure) throw new Error('Language server is not connected');
    const token = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        failure,
        connection.sendRequest<T>(method, params, token.token),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`Language server request ${method} timed out`)); token.cancel(); if (this.connection === connection) this.drop(); }, this.timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); token.dispose(); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private async notify(method: string, params: unknown): Promise<boolean> {
    const connection = this.connection;
    if (!connection) return false;
    try { await connection.sendNotification(method, params); return this.connection === connection; }
    catch { if (this.connection === connection) this.drop(); return false; }
  }
  open(uri: string, languageId: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Language server disposed');
      const existing = this.docs.get(uri);
      if (existing) {
        if (existing.languageId === languageId && existing.text === text) return;
        throw new Error(`Document already open: ${uri}`);
      }
      const doc: Document = { languageId, text, version: 1, synced: false }; this.docs.set(uri, doc);
      if (this.sync.openClose) doc.synced = await this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: doc.version, text } });
    });
  }
  change(uri: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Language server disposed');
      const doc = this.docs.get(uri); if (!doc) throw new Error(`Document not open: ${uri}`);
      const previous = doc.text;
      if (doc.text !== text) { doc.text = text; doc.version++; }
      if (this.connection && this.sync.change === 2 && !doc.synced) {
        throw new Error(`Incremental text sync is unsupported without a trusted server baseline: ${uri}`);
      }
      if (previous === text) return;
      if (this.sync.change === 0) { doc.synced = false; return; }
      const lines = previous.split(/\r\n|\r|\n/);
      const contentChange = this.sync.change === 2
        ? { range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } }, text }
        : { text };
      const wasSynced = doc.synced;
      const delivered = await this.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [contentChange] });
      doc.synced = delivered && (this.sync.change === 1 || wasSynced);
    });
  }
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    // Only serialize the send behind document notifications, not the response itself.
    let result!: Promise<T>;
    return this.enqueue(async () => {
      const uri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri;
      const doc = typeof uri === 'string' ? this.docs.get(uri) : undefined;
      if (doc && !doc.synced) throw new Error(`Document is not synchronized with the language server: ${uri}`);
      if (typeof uri === 'string' && [...this.docs.values()].some(document => !document.synced)) throw new Error('Another project document is not synchronized with the language server; reconnect or close it before navigating');
      result = this.send<T>(method, params);
    }).then(() => result);
  }
  close(uri: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) throw new Error('Language server disposed');
      if (!this.docs.delete(uri)) return;
      if (this.sync.openClose) await this.notify('textDocument/didClose', { textDocument: { uri } });
    });
  }
  async reconnect(): Promise<void> {
    if (this.disposed) throw new Error('Language server disposed');
    await this.enqueue(async () => {
      if (this.disposed) throw new Error('Language server disposed');
      this.drop();
      await this.launch();
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.drop();
    await this.queue;
    this.docs.clear();
  }
}
