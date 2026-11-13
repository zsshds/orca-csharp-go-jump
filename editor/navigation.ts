export interface Position { line: number; character: number }
export interface Location extends Position { uri: string }
export type NavigationKind = 'definition' | 'typeDefinition' | 'implementation' | 'references';
type Request = (method: string, input?: any) => Promise<any>;

/** Tracks edits independently of host document versions and invalidates stale UI results. */
export class EditorNavigation {
  version = 1;
  private generation = 0;
  private active = false;
  private bindingGeneration = 0;
  private querySource?: { query: number; position: Position };
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private request: Request, private text: () => string, private flush: () => Promise<void>) {}
  bind(ready: Promise<unknown> = Promise.resolve()): void { this.version = 1; this.generation++; this.bindingGeneration++; this.active = true; this.pending = ready; void ready.catch(() => {}); }
  unbind(): void { this.active = false; this.generation++; this.bindingGeneration++; }
  changed(): void {
    this.generation++;
    if (!this.active) return;
    const version = ++this.version, text = this.text(), binding = this.bindingGeneration;
    this.pending = this.pending.catch(() => {}).then(() => { if (binding === this.bindingGeneration && this.active) return this.request('sync', { text, version }); });
    void this.pending.catch(() => {});
  }
  async navigate(method: NavigationKind, position: Position): Promise<{ query: number; locations: Location[] }> {
    if (!this.active) throw new Error('Select a workspace, file, and project first');
    const generation = ++this.generation, version = this.version;
    await this.pending;
    if (generation !== this.generation) throw new Error('Stale navigation request');
    const result = await this.request('navigate', { method, position, version });
    if (generation !== this.generation) throw new Error('Stale navigation result');
    this.querySource = { query: result.query, position: { ...position } };
    return result;
  }
  async open(query: number, location: Location, source?: Position): Promise<void> {
    const generation = this.generation, version = this.version;
    await this.flush();
    if (!this.active || generation !== this.generation || version !== this.version) throw new Error('Stale navigation result');
    const origin = source ?? (this.querySource?.query === query ? this.querySource.position : undefined);
    await this.request('open', { query, version, location, ...(origin ? { source: origin } : {}) });
  }
  async reconnect(): Promise<void> {
    if (!this.active) throw new Error('Document is not bound');
    const generation = ++this.generation;
    const prior = this.pending, binding = this.bindingGeneration;
    const next = prior.catch(() => {}).then(() => {
      if (!this.active || binding !== this.bindingGeneration) throw new Error('Stale reconnect');
      return this.request('reconnect');
    });
    this.pending = next;
    await next;
    if (generation !== this.generation) throw new Error('Stale reconnect');
  }
  async history(direction: 'back' | 'forward', source: Position): Promise<void> {
    const generation = this.generation, version = this.version;
    await this.flush();
    if (!this.active || generation !== this.generation || version !== this.version) throw new Error('Stale history request');
    await this.request('history', { direction, source, version });
  }
}
