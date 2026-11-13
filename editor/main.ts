import { Compartment, Prec } from '@codemirror/state';
import { createDocumentState, documentText, hasMixedLineEndings, replaceDocument } from './document';
import { EditorView, keymap } from '@codemirror/view';
import { editorExtensions, type Language } from './extensions';
import { bindEditor, start } from './sync';
import { EditorNavigation, type Location, type NavigationKind, type Position } from './navigation';
import { languageFromFileType } from './file-type';

async function main() {
  let conflictCount = 0;
  const doc = await start(draft => {
    const section = document.querySelector<HTMLElement>('#conflicts')!;
    const list = document.querySelector<HTMLElement>('#conflict-drafts')!;
    section.hidden = false;
    const label = document.createElement('label'); label.textContent = `Recoverable local draft ${++conflictCount} (copy or save separately)`;
    const text = document.createElement('textarea'); text.value = draft; text.readOnly = true; text.rows = 8; text.style.width = '100%';
    const save = document.createElement('button'); save.textContent = 'Save draft as…';
    save.addEventListener('click', () => { void (async () => {
      if (!orca.files) throw new Error('Save As is unavailable; select and copy the draft instead');
      const result = await orca.files.saveAs({ suggestedName: `orca-conflict-draft-${conflictCount}.txt`, mimeType: 'text/plain', data: draft });
      if (result.status === 'cancelled') throw new Error('Draft was not saved; copy or save it before closing');
    })().catch(error => { label.textContent = String(error); }); });
    label.append(text, save); list.append(label);
  });
  window.addEventListener('beforeunload', event => { if (conflictCount) { event.preventDefault(); event.returnValue = ''; } });
  const element = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
  const selector = element<HTMLSelectElement>('language'), compartment = new Compartment();
  const status = element<HTMLElement>('status'), error = element<HTMLElement>('error');
  const workspace = element<HTMLSelectElement>('workspace'), extension = element<HTMLSelectElement>('extension');
  const file = element<HTMLSelectElement>('file'), project = element<HTMLSelectElement>('project');
  const hostLanguage = languageFromFileType((await orca.document!.get().catch(() => undefined))?.fileType);
  if (hostLanguage) { selector.value = hostLanguage; extension.value = hostLanguage === 'go' ? '.go' : '.cs'; }
  const resultList = element<HTMLSelectElement>('result-list'), filter = element<HTMLInputElement>('filter');
  const resultsPanel = element<HTMLElement>('results'), preview = element<HTMLElement>('preview');
  let bindingToken = '';
  const boundRequests = new Set(['attach', 'sync', 'navigate', 'preview', 'open', 'history', 'reconnect', 'pendingReveals', 'claimReveal', 'detach']);
  const request = async (name: string, input?: any): Promise<any> => orca.plugin.request(name, boundRequests.has(name) && bindingToken ? { ...input, bindingToken } : input, { timeoutMs: 120000 });
  const navigation = new EditorNavigation(request, () => doc.value, () => doc.flush());
  let replacing = false, attached = false, query = 0, locations: Location[] = [], resultVersion = 0, previewGeneration = 0;
  const showError = (e: unknown) => { status.textContent = `Navigation: ${e instanceof Error ? e.message : String(e)}`; };
  const run = (fn: () => Promise<unknown>) => { void fn().catch(showError); };
  function showLineEndingWarning(text: string) { error.textContent = hasMixedLineEndings(text) ? 'This file has mixed line endings and is read-only to prevent unintended changes. Normalize its line endings externally to edit it.' : ''; }
  const position = (offset: number): Position => { const line = view.state.doc.lineAt(offset); return { line: line.number - 1, character: offset - line.from }; };
  function reveal(pos: Position) { const line = view.state.doc.line(Math.min(view.state.doc.lines, pos.line + 1)); const offset = Math.min(line.to, line.from + pos.character); view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) }); view.focus(); }
  function changed() { navigation.changed(); locations = []; resultsPanel.hidden = true; previewGeneration++; }
  function createState(text: string) {
    return createDocumentState(text, [compartment.of(editorExtensions(selector.value as Language, doc.readOnly)),
      Prec.highest(keymap.of([{ key: 'F12', run: () => { run(() => navigate('definition')); return true; } }])),
      EditorView.domEventHandlers({ mousedown(event, v) { if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false; const offset = v.posAtCoords({ x: event.clientX, y: event.clientY }); if (offset === null) return false; event.preventDefault(); run(() => navigate('definition', position(offset))); return true; } }),
      EditorView.updateListener.of(update => { if (update.docChanged && !replacing) { binding.changed(documentText(update.state)); changed(); } })]);
  }
  showLineEndingWarning(doc.value);
  const view = new EditorView({ parent: element<HTMLElement>('editor'), state: createState(doc.value) });
  const binding = bindEditor(doc, text => { replacing = true; try { view.dispatch(replaceDocument(view.state, text)); showLineEndingWarning(text); changed(); } finally { replacing = false; } });
  const selectOptions = (target: HTMLSelectElement, placeholder: string, values: { value: string; label: string }[]) => {
    target.replaceChildren(new Option(placeholder, '')); for (const value of values) target.add(new Option(value.label, value.value)); target.value = '';
  };
  function renderResults() {
    const term = filter.value.toLowerCase();
    selectOptions(resultList, 'Select a result', locations.map((v, i) => ({ value: String(i), label: `${v.uri}:${v.line + 1}:${v.character + 1}` })).filter(v => v.label.toLowerCase().includes(term)));
    preview.textContent = '';
  }
  async function navigate(kind: NavigationKind, at = position(view.state.selection.main.head)) {
    const source = at;
    status.textContent = 'Querying language server…';
    const result = await navigation.navigate(kind, at);
    query = result.query; locations = result.locations; resultVersion = navigation.version;
    if (!locations.length) { resultsPanel.hidden = true; status.textContent = 'No results'; return; }
    if (locations.length === 1) { await navigation.open(query, locations[0], source); status.textContent = 'Opening result…'; return; }
    resultsPanel.hidden = false; filter.value = ''; renderResults(); status.textContent = `${locations.length} results`;
  }
  async function takeReveal() {
    if (!attached) return;
    const pending: { id: string; location: Location }[] = await request('pendingReveals');
    const target = element<HTMLSelectElement>('handoff-list');
    selectOptions(target, 'Select a navigation', pending.map(value => ({ value: value.id, label: `${value.location.uri}:${value.location.line + 1}:${value.location.character + 1}` })));
    element('handoffs').hidden = pending.length === 0;
  }
  element('claim-handoff').addEventListener('click', () => run(async () => {
    const id = element<HTMLSelectElement>('handoff-list').value;
    if (!id) throw new Error('Select a navigation');
    const location = await request('claimReveal', { id });
    reveal(location);
    await takeReveal();
  }));
  selector.addEventListener('change', () => view.dispatch({ effects: compartment.reconfigure(editorExtensions(selector.value as Language, doc.readOnly)) }));
  element('setup').addEventListener('click', () => run(async () => {
    navigation.unbind(); attached = false; locations = []; resultsPanel.hidden = true;
    await request('detach');
    element('binding').hidden = false;
    const workspaces = await request('workspaces');
    selectOptions(workspace, 'Select a workspace', workspaces.map((w: any) => ({ value: w.id, label: `${w.name} — ${w.path}` })));
  }));
  workspace.addEventListener('change', () => { selectOptions(file, 'Select a file', []); selectOptions(project, 'Select a project', []); });
  extension.addEventListener('change', () => { selectOptions(file, 'Select a file', []); selectOptions(project, 'Select a project', []); });
  element('scan').addEventListener('click', () => run(async () => {
    if (!workspace.value) throw new Error('Select a workspace');
    element('scan-status').textContent = 'Scanning…';
    const found = await request('discover', { workspaceId: workspace.value, text: doc.value, extension: extension.value });
    selectOptions(file, 'Select a file', [...found.exactMatches.map((name: string) => ({ value: name, label: `Exact content: ${name}` })), ...found.fallbackCandidates.map((name: string) => ({ value: name, label: `Other content: ${name}` }))]);
    selectOptions(project, 'Select a project', []);
    element('scan-status').textContent = found.complete ? 'Scan complete. Select the actual file.' : `Incomplete scan: skipped ${found.skippedDirectories.join(', ')}; errors: ${found.errors.map((e: any) => `${e.path}: ${e.reason}`).join('; ')}. Select explicitly; uniqueness is unknown.`;
  }));
  element('find-projects').addEventListener('click', () => run(async () => {
    if (!file.value) throw new Error('Select a file');
    const projects = await request('projects', { file: file.value });
    selectOptions(project, 'Select a project', projects.map((p: any) => ({ value: p.directory, label: `${p.directory} (${p.markers.join(', ') || 'workspace fallback'})` })));
  }));
  element('attach').addEventListener('click', () => run(async () => {
    if (!workspace.value || !file.value || !project.value) throw new Error('Explicitly select workspace, file, and project');
    navigation.unbind(); attached = false;
    const text = doc.value;
    // Begin collecting edits immediately: service startup can take longer than a user edit.
    bindingToken = crypto.randomUUID();
    const attaching = request('attach', { workspaceId: workspace.value, file: file.value, root: project.value, text, version: 1 });
    navigation.bind(attaching); attached = true;
    selector.value = extension.value === '.go' ? 'go' : 'csharp'; selector.dispatchEvent(new Event('change'));
    try {
      await attaching;
      element('binding').hidden = true; status.textContent = `Bound: ${file.value}`;
      await takeReveal();
    } catch (e) { element('binding').hidden = true; status.textContent = `Binding/server error: ${String(e)}. Try reconnect, or Bind file to select again.`; }
  }));
  element('reconnect').addEventListener('click', () => run(async () => { await navigation.reconnect(); status.textContent = 'Language server reconnected'; await takeReveal(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(button => button.addEventListener('click', () => run(() => navigate(button.dataset.nav as NavigationKind))));
  filter.addEventListener('input', renderResults);
  resultList.addEventListener('change', () => run(async () => { const i = Number(resultList.value); if (!resultList.value || !locations[i]) return; const generation = ++previewGeneration; const text = await request('preview', { query, version: resultVersion, location: locations[i] }); if (generation === previewGeneration) preview.textContent = text; }));
  element('open-result').addEventListener('click', () => run(async () => { if (!resultList.value) throw new Error('Select a result'); const location = locations[Number(resultList.value)]; if (!location) throw new Error('Result no longer available'); await navigation.open(query, location); }));
  element('back').addEventListener('click', () => run(() => navigation.history('back', position(view.state.selection.main.head))));
  element('forward').addEventListener('click', () => run(() => navigation.history('forward', position(view.state.selection.main.head))));
  const revealSubscription = orca.plugin.on('revealAvailable', () => run(takeReveal));
  window.addEventListener('pagehide', () => { navigation.unbind(); revealSubscription.dispose(); void request('detach').catch(() => {}); binding.dispose(); view.destroy(); }, { once: true });
}
void main().catch(error => { document.querySelector<HTMLElement>('#error')!.textContent = `Unable to open editor: ${String(error)}`; });
