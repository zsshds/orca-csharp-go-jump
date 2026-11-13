import { assert, mockEditorHost, test } from 'orca/testing';
import { start } from './sync';

test('conflicts preserve the draft for recovery without overwriting outside content', async () => {
  const host = mockEditorHost({ text: 'package main' });
  const drafts: string[] = [];
  const doc = await start(draft => drafts.push(draft));
  doc.change('package main\nfunc main() {}');
  await host.flush();
  assert.equal(host.text, 'package main\nfunc main() {}');
  doc.change('package main\nfunc local() {}');
  host.conflictNext('package main\nfunc external() {}');
  await host.flush().catch(() => {});
  assert.equal(host.text, 'package main\nfunc external() {}');
  assert.equal(doc.value, host.text);
  assert.equal(drafts[0], 'package main\nfunc local() {}');
  doc.dispose(); host.dispose();
});

test('read-only sessions do not send edits', async () => {
  const host = mockEditorHost({ text: 'class Example {}' }, { readOnly: true });
  const doc = await start(() => {});
  doc.change('class Changed {}');
  await host.flush();
  assert.equal(host.edits.length, 0);
  assert.equal(host.text, 'class Example {}');
  doc.dispose(); host.dispose();
});
