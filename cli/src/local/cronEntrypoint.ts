import { translate } from '../i18n';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const begin = '# BEGIN QINGLONG CLI ENVIRONMENT\n';
const end = '# END QINGLONG CLI ENVIRONMENT\n';
const schedule =
  /^(\s*(?:@[a-z]+|(?:[\w*\/,?#-]+[ \t]+){4}[\w*\/,?#-]+)[ \t]+)(.*)$/gm;
const marker = '// QingLong CLI crontab bridge';
interface CronInstallation {
  language?: string;
  executable: string;
  sourceFile: string;
  environment: Record<string, string>;
}

export function runCrontab(
  args: string[],
  installation: CronInstallation,
): number {
  const language = { QL_LANG: process.env.QL_LANG ?? installation.language };
  let directory: string | undefined;
  try {
    let forwarded = args;
    if (
      args.length === 1 &&
      path.resolve(args[0]!) === installation.sourceFile
    ) {
      const prefix =
        'export ' +
        Object.entries(installation.environment)
          .map(([key, value]) => {
            if (!/^[A-Z_]+$/.test(key) || /[\r\n\0%]/.test(value))
              throw new Error(translate(language, 'cron 环境变量值无效。'));
            return `${key}='${value.replace(/'/g, "'\\''")}'`;
          })
          .join(' ') +
        '; ';
      const source = syncFs.readFileSync(installation.sourceFile, 'utf8');
      const header =
        begin + '# ' + Buffer.from(prefix).toString('base64') + '\n' + end;
      directory = syncFs.mkdtempSync(path.join(os.tmpdir(), 'ql-crontab-'));
      const file = path.join(directory, 'table');
      syncFs.writeFileSync(
        file,
        header +
          source.replace(schedule, (line, timing, command) =>
            line.trimStart().startsWith('#')
              ? line
              : `${timing}${prefix}${command}`,
          ),
        { mode: 0o600 },
      );
      forwarded = [file];
    }
    const child = spawnSync(installation.executable, forwarded, {
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    let stdout = child.stdout || Buffer.alloc(0);
    if (args.length === 1 && args[0] === '-l') {
      const contents = stdout.toString('utf8');
      if (contents.startsWith(begin) && contents.includes(end)) {
        const headerEnd = contents.indexOf(end);
        const encoded = contents.slice(begin.length, headerEnd).trim();
        if (encoded.startsWith('# ')) {
          const prefix = Buffer.from(encoded.slice(2), 'base64').toString(
            'utf8',
          );
          stdout = Buffer.from(
            contents
              .slice(headerEnd + end.length)
              .replace(schedule, (line, timing, command) =>
                prefix && command.startsWith(prefix)
                  ? timing + command.slice(prefix.length)
                  : line,
              ),
          );
        }
      }
    }
    process.stdout.write(stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    return (
      child.status ??
      (child.signal ? 128 + os.constants.signals[child.signal] : 1)
    );
  } catch {
    process.stderr.write(
      translate(
        language,
        '无法安装或读取面板 crontab，请检查环境路径和系统 cron 工具。',
      ) + '\n',
    );
    return 1;
  } finally {
    if (directory) syncFs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function installCronEntrypoint(
  commandDir: string,
  cliRoot: string,
  sourceFile: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (![commandDir, cliRoot, sourceFile].every(path.isAbsolute))
    throw new Error(translate(environment, 'cron 安装路径必须为绝对路径。'));
  let executable: string | undefined;
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory || path.resolve(directory) === path.resolve(commandDir))
      continue;
    const candidate = path.join(directory, 'crontab');
    try {
      await fs.access(candidate, syncFs.constants.X_OK);
      executable = path.resolve(candidate);
      break;
    } catch {}
  }
  // Node-only installations need not have a system cron utility.
  if (!executable) return;
  const target = path.join(commandDir, 'crontab');
  try {
    if (!(await fs.readFile(target, 'utf8')).includes(marker))
      throw new Error(
        translate(environment, '拒绝覆盖不属于此 CLI 的用户 crontab 命令。'),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const selected: Record<string, string> = {};
  for (const key of [
    'QL_DIR',
    'QL_DATA_DIR',
    'QL_CLI_ROOT',
    'PYTHONPATH',
    'NODE_PATH',
  ])
    if (environment[key] !== undefined) selected[key] = environment[key]!;
  selected.PATH = [
    commandDir,
    ...(environment.PATH || '')
      .split(path.delimiter)
      .filter((value) => value && value !== commandDir),
  ].join(path.delimiter);
  const installation: CronInstallation = {
    language: environment.QL_LANG,
    executable,
    sourceFile: path.resolve(sourceFile),
    environment: selected,
  };
  const module = path.join(cliRoot, 'dist/local/cronEntrypoint.js');
  await fs.access(module);
  await fs.mkdir(commandDir, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `#!${
        process.execPath
      }\n${marker}\nprocess.exitCode=require(${JSON.stringify(
        module,
      )}).runCrontab(process.argv.slice(2),${JSON.stringify(installation)});\n`,
      { flag: 'wx', mode: 0o755 },
    );
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
