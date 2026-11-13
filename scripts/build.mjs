import { build } from 'esbuild';
import { mkdir, copyFile, readFile, readdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/worker.mjs' });
await build({ entryPoints: ['editor/main.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', outfile: 'dist/editor.js' });
await Promise.all(['index.html', 'style.css'].map((name) => copyFile(`editor/${name}`, `dist/${name === 'index.html' ? 'editor.html' : name}`)));

// Preserve the license texts of packages whose code may be included in the bundle.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = [];
for (const [directory, info] of Object.entries(lock.packages)) {
  if (!directory || info.dev || info.optional) continue;
  const entries = await readdir(directory);
  const license = entries.find(name => /^licen[cs]e(?:\.|$)/i.test(name));
  if (license) notices.push(`--- ${directory} (${info.version}) ---\n${await readFile(`${directory}/${license}`, 'utf8')}`);
}
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n\n'));
await copyFile('LICENSE', 'dist/LICENSE');
