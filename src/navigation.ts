import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NavigationLocation { uri: string; line: number; character: number }

/** Convert LSP Location and LocationLink results; positions remain UTF-16 code units. */
export function normalizeLocations(result: unknown): NavigationLocation[] {
  const entries = result == null ? [] : Array.isArray(result) ? result : [result];
  return entries.flatMap((entry: any) => {
    if (!entry || typeof entry !== 'object') return [];
    const uri = entry.targetUri ?? entry.uri;
    const start = (entry.targetSelectionRange ?? entry.range)?.start;
    if (typeof uri !== 'string' || !Number.isSafeInteger(start?.line) || start.line < 0 || !Number.isSafeInteger(start?.character) || start.character < 0) return [];
    return [{ uri, line: start.line, character: start.character }];
  });
}

function key(location: NavigationLocation): string {
  return JSON.stringify([location.uri, location.line, location.character]);
}

/** The caller invalidates by beginning a new query whenever the document changes. */
export class QueryResults {
  private generation = 0;
  private version = 0;
  private allowed = new Set<string>();
  constructor(private readonly workspace: string) {}
  begin(version: number): number {
    this.version = version;
    this.allowed.clear();
    return ++this.generation;
  }
  complete(generation: number, version: number, locations: NavigationLocation[]): boolean {
    if (generation !== this.generation || version !== this.version) return false;
    this.allowed = new Set(locations.map(key));
    return true;
  }
  async authorize(generation: number, version: number, location: NavigationLocation): Promise<string> {
    const check = () => {
      if (generation !== this.generation || version !== this.version || !this.allowed.has(key(location))) throw new Error('Target is not in the current query');
    };
    check();
    let filename: string;
    try { filename = fileURLToPath(location.uri); } catch { throw new Error('Target is not a local file URI'); }
    const [root, real] = await Promise.all([fs.realpath(this.workspace), fs.realpath(filename)]);
    const relative = path.relative(root, real);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Target is outside the workspace');
    if (!(await fs.stat(real)).isFile()) throw new Error('Target is not a file');
    check();
    return real;
  }
}

export class NavigationHistory {
  private entries: NavigationLocation[] = [];
  private index = -1;
  push(location: NavigationLocation): void {
    if (this.index >= 0 && key(this.entries[this.index]) === key(location)) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ ...location });
    this.index = this.entries.length - 1;
  }
  back(): NavigationLocation | undefined { return this.index > 0 ? this.entries[--this.index] : undefined; }
  forward(): NavigationLocation | undefined { return this.index + 1 < this.entries.length ? this.entries[++this.index] : undefined; }
}
