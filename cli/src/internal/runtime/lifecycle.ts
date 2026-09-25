import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalContext } from './context';

// The released 2.20 API rejects unknown lifecycle fields and has no dashboard record API.
// Read the installed panel version, never the independently versioned CLI package.
export async function extendedLifecycle(
  context: LocalContext,
): Promise<boolean> {
  if (context.env.QL_CLI_LIFECYCLE === 'legacy') return false;
  if (context.env.QL_CLI_LIFECYCLE === 'extended') return true;
  let version: string | undefined;
  try {
    const manifest: unknown = JSON.parse(
      await fs.readFile(path.join(context.root, 'package.json'), 'utf8'),
    );
    if (
      manifest &&
      typeof manifest === 'object' &&
      'version' in manifest &&
      typeof manifest.version === 'string'
    )
      version = manifest.version;
  } catch {}
  if (version === undefined) {
    try {
      // Official 2.x images may omit package.version. Read only the top-level
      // scalar release field; no YAML dependency or expression evaluation.
      const release = await fs.readFile(
        path.join(context.root, 'version.yaml'),
        'utf8',
      );
      const entries = release
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => /^version:/.test(line));
      if (entries.length !== 1) return false;
      const scalar =
        /^version:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))[ \t]*(?:#.*)?$/.exec(
          entries[0]!,
        );
      version = scalar?.[1] ?? scalar?.[2] ?? scalar?.[3];
    } catch {
      return false;
    }
  }
  const match = /^2\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version ?? '',
  );
  return !!match && Number(match[1]) >= 21;
}
