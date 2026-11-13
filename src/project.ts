import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Skipped paths are reported: a caller must not treat an incomplete scan as unique.
const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', '.cache']);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function workspacePath(workspace: string): Promise<string> {
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory()) throw new Error(`Workspace is not a directory: ${workspace}`);
  return root;
}

export interface DocumentCandidates {
  exactMatches: string[];
  fallbackCandidates: string[];
  complete: boolean;
  skippedDirectories: string[];
  errors: { path: string; reason: string }[];
}

/** Content alone does not establish identity: all candidates require user selection unless independently identified. */
export async function discoverDocuments(workspace: string, text: string, extension: '.cs' | '.go'): Promise<DocumentCandidates> {
  const root = await workspacePath(workspace);
  const exactMatches: string[] = [];
  const candidates: string[] = [];
  const skippedDirectories: string[] = [];
  const errors: { path: string; reason: string }[] = [];
  const report = (name: string, error: unknown) => errors.push({ path: name, reason: String(error) });
  const directories = [{ name: root, ancestors: [root] }];
  while (directories.length) {
    const { name: directory, ancestors } = directories.pop()!;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { report(directory, error); continue; }
    for (const entry of entries) {
      const name = path.join(directory, entry.name);
      try {
      if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
      const real = await fs.realpath(name);
      if (!isWithin(root, real)) continue;
      const stat = entry.isSymbolicLink() ? await fs.stat(real) : entry;
      if (stat.isDirectory()) {
        if (excludedDirectories.has(entry.name.toLowerCase()) || excludedDirectories.has(path.basename(real).toLowerCase())) {
          skippedDirectories.push(name);
        } else if (!ancestors.includes(real)) {
          directories.push({ name, ancestors: [...ancestors, real] });
        }
      } else if (stat.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        if (await fs.readFile(real, 'utf8') === text) exactMatches.push(name);
        else candidates.push(name);
      }
      } catch (error) { report(name, error); }
    }
  }
  return {
    exactMatches: exactMatches.sort(),
    fallbackCandidates: candidates.sort(),
    complete: skippedDirectories.length === 0 && errors.length === 0,
    skippedDirectories: skippedDirectories.sort(),
    errors: errors.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Exact-only legacy API; even one match does not establish document identity. */
export async function resolveDocument(workspace: string, text: string, extension: '.cs' | '.go'): Promise<string[]> {
  const result = await discoverDocuments(workspace, text, extension);
  if (!result.complete) throw new Error('Incomplete workspace scan; use discoverDocuments to inspect skipped directories');
  return result.exactMatches;
}

export interface ProjectRootCandidate {
  directory: string;
  markers: string[];
}

/** Marker candidates in nearest-first order, without asserting project membership. */
export async function findProjectRoots(file: string, workspace: string): Promise<ProjectRootCandidate[]> {
  const root = await workspacePath(workspace);
  const realFile = await fs.realpath(file);
  if (!isWithin(root, realFile)) throw new Error(`File is outside workspace: ${file}`);
  if (!(await fs.stat(realFile)).isFile()) throw new Error(`Not a file: ${file}`);
  const workspaceInput = path.resolve(workspace);
  const logicalFile = path.resolve(file);
  const logicalRoot = isWithin(workspaceInput, logicalFile) ? workspaceInput : root;
  if (!isWithin(logicalRoot, logicalFile)) throw new Error(`File path is outside workspace: ${file}`);
  const extension = path.extname(logicalFile).toLowerCase();
  if (extension !== '.go' && extension !== '.cs') throw new Error(`Unsupported file extension: ${file}`);
  const candidates: ProjectRootCandidate[] = [];
  let directory = path.dirname(logicalFile);
  while (isWithin(logicalRoot, directory)) {
    if (!isWithin(root, await fs.realpath(directory))) throw new Error(`Directory is outside workspace: ${directory}`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const markers: string[] = [];
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (!(extension === '.go' ? name === 'go.work' || name === 'go.mod' : /\.(sln|slnx|csproj)$/.test(name))) continue;
      if (entry.isFile()) {
        markers.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        const realMarker = await fs.realpath(path.join(directory, entry.name));
        if (isWithin(root, realMarker) && (await fs.stat(realMarker)).isFile()) markers.push(entry.name);
      }
    }
    markers.sort();
    if (markers.length) candidates.push({ directory, markers });
    if (path.relative(logicalRoot, directory) === '') break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates;
}

/** Prefer the nearest enclosing workspace/solution marker; this is only a heuristic. */
export async function findProjectRoot(file: string, workspace: string): Promise<string> {
  const candidates = await findProjectRoots(file, workspace);
  const broad = candidates.find(candidate => candidate.markers.some(marker => /^(go\.work)$/i.test(marker) || /\.(sln|slnx)$/i.test(marker)));
  return broad?.directory ?? candidates[0]?.directory ?? await workspacePath(workspace);
}
