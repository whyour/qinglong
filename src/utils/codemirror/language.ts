import { langs } from '@uiw/codemirror-extensions-langs';

export function getCodeMirrorExtensions(mode: string) {
  // Monaco calls this language "ini"; CodeMirror exposes it as "properties".
  const language = mode === 'ini' ? 'properties' : mode;
  if (!Object.prototype.hasOwnProperty.call(langs, language)) {
    return [];
  }
  const factory = langs[language as keyof typeof langs];
  return typeof factory === 'function' ? [factory()] : [];
}
