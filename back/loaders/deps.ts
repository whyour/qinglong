import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import config from '../config/index';
import Logger from './logger';

async function linkCommand() {
  const homeDir = os.homedir();
  let userBinDir = path.join(homeDir, 'bin');

  try {
    await fs.mkdir(userBinDir, { recursive: true });
    await linkCommandToDir(userBinDir);
  } catch (error) {
    Logger.error('Linking command failed:', error);
  }
}

async function linkCommandToDir(commandDir: string) {
  const cliRoot = process.env.QL_CLI_ROOT;
  if (cliRoot) {
    if (!path.isAbsolute(cliRoot)) {
      throw new Error('QL_CLI_ROOT must be an absolute CLI installation path');
    }
    const { installCliEntrypoints } = require(path.join(
      cliRoot,
      'dist/local/entrypoints.js',
    ));
    await installCliEntrypoints(commandDir, cliRoot);
    const { installCronEntrypoint } = require(path.join(
      cliRoot,
      'dist/local/cronEntrypoint.js',
    ));
    await installCronEntrypoint(commandDir, cliRoot, config.crontabFile, {
      ...process.env,
      QL_DIR: config.rootPath,
      QL_DATA_DIR: config.dataPath,
    });
    // Container-wide legacy links may precede ~/bin. Ensure panel children use
    // the explicitly selected entries without changing system-wide links.
    process.env.PATH = [
      commandDir,
      ...(process.env.PATH?.split(path.delimiter) ?? []).filter(
        (entry) => entry !== commandDir,
      ),
    ].join(path.delimiter);
    return;
  }

  const cronBridge = path.join(commandDir, 'crontab');
  try {
    if (
      (await fs.lstat(cronBridge)).isFile() &&
      (await fs.readFile(cronBridge, 'utf8')).includes(
        '// QingLong CLI crontab bridge',
      )
    ) {
      await fs.unlink(cronBridge);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

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
    try {
      const stats = await fs.lstat(tmpTarget);
      if (stats) {
        await fs.unlink(tmpTarget);
      }
    } catch (error) {}

    await fs.symlink(source, tmpTarget);
    await fs.rename(tmpTarget, target);
  }
}

export default async () => {
  await linkCommand();
};
