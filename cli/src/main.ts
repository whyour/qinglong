import { invoke } from './invoke';
import type { CommandSurface } from './framework/registry';

export async function main(
  args = process.argv.slice(2),
  surface: CommandSurface = 'public',
  signal?: AbortSignal,
): Promise<number> {
  const interrupted = signal ? await import('./local/cancellation') : undefined;
  const dispatch =
    surface === 'public'
      ? (await import('./framework/remoteDispatch')).dispatchRemote
      : (await import('./framework/dispatch')).dispatch;
  return invoke(args, surface, dispatch, signal, () =>
    interrupted?.interruptedCode(signal!),
  );
}
