import { fail } from '../../shared/errors';
import type { Invocation } from '../../shared/cli/arguments';
import type { ApiResponse, LogResponse } from '../../shared/types';

export async function dispatch(
  command: Invocation,
): Promise<ApiResponse<unknown> | LogResponse> {
  const { name } = command;
  if (!name.startsWith('local '))
    fail('Internal dispatcher requires a local command.', 2);
  const { maintenance } = await import('../maintenance/maintenance');
  const action = name.slice('local '.length);
  if (
    [
      'update',
      'reload',
      'rmlog',
      'extra',
      'bot',
      'check',
      'resetlet',
      'resettfa',
      'resetpwd',
      'resetname',
    ].includes(action)
  ) {
    const { localContext } = await import('../runtime/context');
    const { loggedOperation } = await import('../runtime/commandLog');
    const { operationSignal } = await import('../runtime/cancellation');
    const signal = operationSignal();
    const context = await localContext(command, { signal });
    const { result, logPath } = await loggedOperation(
      context,
      action,
      () => maintenance(command, context),
      signal,
    );
    const response = { code: 200 as const, data: result, logPath };
    return response;
  }
  return { code: 200, data: await maintenance(command) };
}
