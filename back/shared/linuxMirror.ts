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
    .split(/(\r?\n[ \t]*\r?\n)/)
    .map((stanza) => {
      const signedBy = stanza.match(/^Signed-By:\s*([^\r\n]*)/im)?.[1];
      return stanza
        .split('\n')
        .map((line) => {
          if (!/^\s*(?:URIs:|deb(?:-src)?\s|https?:\/\/)/.test(line))
            return line;
          const legacy = /^\s*deb(?:-src)?\s/.test(line);
          const key = legacy
            ? line.match(/\bsigned-by=([^\]\s]+)/i)?.[1]
            : signedBy;
          // In .list files a # starts an inline comment; its URLs are metadata.
          const comment = legacy ? line.indexOf('#') : -1;
          const source = comment < 0 ? line : line.slice(0, comment);
          const rewritten = source.replace(/https?:\/\/[^\s#]+/g, (url) =>
            isSystemRepository(url, key) ? replaceMirrorUrl(url, mirror) : url,
          );
          return rewritten + (comment < 0 ? '' : line.slice(comment));
        })
        .join('\n');
    })
    .join('');
}

function isSystemRepository(url: string, signedBy?: string): boolean {
  const keys =
    signedBy
      ?.trim()
      .split(/[\s,]+/)
      .filter(Boolean) || [];
  const archiveKeyring =
    keys.length > 0 &&
    keys.every((key) =>
      /\/(?:debian|ubuntu|armbian)-archive-keyring\.(?:gpg|asc)$/.test(key),
    );
  // A separate signing key identifies a third-party archive, even if its
  // repository happens to be called /debian or /ubuntu.
  if (keys.length > 0 && !archiveKeyring) return false;
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const repositoryIndex = segments.findIndex((part) =>
    repositoryNames.test(part),
  );
  if (repositoryIndex < 0) return false;
  // Without archive metadata, accept only conventional archive roots. A
  // vendor path such as Docker's /linux/debian is not the Debian archive.
  return (
    archiveKeyring ||
    repositoryIndex === 0 ||
    segments
      .slice(0, repositoryIndex)
      .every((part) => /^mirrors?$/.test(part)) ||
    segments[repositoryIndex] === 'alpine'
  );
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
