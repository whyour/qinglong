import { dispatchRemote } from './remoteDispatch';
import type { Invocation } from '../arguments';
import type { ApiResponse, LogResponse } from '../types';

export async function dispatch(
  command: Invocation,
): Promise<ApiResponse<unknown> | LogResponse> {
  const { name } = command;
  if (!name.startsWith('local ')) return dispatchRemote(command);
  const { maintenance } = await import('../local/maintenance');
  const action = name.slice('local '.length);
  if (['update', 'reload', 'rmlog', 'extra', 'bot', 'check',
    'resetlet', 'resettfa', 'resetpwd', 'resetname'].includes(action)) {
    const { localContext } = await import('../local/context');
    const { loggedOperation } = await import('../local/commandLog');
    const { operationSignal } = await import('../local/cancellation');
    const signal = operationSignal();
    const context = await localContext(command, { signal });
    const { result, logPath } = await loggedOperation(
      context, action, () => maintenance(command, context), signal,
    );
    const response = { code: 200 as const, data: result, logPath };
    return response;
  }
  return { code: 200, data: await maintenance(command) };
}
