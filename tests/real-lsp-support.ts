import { access, stat, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import type { NavigationLocation } from '../src/navigation';

// One deadline for all phases. A request begun just before it may consume its
// full timeout; leave extra room for polling and best-effort process cleanup.
export const realLspBudget = {
  deadlineMs: 90_000,
  requestTimeoutMs: 20_000,
  pollMs: 500,
  cleanupReserveMs: 30_000,
  testTimeoutMs: 150_000,
} as const;

export async function executable(name: string, pathDirs = (process.env.PATH ?? '').split(delimiter), windows = process.platform === 'win32'): Promise<string | undefined> {
  if (!name) return undefined;
  const names = windows && !/\.(exe|cmd|bat)$/i.test(name) ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name];
  const dirs = /[\\/]/.test(name) ? [''] : pathDirs;
  for (const dir of dirs) for (const candidate of names) {
    const path = resolve(dir, candidate);
    try {
      await access(path, windows ? constants.F_OK : constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* try the next candidate */ }
  }
}

export async function serverExecutable(name: string, configured: string | undefined, variable: string, pathDirs?: string[], windows?: boolean): Promise<string | undefined> {
  if (configured !== undefined) {
    const found = await executable(configured, [''], windows);
    if (!found) throw new Error(`${variable} is explicitly configured but is not an executable file: ${configured}`);
    return found;
  }
  return executable(name, pathDirs, windows);
}

export async function cleanupRealLsp(options: {
  root: string; child?: ChildProcess; dispose?: () => Promise<void>; primaryError?: unknown; hasPrimaryError?: boolean;
  timeoutMs?: number; retryMs?: number; remove?: (path: string) => Promise<void>; report?: (error: unknown) => void;
}): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);
  const retryMs = options.retryMs ?? 200;
  const remove = options.remove ?? (path => rm(path, { recursive: true, force: true }));
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Cleanup timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cleanup timed out')), remaining);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  let cleanupError: unknown;
  try {
    if (options.dispose) await bounded(options.dispose);
    const child = options.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await bounded(() => new Promise<void>((resolveExit, reject) => {
        const onExit = () => { child.off('error', onError); resolveExit(); };
        const onError = (error: Error) => { child.off('exit', onExit); reject(error); };
        child.once('exit', onExit);
        child.once('error', onError);
        if (child.exitCode !== null || child.signalCode !== null) { child.off('exit', onExit); child.off('error', onError); resolveExit(); }
      }));
    }
    for (let attempt = 0; ; attempt++) {
      try { await bounded(() => remove(options.root)); break; }
      catch (error) {
        if (attempt >= 9 || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
        await bounded(() => new Promise<void>(resolveDelay => setTimeout(resolveDelay, retryMs)));
      }
    }
  } catch (error) { cleanupError = error; }
  if (options.hasPrimaryError || options.primaryError !== undefined) {
    if (cleanupError !== undefined) (options.report ?? (error => console.error('Cleanup failed:', error)))(cleanupError);
    throw options.primaryError;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

export function hasLocation(locations: NavigationLocation[], expected: NavigationLocation): boolean {
  return locations.some(location => location.uri === expected.uri && location.line === expected.line && location.character === expected.character);
}
