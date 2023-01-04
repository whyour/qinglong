import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import config from '../config/index';
import { promiseExec } from '../config/util';

function linkToNodeModule(src: string, dst?: string) {
  const target = path.join(config.rootPath, 'node_modules', dst || src);
  const source = path.join(config.rootPath, src);

  fs.lstat(target, (err, stat) => {
    if (!stat) {
      fs.symlink(source, target, 'dir', (err) => {
        if (err) throw err;
      });
    }
  });
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
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    fs.symlink(source, target, (err) => {});
  }
}

export default async (src: string = 'deps') => {
  await linkCommand();
  linkToNodeModule(src);

  const source = path.join(config.rootPath, src);
  const watcher = chokidar.watch(source, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
  });

  watcher
    .on('add', (path) => linkToNodeModule(src))
    .on('change', (path) => linkToNodeModule(src));
};
