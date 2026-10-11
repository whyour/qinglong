import type { Subscription } from '../data/subscription';
import { formatUrl } from '../config/subscription';
import path from 'path';
import fs from 'fs';
import { resolveFileAccess } from './fileAccess';

// Storage namespaces come from URLs and branches, not user aliases. In
// particular, a legal Git directory can exceed the alias's 200-character limit.
export function isSubscriptionStorageName(name: string): boolean {
  return (
    typeof name === 'string' &&
    !!name &&
    !path.isAbsolute(name) &&
    !/[\0\r\n\\]/.test(name) &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

export function resolveSubscriptionStoragePath(
  root: string,
  name: string,
): string | undefined {
  const target = isSubscriptionStorageName(name)
    ? resolveFileAccess(root, [name])
    : '';
  if (!target) {
    if (isSubscriptionStorageName(name)) {
      try {
        fs.lstatSync(path.resolve(root, name));
      } catch (error: any) {
        // A long query can make the Shell candidate unrepresentable while
        // the CLI's pathname-based file exists. Use the actual filesystem
        // limit: macOS permits Unicode names exceeding 255 UTF-8 bytes.
        if (error.code === 'ENAMETOOLONG') return undefined;
      }
    }
    throw Object.assign(new Error('Invalid subscription path'), {
      status: 400,
    });
  }
  return target;
}

/** Match shell/update.sh get_uniq_path and update_raw, including SCP URLs. */
export function getSubscriptionStorageNames(
  doc: Subscription,
  engine: 'shell' | 'cli' = 'shell',
): {
  script: string;
  repo?: string;
  raw?: string;
} {
  // Old imported rows may only have an alias and no URL.
  if (!doc.url) return { script: doc.alias, repo: doc.alias };
  const url = formatUrl(doc).url!;
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  const repo = dot < 0 ? basename : basename.slice(0, dot);
  const parentUrl = engine === 'cli' ? trimmed : url;
  const slash = parentUrl.lastIndexOf('/');
  const parent =
    engine === 'shell' && slash < 0 ? url : parentUrl.slice(0, slash);
  const owner = parent.slice(parent.lastIndexOf('/') + 1);
  const author = owner.slice(owner.lastIndexOf(':') + 1);
  const stem = `${author.slice(author.lastIndexOf('.') + 1)}_${repo}`;
  if (doc.type === 'file') {
    const suffix =
      engine === 'cli'
        ? path.extname(new URL(url).pathname)
        : `.${url.slice(url.lastIndexOf('.') + 1)}`;
    const raw = `${stem}${suffix}`;
    return { script: `raw_${raw}`, raw };
  }
  const directory = doc.branch ? `${stem}_${doc.branch}` : stem;
  return { script: directory, repo: directory };
}

// A subscription may have run through either engine before being deleted.
export function getSubscriptionStorageCandidates(doc: Subscription) {
  const candidates: ReturnType<typeof getSubscriptionStorageNames>[] = [];
  for (const engine of ['shell', 'cli'] as const) {
    try {
      candidates.push(getSubscriptionStorageNames(doc, engine));
    } catch {
      // Historical rows may have an invalid SSH alias or missing credentials.
      // Retain their URL-derived storage without needing an executable SSH URL.
      try {
        candidates.push(
          getSubscriptionStorageNames(
            {
              url: doc.url,
              alias: doc.alias,
              branch: doc.branch,
              type: doc.type === 'private-repo' ? 'public-repo' : doc.type,
            },
            engine,
          ),
        );
      } catch {
        // One engine's invalid URL must not hide the other engine's candidate.
      }
    }
  }
  return candidates;
}
