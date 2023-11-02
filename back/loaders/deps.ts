import path from 'path';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import config from '../config/index';
import { fileExist, promiseExec, rmPath } from '../config/util';

async function linkToNodeModule(src: string, dst?: string) {
  const target = path.join(config.rootPath, 'node_modules', dst || src);
  const source = path.join(config.rootPath, src);

  const stats = await fs.lstat(target);
  if (!stats) {
    await fs.symlink(source, target, 'dir');
  }
}

async function linkCommand() {
  const commandPath = await promiseExec('which node');
  const commandDir = path.dirname(commandPath);
  const linkShell = [
    {
      src: 'update.sh',
      dest: 'ql',
    },
    {
      src: 'task.sh',
      dest: 'task',
    },
  ];

  for (const link of linkShell) {
    const source = path.join(config.rootPath, 'shell', link.src);
    const target = path.join(commandDir, link.dest);
    await rmPath(target);
    await fs.symlink(source, target);
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
