import { invoke } from '../../shared/cli/invoke';
import { registry } from './registry';
import { dispatch } from './dispatch';
export async function internalMain(
  args: string[],
  signal?: AbortSignal,
): Promise<number> {
  const interrupted = signal
    ? await import('../runtime/cancellation')
    : undefined;
  return invoke(args, registry, dispatch, signal, () =>
    interrupted?.interruptedCode(signal!),
  );
}
