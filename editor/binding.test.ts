import { assert, mockEditorHost, test } from 'orca/testing';
import { start, bindEditor } from './sync';

test('host replacements update the editor without echoing an edit', async () => {
  const host = mockEditorHost({ text: 'before' });
  const doc = await start(() => {});
  let resolveReplacement!: (text: string) => void;
  const replacement = new Promise<string>((resolve) => { resolveReplacement = resolve; });
  const binding = bindEditor(doc, resolveReplacement);
  host.replace('after');
  assert.equal(await replacement, 'after');
  binding.changed('after');
  await host.flush();
  assert.equal(host.edits.length, 0);
  binding.dispose(); host.dispose();
});
