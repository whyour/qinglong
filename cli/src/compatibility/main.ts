import type { CommandSurface } from '../shared/cli/registry';
// Compatibility for existing programmatic callers; product entries select one surface.
export async function main(
  args = process.argv.slice(2),
  surface: CommandSurface = 'public',
  signal?: AbortSignal,
): Promise<number> {
  return surface === 'public'
    ? (await import('../entrypoints/remote')).remoteMain(args)
    : (await import('../internal/commands/main')).internalMain(args, signal);
}
