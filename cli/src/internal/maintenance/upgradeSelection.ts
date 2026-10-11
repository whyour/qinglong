import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalContext } from '../runtime/context';
import { fail } from '../../shared/errors';
import { translate } from '../../shared/i18n/index';

/** Preserve only the explicitly installed 2.x command-selection integration. */
export async function prepareUpgradeSelection(
  context: LocalContext,
  sourceRoot: string,
  staticRoot: string,
): Promise<{ source: string; target: string; directory: string } | undefined> {
  const cliRoot = context.env.QL_CLI_ROOT;
  if (!cliRoot) return undefined;
  if (!path.isAbsolute(cliRoot))
    fail(translate(context.env, '已选择的 CLI 安装路径必须为绝对路径。'), 2);
  for (const entry of ['entrypoints.js', 'cronEntrypoint.js'])
    await fs.access(path.join(cliRoot, 'dist/local', entry));
  const manifest = JSON.parse(
    await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'),
  );
  const version =
    manifest.version ||
    (await fs.readFile(path.join(sourceRoot, 'version.yaml'), 'utf8')).match(
      /^\uFEFF?version:\s*["']?([^\s"']+)/m,
    )?.[1];
  if (typeof version !== 'string' || !/^2\./.test(version))
    fail(
      translate(context.env, '保留 CLI 入口仅支持已确认的 2.x 升级载荷。'),
      2,
    );
  const relative = 'build/loaders/deps.js';
  const target = path.join(context.paths.dir_static!, relative);
  const incoming = path.join(staticRoot, relative);
  if (
    !(await fs.lstat(target)).isFile() ||
    !(await fs.lstat(incoming)).isFile()
  )
    fail(
      translate(context.env, '无法确认已选择的 CLI 命令加载器，请检查安装。'),
      2,
    );
  const loader = await fs.readFile(target, 'utf8');
  if (
    !loader.includes('dist/local/entrypoints.js') ||
    !loader.includes('dist/local/cronEntrypoint.js') ||
    !loader.includes('QL_CLI_ROOT')
  )
    fail(
      translate(context.env, '无法确认已选择的 CLI 命令加载器，请检查安装。'),
      2,
    );
  await fs.mkdir(context.paths.dir_tmp!, { recursive: true });
  const directory = await fs.mkdtemp(
    path.join(context.paths.dir_tmp!, 'selected-loader-'),
  );
  try {
    const source = path.join(directory, 'deps.js');
    await fs.writeFile(source, loader, { mode: 0o600, flag: 'wx' });
    return { source, target, directory };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
