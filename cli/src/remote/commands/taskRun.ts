import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord, request } from '../api/client';
import type { StoredConfig } from '../types';
import { validTriggerId } from '../trigger';
import { CliError, fail } from '../../shared/errors';
import { CliResultError } from '../../shared/resultError';
import { translate } from '../../shared/i18n/index';

const states = [
  'queued',
  'running',
  'finished',
  'failed',
  'skipped',
  'stopped',
  'unknown',
];

export function runReceipt(result: Record<string, unknown>, taskId: number) {
  // Older panels return only {code:200}; keep the immediate-run contract.
  if (result.data === undefined || result.data === null) return undefined;
  const entries = Array.isArray(result.data)
    ? result.data.filter((row) => isRecord(row) && row.taskId === taskId)
    : [];
  const row = entries[0];
  if (
    entries.length !== 1 ||
    !isRecord(row) ||
    !validTriggerId(row.triggerId) ||
    typeof row.state !== 'string' ||
    !['queued', 'skipped'].includes(row.state) ||
    !(row.reason === null || typeof row.reason === 'string')
  ) {
    fail(
      translate(
        process.env,
        '运行响应未包含有效的本轮触发记录，请检查任务状态，不要直接重试运行。',
      ),
    );
  }
  return {
    triggerId: row.triggerId,
    state: row.state,
    reason: row.reason,
  };
}

export async function waitForTrigger(
  config: StoredConfig,
  taskId: number,
  triggerId: string,
  timeout: number,
  action: 'run' | 'wait',
) {
  const data = {
    taskId,
    action,
    triggerId,
    ...(action === 'run' ? { accepted: true } : {}),
  };
  const deadline = performance.now() + timeout * 1000;
  const timedOut = () =>
    new CliResultError(
      translate(
        process.env,
        '等待触发 %s 超时；任务未被停止或重新运行，可用 task wait 继续等待。',
        triggerId,
      ),
      { ...data, waitStatus: 'timeout' },
    );
  const query = new URLSearchParams({ ids: triggerId });
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw timedOut();
    let result: Record<string, unknown>;
    try {
      result = await request(config, `crons/${taskId}/triggers?${query}`, {
        timeoutMs: Math.max(1, Math.ceil(Math.min(30000, remaining))),
      });
    } catch (error) {
      if (performance.now() >= deadline) throw timedOut();
      if (error instanceof CliError) {
        throw new CliResultError(
          translate(
            process.env,
            '等待触发 %s 中断：%s 不会重试运行，可用 task wait 继续等待。',
            triggerId,
            error.message,
          ),
          { ...data, waitStatus: 'interrupted' },
          error.exitCode,
        );
      }
      throw error;
    }
    if (performance.now() >= deadline) throw timedOut();
    const rows = result.data;
    if (Array.isArray(rows) && rows.length === 0) {
      throw new CliResultError(
        translate(
          process.env,
          '触发 %s 不存在、已清理或不属于该任务，无法确认执行结果。',
          triggerId,
        ),
        { ...data, waitStatus: 'notFound' },
      );
    }
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
    if (
      !isRecord(row) ||
      row.id !== triggerId ||
      row.cron_id !== taskId ||
      typeof row.state !== 'string' ||
      !states.includes(row.state) ||
      !(row.reason === null || typeof row.reason === 'string') ||
      !(row.exit_code === null || Number.isInteger(row.exit_code))
    ) {
      throw new CliResultError(
        translate(
          process.env,
          '触发 %s 的查询响应无效或与请求不匹配，无法确认执行结果。',
          triggerId,
        ),
        { ...data, waitStatus: 'invalidResponse' },
      );
    }
    if (row.state !== 'queued' && row.state !== 'running') {
      const outcome = {
        ...data,
        state: row.state,
        reason: row.reason,
        exitCode: row.exit_code,
      };
      if (row.state === 'finished' && row.exit_code === 0) {
        return { code: 200 as const, data: outcome };
      }
      throw new CliResultError(
        translate(
          process.env,
          '触发 %s 未成功完成（状态 %s，退出码 %s）。',
          triggerId,
          row.state,
          row.exit_code ?? '-',
        ),
        outcome,
      );
    }
    await delay(Math.max(1, Math.min(1000, deadline - performance.now())));
  }
}
