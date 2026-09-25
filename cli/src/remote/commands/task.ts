import { translate } from '../../shared/i18n/index';
import { isRecord, request } from '../api/client';
import { fail } from '../../shared/errors';
import type { ApiResponse, LogResponse } from '../../shared/types';
import type { Command, Task } from '../types';
import { session } from './auth';

type TaskCommand = Extract<
  Command,
  { kind: 'list' | 'get' | 'logs' | 'run' | 'stop' }
>;

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id > 0
  );
}

export async function task(
  command: TaskCommand,
): Promise<ApiResponse<unknown> | LogResponse> {
  const config = await session();
  if (command.kind === 'list') {
    const query = new URLSearchParams({
      page: String(command.page),
      size: String(command.size),
    });
    if (command.search !== undefined) query.set('searchValue', command.search);
    const result = await request(config, `crons?${query}`);
    const data = result.data;
    if (
      !isRecord(data) ||
      !Array.isArray(data.data) ||
      !data.data.every(isTask) ||
      typeof data.total !== 'number' ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0
    ) {
      fail(translate(process.env, '任务列表响应无效。'));
    }
    return { code: 200, data: { data: data.data, total: data.total } };
  }
  if (command.kind === 'get') {
    const result = await request(config, `crons/${command.id}`);
    if (!isTask(result.data) || result.data.id !== command.id)
      fail(translate(process.env, '任务响应无效。'));
    return { code: 200, data: result.data };
  }
  if (command.kind === 'logs') {
    const result = await request(config, `crons/${command.id}/log`);
    if (
      typeof result.data !== 'string' ||
      (result.logStatus !== undefined && typeof result.logStatus !== 'string')
    )
      fail(translate(process.env, '日志响应无效。'));
    const lines = result.data.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return {
      code: 200,
      data: lines.slice(-command.tail).join('\n'),
      logStatus: result.logStatus as string | undefined,
      truncated: lines.length > command.tail,
    };
  }
  await request(config, `crons/${command.kind}`, {
    method: 'PUT',
    body: [command.id],
  });
  return {
    code: 200,
    data: { taskId: command.id, action: command.kind, accepted: true },
  };
}
