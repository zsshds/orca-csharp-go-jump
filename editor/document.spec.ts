import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditorState, Compartment } from '@codemirror/state';
import { editorExtensions } from './extensions';
import { createDocumentState, documentText, replaceDocument } from './document';
import { history, undoDepth } from '@codemirror/commands';
import { bindEditor } from './sync';
import type { EditorSession } from 'orca/frame';

test('local edit preserves CRLF when serialized to the host', () => {
  const initial = 'package main\r\nfunc main() {\r\n}\r\n';
  const state = createDocumentState(initial, []);
  const edited = state.update({ changes: { from: 8, to: 12, insert: 'demo' } }).state;
  assert.equal(documentText(edited), 'package demo\r\nfunc main() {\r\n}\r\n');
});

test('host replacement resets the newline convention for subsequent edits', () => {
  let state = createDocumentState('one\r\ntwo\r\n', []);
  state = createDocumentState('outside\r\nchanged\r\n', []);
  state = state.update({ changes: { from: 0, to: 7, insert: 'host' } }).state;
  assert.equal(documentText(state), 'host\r\nchanged\r\n');
  state = createDocumentState('one\ntwo\n', []);
  state = state.update({ changes: { from: 0, to: 3, insert: 'three' } }).state;
  assert.equal(documentText(state), 'three\ntwo\n');
});

test('CRLF edits and external replacement round-trip through the session binding', () => {
  let value = 'first\r\nsecond\r\n';
  let replace!: (value: string) => void;
  const doc: EditorSession<string> = {
    get value() { return value; }, readOnly: false,
    change(next) { value = next; },
    async flush() {},
    onReplace(handler) { replace = handler; return { dispose() {} }; },
    dispose() {}
  };
  let state = createDocumentState(value, []);
  const binding = bindEditor(doc, text => { state = createDocumentState(text, []); });
  state = state.update({ changes: { from: 0, to: 5, insert: 'local' } }).state;
  binding.changed(documentText(state));
  assert.equal(value, 'local\r\nsecond\r\n');
  value = 'outside\r\nnext\r\n';
  replace(value);
  state = state.update({ changes: { from: 0, to: 7, insert: 'host' } }).state;
  binding.changed(documentText(state));
  assert.equal(value, 'host\r\nnext\r\n');
  binding.dispose();
});

test('host replacement preserves history and changes line ending protection', () => {
  let state = createDocumentState('one\n', [history()]);
  state = state.update({ changes: { from: 0, insert: 'local ' } }).state;
  assert.ok(undoDepth(state) > 0);
  state = replaceDocument(state, 'local one\r\noutside\r\n').state;
  assert.ok(undoDepth(state) > 0);
  assert.equal(documentText(state), 'local one\r\noutside\r\n');
  state = replaceDocument(state, 'one\r\ntwo\n').state;
  assert.equal(state.readOnly, true);
  state = replaceDocument(state, 'outside\n').state;
  assert.equal(state.readOnly, false);
});

test('mixed newline documents are protected from edits and serialization', () => {
  for (const text of ['one\r\ntwo\nthree\r\n', 'one\rtwo\n']) {
    const state = createDocumentState(text, []);
    assert.equal(state.readOnly, true);
    const after = state.update({ changes: { from: 0, to: 3, insert: 'changed' } }).state;
    assert.equal(after.doc.toString(), state.doc.toString());
    assert.throws(() => documentText(state), /mixed/i);
  }
});

test('changing language cannot remove mixed newline protection', () => {
  const compartment = new Compartment();
  let state = createDocumentState('a\r\nb\n', compartment.of(editorExtensions('csharp', false)));
  state = state.update({ effects: compartment.reconfigure(editorExtensions('go', false)) }).state;
  assert.equal(state.facet(EditorState.readOnly), true);
  assert.equal(state.update({ changes: { from: 0, to: 1, insert: 'x' } }).state.doc.toString(), state.doc.toString());
});

test('host replacement can enter and leave mixed newline protection', () => {
  assert.equal(createDocumentState('a\r\nb\r\n', []).readOnly, false);
  assert.equal(createDocumentState('a\r\nb\n', []).readOnly, true);
  assert.equal(createDocumentState('a\nb\n', []).readOnly, false);
});

test('dark editor has explicit visible cursor and selection colors', () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.match(css, /\.cm-cursor\s*\{[^}]*border-left-color:\s*#fff/i);
  assert.match(css, /\.cm-selectionBackground[^\{]*\{[^}]*background(?:-color)?:\s*#456b9a/i);
});
