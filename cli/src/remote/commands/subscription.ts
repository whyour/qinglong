import { translate } from '../../shared/i18n/index';
import type { Invocation } from '../../shared/cli/arguments';
import { isRecord, request } from '../api/client';
import { session } from './auth';
import { fail } from '../../shared/errors';
import type { ApiResponse, LogResponse } from '../../shared/types';


// Subscription API records can contain private repository credentials and hooks.
// The management view deliberately exposes only the fields needed for selection.
const visibleFields = [
  'id',
  'name',
  'alias',
  'type',
  'status',
  'is_disabled',
  'schedule',
  'schedule_type',
  'interval_schedule',
  'branch',
  'whitelist',
  'blacklist',
  'dependences',
  'extensions',
  'autoAddCron',
  'autoDelCron',
  'createdAt',
  'updatedAt',
];

function projectSubscription(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  )
    fail(translate(process.env, '订阅响应无效。'));
  return Object.fromEntries(
    visibleFields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}

export async function subscription(
  command: Invocation,
): Promise<ApiResponse<unknown> | LogResponse> {
  const config = await session();
  const action = command.name.split(' ')[1]!;
  if (action === 'list') {
    const search =
      typeof command.values.search === 'string'
        ? `?${new URLSearchParams({ searchValue: command.values.search })}`
        : '';
    const result = await request(config, `subscriptions${search}`);
    if (!Array.isArray(result.data))
      fail(translate(process.env, '订阅列表响应无效。'));
    return { code: 200, data: result.data.map(projectSubscription) };
  }
  const id = Number(command.positionals[0]);
  if (action === 'get') {
    const result = projectSubscription(
      (await request(config, `subscriptions/${id}`)).data,
    );
    if (result.id !== id)
      fail(translate(process.env, '返回的订阅 ID 与请求不一致。'));
    return { code: 200, data: result };
  }
  if (action === 'logs') {
    const result = await request(config, `subscriptions/${id}/log`);
    if (typeof result.data !== 'string')
      fail(translate(process.env, '订阅日志响应无效。'));
    const lines = result.data.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const count = Number(command.values.tail);
    return {
      code: 200,
      data: lines.slice(-count).join('\n'),
      truncated: result.truncated === true || lines.length > count,
    };
  }
  if (!['run', 'stop', 'enable', 'disable'].includes(action))
    fail(translate(process.env, '不支持的订阅操作。'), 2);
  await request(config, `subscriptions/${action}`, {
    method: 'PUT',
    body: [id],
  });
  return { code: 200, data: { subscriptionId: id, action, accepted: true } };
}
