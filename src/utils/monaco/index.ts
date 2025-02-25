import * as monaco from 'monaco-editor';

export function canPreviewInMonaco(fileName: string): boolean {
  const supportedLanguages = monaco.languages.getLanguages();
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return supportedLanguages.some((lang) => lang.extensions?.includes(ext));
}
