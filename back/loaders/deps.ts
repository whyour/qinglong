import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';

function linkToNodeModule(src: string, dst?: string) {
  const target = path.join(__dirname, 'node_modules', dst || src);
  const source = path.join(__dirname, src);

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

  const source = path.join(__dirname, src);
  const watcher = chokidar.watch(source, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
  });

  watcher
    .on('add', (path) => linkToNodeModule(src))
    .on('change', (path) => linkToNodeModule(src));
};
