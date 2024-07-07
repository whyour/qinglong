#!/usr/bin/env zx
import 'zx/globals';

import { PassThrough } from 'node:stream';
import {
  listCrontabUser,
  formatLogTime,
  formatTimestamp,
  formatDate,
  dirLog,
  dirCli,
  globalState,
  handleTaskEnd,
} from './share.mjs';
import './api.mjs';

// $.verbose = true;

async function singleHandle() {}

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
signals.forEach((sig) => process.on(sig, singleHandle));

export async function handleLogPath(fileParam) {
  let ID = $.env.ID;
  if (!ID) {
    const grepResult =
      await $`grep -E "task.* ${fileParam}" ${listCrontabUser}`.nothrow();
    ID = grepResult.stdout.match(/ID=(\d+)/)?.[1];
  }
  globalState.ID = ID;

  const suffix = ID && parseInt(ID, 10) > 0 ? `_${ID}` : '';
  globalState.time = new Date();
  const logTime = formatLogTime(globalState.time);
  let logDirTmp = path.basename(fileParam);
  let logDirTmpPath = '';

  if (fileParam.includes('/')) {
    logDirTmpPath = path.isAbsolute(fileParam)
      ? fileParam.substring(1)
      : fileParam;
    logDirTmpPath = path.basename(path.dirname(logDirTmpPath));
  }

  if (logDirTmpPath) {
    logDirTmp = `${logDirTmpPath}_${logDirTmp}`;
  }

  const logDir = `${logDirTmp.replace(/\.[^/.]+$/, '')}${suffix}`;
  globalState.logDir = logDir;
  globalState.logPath = `${logDir}/${logTime}.log`;
  if ($.env.real_log_path) {
    globalState.logPath = realLogPath;
  }

  await $`mkdir -p ${dirLog}/${logDir}`;
}

export function initBeginTime() {
  globalState.beginTime = formatDate(globalState.time);
  globalState.beginTimestamp = formatTimestamp(globalState.time);
}

async function main() {
  const taskArgv = minimist(process.argv.slice(3), {
    '--': true,
  });
  const {
    _: [scriptFile],
  } = taskArgv;

  await handleLogPath(scriptFile);
  initBeginTime();

  cd(`${dirCli}`);
  const logStream = fs.createWriteStream(`${dirLog}/${globalState.logPath}`);
  const passThrough = new PassThrough();
  passThrough.pipe(logStream);
  const p = $`./otask.mjs ${process.argv.slice(
    3,
  )} --GlobalState=${JSON.stringify(globalState)} 2>&1`.nothrow();
  p.stdout.pipe(passThrough).pipe(process.stdout);
  await p;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
