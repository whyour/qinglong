import { translate } from '../i18n';
import { extendedLifecycle } from './lifecycle';
import { within } from './files';
import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalContext } from './context';
import { LocalApi } from './api';
import { CliError } from '../errors';
import { withOperationOutput } from './output';
import { cancellableOperation, interruptedCode } from './cancellation';

export async function loggedOperation<T>(
  context: LocalContext,
  action: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<{ result: T; logPath: string }> {
  if (!/^[a-z]+$/.test(action))
    throw new Error(translate(context.env, '命令日志目录无效。'));
  const start = Date.now(),
    started = Math.floor(start / 1000);
  const date = new Date(start);
  const stamp = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]
    .map((value) => String(value).padStart(2, '0'))
    .join('-');
  const logPath = context.env.real_log_path || `${action}/${stamp}.log`;
  const file = within(context.paths.dir_log!, logPath, context.env);
  const persist = context.env.real_time !== 'true';
  if (persist) await fs.mkdir(path.dirname(file), { recursive: true });
  const log = persist ? await fs.open(file, 'a', 0o600) : undefined;
  const output = (chunk: Buffer) => {
    let offset = 0;
    while (log && offset < chunk.length)
      offset += writeSync(log.fd, chunk, offset);
    if (context.env.real_time === 'true' || context.env.no_tee !== 'true')
      process.stderr.write(chunk);
  };
  const id = Number(context.env.ID);
  const extended = await extendedLifecycle(context);
  const executionId =
    extended && context.env.QL_EXECUTION_ORIGIN === 'scheduled_system'
      ? `legacy-system:${started}:${randomUUID()}`
      : undefined;
  const api = new LocalApi(context);
  const report = async (final: boolean, code: number) => {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    try {
      await api.call('crons/status', 'PUT', {
        ids: [id],
        status: final ? '1' : '0',
        pid: String(process.pid),
        log_path: logPath,
        last_execution_time: started,
        last_running_time: final ? Math.floor((Date.now() - start) / 1000) : 0,
        ...(final && extended ? { exit_code: code } : {}),
        ...(executionId ? { execution_id: executionId } : {}),
      });
    } catch {
      output(
        Buffer.from(
          translate(context.env, '命令状态上报失败，请检查本机面板。\n'),
        ),
      );
    }
  };
  let code = 1;
  try {
    await report(false, 0);
    if (!['repo', 'raw'].includes(action))
      output(
        Buffer.from(
          translate(context.env, '## 开始执行... %s\n', date.toISOString()),
        ),
      );
    const result = await withOperationOutput(output, () =>
      cancellableOperation(signal, operation),
    );
    code = 0;
    return { result, logPath };
  } catch (error) {
    code =
      interruptedCode(signal) ??
      (error instanceof CliError ? error.exitCode : 1);
    output(
      Buffer.from(
        `Command failed (exit ${code}); inspect the command result.\n`,
      ),
    );
    throw error;
  } finally {
    try {
      await report(true, code);
      if (!['repo', 'raw'].includes(action))
        output(
          Buffer.from(
            translate(
              context.env,
              '\n## 执行结束... %s 退出码 %s\n',
              new Date().toISOString(),
              code,
            ),
          ),
        );
    } finally {
      await log?.close();
    }
  }
}
