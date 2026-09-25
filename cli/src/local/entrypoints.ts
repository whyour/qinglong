import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Called by the 2.x startup loader only after explicit QL_CLI_ROOT selection.
export async function installCliEntrypoints(
  commandDir: string,
  cliRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!path.isAbsolute(commandDir) || !path.isAbsolute(cliRoot))
    throw new Error(translate(environment, 'CLI 安装路径必须为绝对路径。'));
  const entries = [
    { name: 'ql', module: 'ql.js', method: 'qlMain' },
    { name: 'task', module: 'task.js', method: 'taskMain' },
  ];
  // Validate the entire selected installation before replacing either command.
  for (const entry of entries) {
    const filename = path.join(cliRoot, 'dist', entry.module);
    if (!(await fs.stat(filename)).isFile())
      throw new Error(translate(environment, 'CLI 入口必须为普通文件。'));
  }
  await fs.mkdir(commandDir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(commandDir, entry.name);
    const temp = `${target}.${randomUUID()}.tmp`;
    const modulePath = path.join(cliRoot, 'dist', entry.module);
    // Base64 transports the path as data; it cannot terminate a JS string.
    const encodedPath = Buffer.from(modulePath, 'utf8').toString('base64');
    const source = `#!${process.execPath}\n'use strict';\nrequire(Buffer.from('${encodedPath}', 'base64').toString('utf8')).${entry.method}().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write(process.env.QL_LANG === 'en' ? 'CLI invocation failed.\\n' : 'CLI 调用失败。\\n'); process.exitCode = 1; });\n`;
    try {
      await fs.writeFile(temp, source, { flag: 'wx', mode: 0o755 });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}
