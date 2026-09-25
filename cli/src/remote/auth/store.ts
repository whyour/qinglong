import { translate } from '../../shared/i18n/index';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CliError, fail } from '../../shared/errors';
import type { StoredConfig } from '../types';
import { panelUrl } from './url';

export function configPath(): string {
  return path.resolve(
    process.env.QL_CLI_CONFIG ||
      path.join(os.homedir(), '.config/qinglong/cli.json'),
  );
}

export function readConfig(): StoredConfig {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      configPath(),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      fail(
        translate(
          process.env,
          'CLI 配置必须是当前用户拥有的私有普通文件（0600）。',
        ),
      );
    }
    const config: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!config || typeof config !== 'object')
      fail(translate(process.env, 'CLI 配置无效，请运行 ql-cli login。'));
    const value = config as Record<string, unknown>;
    if (
      typeof value.url !== 'string' ||
      typeof value.clientId !== 'string' ||
      !value.clientId.trim() ||
      typeof value.clientSecret !== 'string' ||
      !value.clientSecret.trim()
    ) {
      fail(translate(process.env, 'CLI 配置无效，请运行 ql-cli login。'));
    }
    return {
      url: panelUrl(value.url),
      clientId: value.clientId,
      clientSecret: value.clientSecret,
      token: typeof value.token === 'string' ? value.token : undefined,
      expiration:
        typeof value.expiration === 'number' ? value.expiration : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail(translate(process.env, '尚未登录，请运行 ql-cli login。'), 3);
    if (error instanceof CliError) throw error;
    return fail(
      translate(
        process.env,
        '无法读取 CLI 配置，请检查文件权限并运行 ql-cli login。',
      ),
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function saveConfig(config: StoredConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function logout(): void {
  fs.rmSync(configPath(), { force: true });
}
