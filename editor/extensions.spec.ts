import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { editorExtensions } from './extensions';
import { languageFromFileType } from './file-type';

test('file type uses only explicitly recognized suffixes', () => {
  assert.equal(languageFromFileType('go'), 'go');
  assert.equal(languageFromFileType('.CS'), 'csharp');
  assert.equal(languageFromFileType(undefined), undefined);
  assert.equal(languageFromFileType('other'), undefined);
});

test('C# and Go use their respective language parsers', () => {
  const cs = EditorState.create({ doc: 'class Person {}', extensions: editorExtensions('csharp', false) });
  const go = EditorState.create({ doc: 'package main\nfunc main() {}', extensions: editorExtensions('go', false) });
  assert.match(syntaxTree(cs).toString(), /TypeIdentifier/);
  assert.match(syntaxTree(go).toString(), /PackageClause/);
});

test('read-only editor state rejects editing commands', () => {
  const state = EditorState.create({ doc: 'class X {}', extensions: editorExtensions('csharp', true) });
  assert.equal(state.readOnly, true);
});
