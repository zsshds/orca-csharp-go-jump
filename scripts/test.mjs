import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const filter = process.argv[2];
const files = ['tests', 'editor'].flatMap(dir => readdirSync(dir).filter(name => /\.(?:test|spec)\.ts$/.test(name) && (dir !== 'editor' || name.endsWith('.spec.ts')) && (!filter || name.includes(filter))).map(name => `${dir}/${name}`));
if (files.length === 0) { console.error(`No tests match ${filter}`); process.exit(1); }
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!filter) {
  const host = spawnSync(process.platform === 'win32' ? 'orca.cmd' : 'orca', ['plugin', 'test', '.', '--json'], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(host.status ?? 1);
}
