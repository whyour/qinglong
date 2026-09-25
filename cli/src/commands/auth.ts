import { translate } from '../i18n';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { authenticate, request } from '../api/client';
import { readConfig, saveConfig, logout } from '../config/store';
import { panelUrl } from '../config/url';
import { CliError, fail } from '../errors';
import type { ApiResponse, Command, Session } from '../types';

export async function promptCredential(
  label: string,
  hidden = false,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    fail(
      translate(
        process.env,
        '非交互登录需要 QL_CLIENT_ID 和 QL_CLIENT_SECRET。',
      ),
      2,
    );
  }
  // Suppress readline echo through a stream, without using its private methods.
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stderr.write(chunk);
      callback();
    },
  });
  const terminal = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  process.stderr.write(`${label}: `);
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancelled = () =>
        reject(new CliError(translate(process.env, '登录已取消。'), 2));
      terminal.once('SIGINT', cancelled);
      terminal.once('close', cancelled);
      terminal.question('', resolve);
    });
  } finally {
    terminal.close();
    output.end();
    if (hidden) process.stderr.write('\n');
  }
}

export async function session(): Promise<Session> {
  if (process.env.QL_ACCESS_TOKEN || process.env.QL_URL) {
    if (!process.env.QL_ACCESS_TOKEN || !process.env.QL_URL)
      fail(
        translate(process.env, 'QL_URL 和 QL_ACCESS_TOKEN 必须同时提供。'),
        2,
      );
    return {
      url: panelUrl(process.env.QL_URL),
      token: process.env.QL_ACCESS_TOKEN,
      clientId: '',
      clientSecret: '',
      expiration: 0,
    };
  }
  const config = readConfig();
  if (
    config.token &&
    typeof config.expiration === 'number' &&
    Number.isFinite(config.expiration) &&
    config.expiration > Date.now() / 1000 + 60
  ) {
    return { ...config, token: config.token, expiration: config.expiration };
  }
  const refreshed = await authenticate(config);
  saveConfig(refreshed);
  return refreshed;
}

export async function auth(
  command: Extract<Command, { kind: 'login' | 'logout' | 'status' }>,
): Promise<ApiResponse<unknown>> {
  if (command.kind === 'logout') {
    logout();
    return { code: 200, data: { authenticated: false, localOnly: true } };
  }
  if (command.kind === 'login') {
    const url = panelUrl(command.url);
    const clientId =
      process.env.QL_CLIENT_ID ||
      (await promptCredential(translate(process.env, '应用 ID')));
    const clientSecret =
      process.env.QL_CLIENT_SECRET ||
      (await promptCredential(translate(process.env, '应用密钥'), true));
    if (!clientId.trim() || !clientSecret.trim())
      fail(translate(process.env, '凭据不能为空。'), 2);
    const config = await authenticate({ url, clientId, clientSecret });
    saveConfig(config);
    return { code: 200, data: { authenticated: true, url } };
  }
  const config = await session();
  const scope = command.scope ?? 'crons';
  await request(
    config,
    (
      {
        crons: 'crons?page=1&size=1',
        configs: 'configs/files',
        dashboard: 'dashboard/overview',
      } as Record<string, string>
    )[scope] ?? scope,
  );
  return {
    code: 200,
    data: {
      authenticated: true,
      url: config.url,
      expiration: config.expiration,
      scopeChecked: scope,
    },
  };
}
