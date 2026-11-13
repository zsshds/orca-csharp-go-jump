import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { go } from '@codemirror/lang-go';
import { csharp } from '@replit/codemirror-lang-csharp';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

export type Language = 'csharp' | 'go';

export function editorExtensions(language: Language, readOnly: boolean): Extension {
  return [basicSetup, language === 'go' ? go() : csharp(), keymap.of([indentWithTab]),
    EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}
