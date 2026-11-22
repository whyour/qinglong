import { promises as fs } from 'fs';
import path from 'path';
import { resolveFileAccess } from './fileAccess';

export type DirectoryVersion = [string, string | null];

function isGone(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function directoryVersion(
  root: string,
  parent: string,
  blacklist: string[],
) {
  const dir = parent ? resolveFileAccess(root, [parent], blacklist) : root;
  const denied = () =>
    Object.assign(new Error('Invalid directory'), { status: 403 });
  if (!dir) throw denied();
  try {
    if ((await fs.realpath(dir)) !== path.join(root, parent)) throw denied();
    const stat = await fs.lstat(dir, { bigint: true });
    return stat.isDirectory()
      ? [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join(':')
      : null;
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

export async function checkDirectoryVersions(
  root: string,
  blacklist: string[],
  versions: DirectoryVersion[],
) {
  const realRoot = await fs.realpath(root);
  const matches = await Promise.all(
    versions.map(async ([parent, expected]) => {
      try {
        return (
          (await directoryVersion(realRoot, parent, blacklist)) === expected
        );
      } catch (error) {
        // A formerly accessible directory may now be a symlink outside the root.
        if ((error as { status?: number }).status === 403) return false;
        throw error;
      }
    }),
  );
  return matches.every(Boolean);
}

export async function readDirectoryPage(
  root: string,
  blacklist: string[],
  directory: string,
  after: string,
  search: string,
  foldersOnly: boolean,
  newestFirst: boolean,
  limit = 50,
) {
  const blocked = new Set(blacklist.map((name) => name.toLowerCase()));
  const realRoot = await fs.realpath(root);
  const versions: DirectoryVersion[] = [];
  async function entries(parent: string) {
    const version = await directoryVersion(realRoot, parent, blacklist);
    versions.push([parent, version]);
    if (version === null) return [];
    try {
      return (
        await fs.readdir(path.join(realRoot, parent), { withFileTypes: true })
      ).filter(
        (e) =>
          !blocked.has(e.name.toLowerCase()) &&
          (e.isDirectory() || (!foldersOnly && e.isFile())),
      );
    } catch (error) {
      if (isGone(error)) return [];
      throw error;
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [];
  let next: string | null = null;
  async function row(parent: string, title: string, directory: boolean) {
    const key = path.join(parent, title);
    if (directory)
      return { title, parent, key, type: 'directory', isLeaf: false };
    try {
      const stat = await fs.lstat(path.join(root, key));
      if (stat.isFile())
        return {
          title,
          parent,
          key,
          type: 'file',
          isLeaf: true,
          size: stat.size,
        };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  if (!search) {
    const sorted = (await entries(directory)).sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        compare(a.name, b.name) * (newestFirst && !a.isDirectory() ? -1 : 1),
    );
    const selected = sorted.filter((e) => {
      if (!after) return true;
      const group = e.isDirectory() ? '0' : '1';
      return (
        group > after[0] ||
        (group === after[0] &&
          compare(e.name, after.slice(1)) *
            (newestFirst && !e.isDirectory() ? -1 : 1) >
            0)
      );
    });
    const page = selected.slice(0, limit);
    const data = (
      await Promise.all(
        page.map((e) => row(directory, e.name, e.isDirectory())),
      )
    ).filter(Boolean);
    if (selected.length > limit) {
      const last = page[page.length - 1];
      next = (last.isDirectory() ? '0' : '1') + last.name;
    }
    return { data, next, versions };
  }
  // Resume a depth-first search at the last visited entry, including on pages with zero matches.
  async function* walk(
    parent: string,
    resume: string[],
  ): AsyncGenerator<{ parent: string; name: string; dir: boolean }> {
    const items = (await entries(parent)).sort((a, b) =>
      compare(a.name, b.name),
    );
    for (const item of items) {
      if (resume.length && item.name < resume[0]) continue;
      const same = item.name === resume[0];
      if (!same) yield { parent, name: item.name, dir: item.isDirectory() };
      if (item.isDirectory()) {
        try {
          yield* walk(
            path.join(parent, item.name),
            same ? resume.slice(1) : [],
          );
        } catch (error) {
          if (!isGone(error) && (error as { status?: number }).status !== 403)
            throw error;
        }
      }
    }
  }
  let visited = 0;
  for await (const entry of walk('', after ? after.split('/') : [])) {
    const key = path.join(entry.parent, entry.name);
    if (key.toLowerCase().includes(search.toLowerCase())) {
      const item = await row(entry.parent, entry.name, entry.dir);
      if (item) rows.push(item);
    }
    if (++visited >= 512 || rows.length === limit) {
      next = key;
      break;
    }
  }
  return { data: rows, next, versions };
}
