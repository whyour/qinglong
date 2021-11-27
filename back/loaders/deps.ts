import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import config from '../config/index';

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

export default async (src: string = 'deps') => {
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
