import { readFile, stat, lstat } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import {
  openOperations,
  type OpenOperation,
} from '../framework/openOperations';
import { request, isRecord } from '../api/client';
import { session } from './auth';
import { panelUrl } from '../config/url';
import { integer, type Invocation } from '../arguments';
import { fail } from '../errors';
import type { ApiResponse } from '../types';

function usage(zh: string, en: string): never {
  return fail(process.env.QL_LANG === 'en' ? en : zh, 2);
}

async function input(value: string | boolean | undefined): Promise<unknown> {
  if (typeof value !== 'string') return undefined;
  let source = value;
  try {
    if (value === '-') {
      if (process.stdin.isTTY)
        usage('请通过管道提供 JSON。', 'Pipe JSON to stdin.');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 50 * 1024 * 1024) throw new Error('Too large');
        chunks.push(buffer);
      }
      source = Buffer.concat(chunks).toString('utf8');
    } else if (value.startsWith('@')) {
      const file = value.slice(1);
      const info = await stat(file);
      if (!info.isFile() || info.size > 50 * 1024 * 1024)
        throw new Error('Invalid input');
      source = await readFile(file, 'utf8');
    }
    return JSON.parse(source);
  } catch {
    return usage(
      'JSON 输入无效或文件无法读取。',
      'Invalid JSON input or unreadable file.',
    );
  }
}

function route(method: string, path: string): OpenOperation {
  const match = openOperations.find(
    (op) =>
      op.method === method &&
      new RegExp(
        '^' + op.path.replace(/:[A-Za-z]+/g, '[1-9][0-9]*') + '$',
      ).test(path),
  );
  if (!match)
    usage(
      '方法或路径不属于当前支持的 OpenAPI。',
      'Method/path is not a supported OpenAPI route.',
    );
  for (const [index, part] of match.path.split('/').entries())
    if (part.startsWith(':')) integer(path.split('/')[index]!);
  return match;
}

function redactApps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactApps);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['client_secret', 'tokens'].includes(key))
      .map(([key, item]) => [key, redactApps(item)]),
  );
}

export async function openCommand(
  command: Invocation,
): Promise<ApiResponse<unknown>> {
  if (command.name === 'api routes') return { code: 200, data: openOperations };
  const generic = command.name === 'api request';
  const values = command.values;
  if (values.data === '-' && values.query === '-')
    usage(
      '--data 和 --query 不能同时读取 stdin。',
      '--data and --query cannot both read stdin.',
    );
  let endpoint = generic
    ? command.positionals[1]!.replace(/^\/open\//, '').replace(/^\//, '')
    : '';
  if (generic && (!/^[\w/-]+$/.test(endpoint) || endpoint.includes('//')))
    usage(
      '请使用相对 OpenAPI 路径，查询参数通过 --query 提供。',
      'Use a relative OpenAPI path; pass query parameters with --query.',
    );
  const op = generic
    ? route(command.positionals[0]!.toUpperCase(), endpoint)
    : openOperations.find((item) => item.name === command.name)!;
  if (!op) usage('未知 OpenAPI 命令。', 'Unknown OpenAPI command.');
  let body = await input(values.data);
  const query = await input(values.query);
  if (query !== undefined && !isRecord(query))
    usage('--query 必须为 JSON 对象。', '--query must be a JSON object.');
  if (!generic) {
    endpoint = op.path;
    for (const [index, name] of (op.params ?? []).entries()) {
      const value = integer(command.positionals[index]!);
      endpoint = endpoint.replace(`:${name}`, String(value));
      if (op.body === 'object-id') {
        if (body !== undefined && !isRecord(body))
          usage('--data 必须为 JSON 对象。', '--data must be a JSON object.');
        if (isRecord(body) && body.id !== undefined && body.id !== value)
          usage(
            '请求体 ID 与命令 ID 不一致。',
            'Body ID differs from command ID.',
          );
        body = { ...(body as Record<string, unknown>), id: value };
      }
    }
    if (op.body === 'ids')
      body = command.positionals.map((value) => integer(value));
    for (const key of [
      'name',
      'command',
      'schedule',
      'type',
      'url',
      'alias',
      'schedule-type',
      'branch',
      'whitelist',
      'blacklist',
      'scopes',
    ]) {
      if (values[key] === undefined) continue;
      if (body !== undefined && !isRecord(body))
        usage('--data 必须为 JSON 对象。', '--data must be a JSON object.');
      const field = key.replace(/-/g, '_');
      if (isRecord(body) && Object.hasOwn(body, field))
        usage(
          '字段不能同时通过 --data 和选项提供。',
          'Do not provide a field in both --data and flags.',
        );
      body = {
        ...(body as Record<string, unknown>),
        [field]:
          key === 'scopes'
            ? String(values[key])
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : values[key],
      };
    }
    const required: Record<string, string[]> = {
      'task create': ['command', 'schedule'],
      'task update': ['command', 'schedule'],
      'subscription create': ['type', 'url', 'alias', 'schedule_type'],
      'subscription update': ['type', 'url', 'alias'],
    };
    if (
      (required[op.name] ?? []).some(
        (key) => !isRecord(body) || typeof body[key] !== 'string' || !body[key],
      )
    )
      usage(
        '缺少必需字段，请查看命令帮助和 OpenAPI 参考。',
        'Missing required fields; see command help and OpenAPI reference.',
      );
  }
  if (op.method === 'GET' && body !== undefined)
    usage('GET 不接受请求体。', 'GET does not accept a body.');
  if (op.body && body === undefined && !values.file)
    usage(
      '此命令需要 --data 或对应字段选项。',
      'This command needs --data or field options.',
    );
  if (values.file) {
    if (!op.upload)
      usage('此接口不支持文件上传。', 'This route does not accept uploads.');
    if (body !== undefined && !isRecord(body))
      usage(
        '上传字段必须为 JSON 对象。',
        'Upload fields must be a JSON object.',
      );
    const form = new FormData();
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!['string', 'number', 'boolean'].includes(typeof value))
        usage('上传字段必须为标量。', 'Upload fields must be scalars.');
      form.append(key, String(value));
    }
    try {
      const file = String(values.file);
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
      form.append(op.upload, await openAsBlob(file), basename(file));
    } catch {
      usage('上传文件无法读取。', 'Cannot read upload file.');
    }
    body = form;
  } else if (op.upload && op.path !== 'scripts')
    usage('此接口需要 --file。', 'This route requires --file.');
  if (op.download && !values.output)
    usage('此接口需要 --output 保存响应。', 'This route requires --output.');
  if (values.output) {
    if (!op.download)
      usage('此接口不支持 --output。', 'This route does not support --output.');
    try {
      await lstat(String(values.output));
      usage('输出文件已存在。', 'Output file already exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (
        item === null ||
        !['string', 'number', 'boolean'].includes(typeof item)
      )
        usage(
          '查询参数必须为标量或标量数组。',
          'Query values must be scalars or arrays of scalars.',
        );
      params.append(key, String(item));
    }
  }
  if (params.size) endpoint += `?${params}`;
  const config = op.anonymous
    ? {
        url: panelUrl(process.env.QL_URL || ''),
        clientId: '',
        clientSecret: '',
      }
    : await session();
  const result = await request(config, endpoint, {
    method: op.method,
    body,
    authenticated: !op.anonymous,
    output: values.output as string | undefined,
    text: op.path === 'system/log',
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
  });
  const data =
    op.path.startsWith('apps') && !values['show-secrets']
      ? redactApps(result.data)
      : result.data;
  return { ...result, code: 200, data: data ?? null };
}
