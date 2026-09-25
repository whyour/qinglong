import { saveResponse } from './download';
import { translate } from '../../shared/i18n/index';
import { CliError, fail } from '../../shared/errors';
import type { Credentials, Session, StoredConfig } from '../types';

import { isRecord } from '../../shared/record';
export { isRecord } from '../../shared/record';

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  body?: unknown;
  output?: string;
  text?: boolean;
  timeoutMs?: number;
  authenticated?: boolean;
}

export async function request(
  config: StoredConfig,
  endpoint: string,
  options: RequestOptions = {},
): Promise<Record<string, unknown>> {
  const { method = 'GET', body, authenticated = true } = options;
  const scope = endpoint.split(/[/?]/, 1)[0]!;
  const subscription = scope === 'subscriptions';
  const resource =
    scope === 'crons' || subscription
      ? translate(process.env, subscription ? '订阅' : '任务')
      : scope;
  const credentialsHint = authenticated
    ? translate(process.env, '应用凭据和 %s 权限', scope)
    : translate(process.env, '应用凭据');
  let response: Response;
  let result: unknown;
  try {
    response = await fetch(`${config.url}/open/${endpoint}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}),
        ...(body !== undefined && !(body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
      },
      body:
        body instanceof FormData
          ? body
          : body !== undefined
          ? JSON.stringify(body)
          : undefined,
    });
    // Check HTTP status before decoding (proxies may return HTML on denial).
    if (!response.ok) {
      await response.body?.cancel();
      const suffix =
        method !== 'GET' && response.status >= 500
          ? translate(
              process.env,
              ' 执行结果可能未知，请先检查%s状态再考虑重试。',
              resource,
            )
          : '';
      fail(
        translate(
          process.env,
          'API 请求被拒绝（HTTP %s），请检查%s。%s',
          response.status,
          credentialsHint,
          suffix,
        ),
        [401, 403].includes(response.status) ? 3 : 1,
      );
    }
    if (
      options.output &&
      (response.headers.get('content-disposition')?.startsWith('attachment') ||
        !response.headers.get('content-type')?.includes('application/json'))
    )
      return await saveResponse(response, options.output);
    if (
      options.text &&
      !response.headers.get('content-type')?.includes('application/json')
    )
      return { code: 200, data: await response.text() };
    result = await response.json();
  } catch (error) {
    // Never expose a fetch error, URL or server error that may include secrets.
    if (error instanceof CliError) throw error;
    fail(
      method !== 'GET'
        ? translate(
            process.env,
            '请求失败或响应无效，执行结果未知。请先检查%s状态再考虑重试。',
            resource,
          )
        : translate(
            process.env,
            '请求失败或返回的 JSON 无效，请检查实例 URL、网络和 TLS 证书。',
          ),
    );
  }
  if (endpoint.split('?')[0] === 'user/login' && isRecord(result) && result.code === 420)
    fail(translate(process.env, '需要双因素验证，请调用 user two-factor-login。'), 3);
  if (!isRecord(result) || result.code !== 200) {
    const status =
      isRecord(result) && typeof result.code === 'number'
        ? result.code
        : undefined;
    fail(
      translate(
        process.env,
        'API 请求被拒绝（code %s），请检查%s。',
        status ?? translate(process.env, '未知'),
        credentialsHint,
      ),
      status === 401 || status === 403 ? 3 : 1,
    );
  }
  if (options.output)
    fail(translate(process.env, '接口返回 JSON，未保存下载文件。'));
  return result;
}

export async function authenticate(config: Credentials): Promise<Session> {
  const query = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const result = await request(config, `auth/token?${query}`, {
    authenticated: false,
  });
  const data = result.data;
  if (
    !isRecord(data) ||
    typeof data.token !== 'string' ||
    !data.token ||
    typeof data.expiration !== 'number' ||
    !Number.isFinite(data.expiration) ||
    data.expiration <= Date.now() / 1000
  ) {
    fail(translate(process.env, '认证响应无效。'));
  }
  return { ...config, token: data.token, expiration: data.expiration };
}
