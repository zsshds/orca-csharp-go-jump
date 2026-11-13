import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// CodeMirror normalizes its internal document to LF. Mixed newline files cannot
// round-trip through that representation and are therefore protected.
const updateLineEnding = StateEffect.define<{ ending: string; mixed: boolean }>();
const protectionCompartment = new Compartment();
const lineEnding = StateField.define<{ ending: string; mixed: boolean }>({
  create: () => ({ ending: '\n', mixed: false }),
  update(value, transaction) { for (const effect of transaction.effects) if (effect.is(updateLineEnding)) value = effect.value; return value; }
});

export function hasMixedLineEndings(text: string): boolean {
  const endings = text.match(/\r\n|\r|\n/g) ?? [];
  return endings.some(ending => ending !== endings[0]);
}

function protection(mixed: boolean): Extension {
  return mixed ? Prec.highest([
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    EditorState.transactionFilter.of(transaction => transaction.docChanged ? [] : transaction)
  ]) : [];
}
function endingInfo(text: string) { return { ending: text.match(/\r\n|\r|\n/)?.[0] ?? '\n', mixed: hasMixedLineEndings(text) }; }
export function createDocumentState(text: string, extensions: Extension): EditorState {
  const info = endingInfo(text);
  return EditorState.create({ doc: text, extensions: [lineEnding.init(() => info), protectionCompartment.of(protection(info.mixed)), extensions] });
}
export function replaceDocument(state: EditorState, text: string): Transaction {
  const info = endingInfo(text);
  const normalized = text.replace(/\r\n|\r/g, '\n'), current = state.doc.toString();
  let from = 0, end = current.length, replacementEnd = normalized.length;
  while (from < end && from < replacementEnd && current[from] === normalized[from]) from++;
  while (end > from && replacementEnd > from && current[end - 1] === normalized[replacementEnd - 1]) { end--; replacementEnd--; }
  return state.update({ changes: { from, to: end, insert: normalized.slice(from, replacementEnd) }, effects: [updateLineEnding.of(info), protectionCompartment.reconfigure(protection(info.mixed))], annotations: Transaction.addToHistory.of(false), filter: false });
}

export function documentText(state: EditorState): string {
  const { ending, mixed } = state.field(lineEnding);
  if (mixed) throw new Error('Cannot serialize a mixed line ending document');
  return state.doc.sliceString(0, state.doc.length, ending);
}
