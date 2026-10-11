import { shellQuote } from './shellQuote';

const repositoryNames =
  /^(debian(?:-security)?|ubuntu(?:-ports)?|alpine|armbian)$/;

export function normalizeMirror(mirror: string): URL {
  if (/\s/.test(mirror)) throw new Error('Invalid Linux mirror URL');
  const url = new URL(mirror);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Linux mirror must be an HTTP(S) URL without credentials, query or fragment',
    );
  }
  return url;
}

export function replaceMirrorUrl(current: string, mirror: string): string {
  const target = normalizeMirror(mirror);
  const previous = new URL(current);
  const oldSegments = previous.pathname.split('/').filter(Boolean);
  const newSegments = target.pathname.split('/').filter(Boolean);
  const repositoryIndex = oldSegments.findIndex((part) =>
    repositoryNames.test(part),
  );
  const targetIndex = newSegments.findIndex((part) =>
    repositoryNames.test(part),
  );
  const prefix =
    targetIndex >= 0 ? newSegments.slice(0, targetIndex) : newSegments;
  if (repositoryIndex >= 0) {
    const repository = oldSegments[repositoryIndex];
    let suffix = oldSegments.slice(repositoryIndex + 1);
    // Repair paths already corrupted by repeated authority-only replacement.
    while (suffix[0] === repository) suffix.shift();
    return `${target.origin}/${[...prefix, repository, ...suffix].join('/')}`;
  }
  // Unknown repository paths: a full URL replaces the old root, a hostname
  // preserves it. Never append the newly entered root to the existing root.
  return `${target.origin}/${(newSegments.length
    ? newSegments
    : oldSegments
  ).join('/')}`;
}

export function rewriteMirrorSources(content: string, mirror: string): string {
  normalizeMirror(mirror);
  return content
    .split('\n')
    .map((line) => {
      if (!/^\s*(?:URIs:|deb(?:-src)?\s|https?:\/\/)/.test(line)) return line;
      return line.replace(/https?:\/\/[^\s#]+/g, (url) =>
        replaceMirrorUrl(url, mirror),
      );
    })
    .join('\n');
}

export function mirrorWriteCommand(
  file: string,
  content: string,
  prefix: string,
  update: string,
): string {
  return `${prefix}mkdir -p ${shellQuote(
    file.slice(0, file.lastIndexOf('/')),
  )} && printf '%s' ${shellQuote(content)} | ${prefix}tee ${shellQuote(
    file,
  )} >/dev/null && ${update}`;
}
