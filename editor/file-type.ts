import type { Language } from './extensions';

/** Orca documents guarantee fileType for bytes only; use it when explicitly present. */
export function languageFromFileType(value: string | undefined): Language | undefined {
  switch (value?.toLowerCase().replace(/^\./, '')) {
    case 'go': return 'go';
    case 'cs': return 'csharp';
    default: return undefined;
  }
}
