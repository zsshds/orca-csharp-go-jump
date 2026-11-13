import type { EditorSession } from 'orca/frame';

// Orca owns saving and conflict resolution; do not write the file directly.
export function start(onConflict: (draft: string) => void) {
  if (!orca.document) throw new Error('This panel must run as an Orca custom editor');
  return orca.document.session<string>({ merge(base, outside, mine) {
    if (mine !== base && mine !== outside) onConflict(mine);
    return outside;
  } });
}

export function bindEditor(doc: EditorSession<string>, replace: (text: string) => void) {
  const subscription = doc.onReplace(replace);
  return {
    changed(text: string) {
      if (!doc.readOnly && text !== doc.value) doc.change(text);
    },
    dispose() {
      subscription.dispose();
      doc.dispose();
    }
  };
}
