import { translate } from '../../shared/i18n/index';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalContext } from './context';
import { checkedProcess } from './process';
import { fail } from '../../shared/errors';
import { isRecord } from '../../shared/record';
import { operationSignal, requestCancellation } from './cancellation';

export class ReceiptValidationError extends Error {
  constructor(readonly field: string) {
    super('The running panel rejected the lifecycle field ' + field);
  }
}

export class LocalApi {
  private token?: string;
  constructor(private readonly context: LocalContext) {}

  private async credential(): Promise<string> {
    if (this.token) return this.token;
    const read = async () => {
      try {
        const value: unknown = JSON.parse(
          await fs.readFile(this.context.paths.file_auth_token!, 'utf8'),
        );
        if (
          isRecord(value) &&
          typeof value.value === 'string' &&
          typeof value.expiration === 'number' &&
          value.expiration > Date.now() / 1000
        )
          return value.value;
      } catch {
        /* Existing local token generator owns missing/expired credentials. */
      }
      return undefined;
    };
    this.token = await read();
    if (!this.token) {
      const compiled = path.join(this.context.root, 'static/build/token.js');
      const exists = await fs.stat(compiled).then(
        () => true,
        () => false,
      );
      await checkedProcess(
        exists ? process.execPath : 'ts-node-transpile-only',
        [exists ? compiled : path.join(this.context.root, 'back/token.ts')],
        {
          cwd: this.context.root,
          env: this.context.env,
          capture: true,
          output: () => {},
          timeoutMs: 30000,
        },
      );
      this.token = await read();
    }
    if (!this.token)
      fail(
        translate(
          this.context.env,
          '无法获取本机系统令牌，请检查运行中的面板。',
        ),
        3,
      );
    return this.token;
  }

  async call(
    endpoint: string,
    method = 'GET',
    body?: unknown,
    finishedAt?: number,
  ): Promise<Record<string, unknown>> {
    operationSignal()?.throwIfAborted();
    const token = await this.credential();
    const port = this.context.env.QlPort || '5700';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      fail(translate(this.context.env, '本机面板端口无效。'), 2);
    const retryReceipt = isRecord(body) && !!(body.execution_id || body.trigger_id) &&
      ((method === 'PUT' && endpoint === 'crons/status') ||
       (method === 'POST' && endpoint === 'dashboard/record'));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let result: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = requestCancellation(30000);
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/open/${endpoint}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(finishedAt !== undefined && { 'X-QL-Finished-At': String(finishedAt) }),
              ...(body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
            },
            body: payload,
            redirect: 'error',
            signal: request.signal,
          },
        );
        if (!response.ok) {
          if (attempt === 0 && method === 'PUT' && endpoint === 'crons/status' && response.status === 400) {
            const rejection: unknown = await response.json();
            const validation = isRecord(rejection) && rejection.validation;
            const detail = isRecord(validation) && validation.body;
            if (isRecord(detail) && detail.source === 'body' && Array.isArray(detail.keys) &&
                detail.keys.length === 1 && ['trigger_id', 'execution_id', 'exit_code'].includes(detail.keys[0])) {
              throw new ReceiptValidationError(detail.keys[0]);
            }
          } else {
            await response.body?.cancel();
          }
          fail(
            translate(
              this.context.env,
              '本机 API 拒绝请求（HTTP %s）。',
              response.status,
            ),
          );
        }
        result = await response.json();
        break;
      } catch (error) {
        if (error instanceof ReceiptValidationError) throw error;
        if (attempt === 0 && retryReceipt && request.signal.aborted && !operationSignal()?.aborted) continue;
        fail(
          translate(
            this.context.env,
            '本机 API 请求失败；请先检查操作结果，不要直接重试写入。',
          ),
        );
      } finally {
        request.dispose();
      }
    }
    if (!isRecord(result) || result.code !== 200)
      fail(
        translate(
          this.context.env,
          '本机 API 拒绝请求，请检查面板日志和权限。',
        ),
      );
    return result;
  }
}
