export function fileExcludedFromSync(file: string, exclusions?: string): boolean {
  const candidate = file.split('\\').join('/').replace(/^\.\//, '');
  return (exclusions || '').split(/\r?\n/).some((entry) => {
    const protectedPath = entry.replace(/^\.\//, '');
    return !!protectedPath && (candidate === protectedPath ||
      (protectedPath.endsWith('/') && candidate.startsWith(protectedPath)));
  });
}
