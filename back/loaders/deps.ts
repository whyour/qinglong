import path from 'path';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import config from '../config/index';
import { fileExist, promiseExec, rmPath } from '../config/util';

async function linkToNodeModule(src: string, dst?: string) {
  const target = path.join(config.rootPath, 'node_modules', dst || src);
  const source = path.join(config.rootPath, src);

  try {
    const stats = await fs.lstat(target);
    if (!stats) {
      await fs.symlink(source, target, 'dir');
    }
  } catch (error) {}
}

async function linkCommand() {
  const commandPath = await promiseExec('which node');
  const commandDir = path.dirname(commandPath);
  const linkShell = [
    {
      src: 'update.sh',
      dest: 'ql',
      tmp: 'ql_tmp',
    },
    {
      src: 'task.sh',
      dest: 'task',
      tmp: 'task_tmp',
    },
  ];

  for (const link of linkShell) {
    const source = path.join(config.rootPath, 'shell', link.src);
    const target = path.join(commandDir, link.dest);
    const tmpTarget = path.join(commandDir, link.tmp);
    await fs.symlink(source, tmpTarget);
    await fs.rename(tmpTarget, target);
  }
}

export default async (src: string = 'deps') => {
  await linkCommand();
  await linkToNodeModule(src);

  const source = path.join(config.rootPath, src);
  const watcher = chokidar.watch(source, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
  });

  watcher
    .on('add', (path) => linkToNodeModule(src))
    .on('change', (path) => linkToNodeModule(src));
};
