import type { Invocation } from '../arguments';
import type { ApiResponse, LogResponse } from '../types';

export async function dispatch(
  command: Invocation,
): Promise<ApiResponse<unknown> | LogResponse> {
  const { name, values, positionals } = command;
  if (name.startsWith('auth ')) {
    const { auth } = await import('../commands/auth');
    if (name === 'auth login')
      return auth({ kind: 'login', url: values.url as string });
    return name === 'auth logout'
      ? auth({ kind: 'logout' })
      : auth({
          kind: 'status',
          scope: values.scope as 'crons' | 'subscriptions',
        });
  }
  if (name.startsWith('task ')) {
    const { task } = await import('../commands/task');
    if (name === 'task list')
      return task({
        kind: 'list',
        page: Number(values.page),
        size: Number(values.size),
        search: values.search as string | undefined,
      });
    const id = Number(positionals[0]);
    if (name === 'task logs')
      return task({ kind: 'logs', id, tail: Number(values.tail) });
    return task({ kind: name.slice(5) as 'get' | 'run' | 'stop', id });
  }
  if (name.startsWith('subscription ')) {
    const { subscription } = await import('../commands/subscription');
    return subscription(command);
  }
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
