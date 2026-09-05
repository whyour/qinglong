import fs from 'fs';
import path from 'path';

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

/** Resolve existing files and not-yet-created children without following an
 * existing symlink outside the root. Blacklisted directories cover descendants. */
export function resolveFileAccess(
  root: string,
  parts: string[],
  blacklist: string[] = [],
): string {
  if (parts.some((part) => typeof part !== 'string' || part.includes('\0'))) {
    return '';
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  if (target === resolvedRoot || !isWithin(resolvedRoot, target)) return '';
  const isBlocked = (relative: string) =>
    relative.split(path.sep).some((part) => blacklist.includes(part));
  if (isBlocked(path.relative(resolvedRoot, target))) return '';
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = target;
    const missing: string[] = [];
    while (!fs.existsSync(existing)) {
      // existsSync is false for a dangling symlink; never treat one as absent.
      try {
        fs.lstatSync(existing);
        return '';
      } catch (error: any) {
        if (error.code !== 'ENOENT') return '';
      }
      if (existing === resolvedRoot) return '';
      missing.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
    const realTarget = path.resolve(fs.realpathSync(existing), ...missing);
    if (
      !isWithin(realRoot, realTarget) ||
      isBlocked(path.relative(realRoot, realTarget))
    ) {
      return '';
    }
    return target;
  } catch {
    return '';
  }
}
