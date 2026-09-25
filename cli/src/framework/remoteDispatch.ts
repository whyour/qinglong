import type { ApiResponse, LogResponse } from '../types';
import type { Invocation } from '../arguments';
import { fail } from '../errors';
import { translate } from '../i18n';

export async function dispatchRemote(command: Invocation): Promise<ApiResponse<unknown> | LogResponse> {
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
  return fail(translate(process.env, '未知命令，请运行 %s --help。', 'ql'), 2);
}
