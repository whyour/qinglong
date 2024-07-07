#!/usr/bin/env zx

import {
  dirScripts,
  dirLog,
  handleTaskStart,
  runTaskBefore,
  runTaskAfter,
  handleTaskEnd,
  globalState,
  formatLogTime,
} from './share.mjs';
import { basename, dirname } from 'path';

function defineProgram(fileParam) {
  if (fileParam.endsWith('.js') || fileParam.endsWith('.mjs')) {
    return 'node';
  } else if (fileParam.endsWith('.py') || fileParam.endsWith('.pyc')) {
    return 'python3';
  } else if (fileParam.endsWith('.sh')) {
    return 'bash';
  } else if (fileParam.endsWith('.ts')) {
    return $`command -v tsx`
      .then(() => 'tsx')
      .catch(() => 'ts-node-transpile-only');
  } else {
    return '';
  }
}

async function randomDelay(fileParam) {
  const randomDelayMax = process.env.RandomDelay;
  if (randomDelayMax && randomDelayMax > 0) {
    const fileExtensions = process.env.RandomDelayFileExtensions || 'js';
    const ignoredMinutes = process.env.RandomDelayIgnoredMinutes || '0 30';
    const currentMin = new Date().getMinutes();

    if (
      fileExtensions.split(' ').some((ext) => fileParam.endsWith(`.${ext}`))
    ) {
      if (
        ignoredMinutes.split(' ').some((min) => parseInt(min) === currentMin)
      ) {
        return;
      }
      const delaySecond = Math.floor(Math.random() * randomDelayMax) + 1;
      console.log(
        `任务随机延迟 ${delaySecond} 秒，配置文件参数 RandomDelay 置空可取消延迟`,
      );
      await sleep(delaySecond * 1000);
    }
  }
}

async function genArrayScripts() {
  const arrayScripts = [];
  const arrayScriptsName = [];
  const files = await fs.readdir(dirScripts);

  for (const file of files) {
    if (file.endsWith('.js') && file !== 'sendNotify.js') {
      arrayScripts.push(file);
      const content = await fs.readFile(`${dirScripts}/${file}`, 'utf8');
      const match = content.match(/new Env\(['"]([^'"]+)['"]\)/);
      arrayScriptsName.push(match ? match[1] : '<未识别出活动名称>');
    }
  }

  return { arrayScripts, arrayScriptsName };
}

async function usage() {
  const { arrayScripts, arrayScriptsName } = await genArrayScripts();
  console.log(
    `task命令运行本程序自动添加进crontab的脚本，需要输入脚本的绝对路径或去掉 “${dirScripts}/” 目录后的相对路径（定时任务中请写作相对路径），用法为：`,
  );
  console.log(
    `1.$cmdTask <fileName>                                             # 依次执行，如果设置了随机延迟，将随机延迟一定秒数`,
  );
  console.log(
    `2.$cmdTask <fileName> now                                         # 依次执行，无论是否设置了随机延迟，均立即运行，前台会输出日志，同时记录在日志文件中`,
  );
  console.log(
    `3.$cmdTask <fileName> conc <环境变量名称> <账号编号，空格分隔>(可选的)  # 并发执行，无论是否设置了随机延迟，均立即运行，前台不产生日志，直接记录在日志文件中，且可指定账号执行`,
  );
  console.log(
    `4.$cmdTask <fileName> desi <环境变量名称> <账号编号，空格分隔>         # 指定账号执行，无论是否设置了随机延迟，均立即运行`,
  );
  if (arrayScripts.length > 0) {
    console.log(`\n当前有以下脚本可以运行:`);
    arrayScripts.forEach((script, i) =>
      console.log(`${i + 1}. ${arrayScriptsName[i]}：${script}`),
    );
  } else {
    console.log(`\n暂无脚本可以执行`);
  }
}

export function parseDuration(d) {
  if (typeof d == 'number') {
    if (isNaN(d) || d < 0) throw new Error(`Invalid duration: "${d}".`);
    return d;
  } else if (/\d+s/.test(d)) {
    return +d.slice(0, -1) * 1000;
  } else if (/\d+ms/.test(d)) {
    return +d.slice(0, -2);
  } else if (/\d+m/.test(d)) {
    return +d.slice(0, -1) * 1000 * 60;
  } else if (/\d+h/.test(d)) {
    return +d.slice(0, -1) * 1000 * 60 * 60;
  } else if (/\d+d/.test(d)) {
    return +d.slice(0, -1) * 1000 * 60 * 60 * 24;
  }
  throw new Error(`Unknown duration: "${d}".`);
}

async function runWithTimeout(command) {
  if (globalState.commandTimeoutTime) {
    const timeoutNumber = parseDuration(globalState.commandTimeoutTime);
    await $([command]).timeout(timeoutNumber).nothrow().pipe(process.stdout);
  } else {
    await $([command]).nothrow().pipe(process.stdout);
  }
}

async function runNormal(fileParam, scriptParams) {
  if (
    !scriptParams.includes('now') &&
    process.env.realTime !== 'true' &&
    process.env.noDelay !== 'true'
  ) {
    await randomDelay(fileParam);
  }
  cd(dirScripts);
  const relativePath = dirname(fileParam);
  if (!fileParam.startsWith('/') && relativePath) {
    cd(relativePath);
    fileParam = fileParam.replace(`${relativePath}/`, '');
  }
  await runWithTimeout(
    `${globalState.whichProgram} ${fileParam} ${scriptParams}`,
  );
}

async function runConcurrent(fileParam, envParam, numParam, scriptParams) {
  if (!envParam || !numParam) {
    console.log(`缺少并发运行的环境变量参数 task xxx.js conc Test 1 3`);
    return;
  }

  const array = (process.env[envParam] || '').split('&');
  const runArr = expandRange(numParam, array.length);
  const arrayRun = runArr.map((i) => array[i - 1]).filter(Boolean);

  const singleLogTime = formatLogTime(new Date());

  cd(dirScripts);
  const relativePath = dirname(fileParam);
  if (relativePath && fileParam.includes('/')) {
    cd(relativePath);
    fileParam = fileParam.replace(`${relativePath}/`, '');
  }

  await Promise.all(
    arrayRun.map(async (env, i) => {
      const singleLogPath = `${dirLog}/${globalState.logDir}/${singleLogTime}_${
        i + 1
      }.log`;
      await runWithTimeout(
        `${envParam}="${env.replace('"', '\\"')}" ${
          globalState.whichProgram
        } ${fileParam} ${scriptParams} &>${singleLogPath}`,
      );
    }),
  );

  for (let i = 0; i < arrayRun.length; i++) {
    const singleLogPath = `${dirLog}/${globalState.logDir}/${singleLogTime}_${
      i + 1
    }.log`;
    const log = await fs.readFile(singleLogPath, 'utf8');
    console.log(log);
    await fs.unlink(singleLogPath);
  }
}

async function runDesignated(fileParam, envParam, numParam, scriptParams) {
  if (!envParam || !numParam) {
    console.log(`缺少单独运行的参数 task xxx.js desi Test 1 3`);
    return;
  }

  const array = (process.env[envParam] || '').split('&');
  const runArr = expandRange(numParam, array.length);
  const arrayRun = runArr.map((i) => array[i - 1]).filter(Boolean);
  const cookieStr = arrayRun.join('&');
  cd(dirScripts);
  const relativePath = dirname(fileParam);
  if (relativePath && fileParam.includes('/')) {
    cd(relativePath);
    fileParam = fileParam.replace(`${relativePath}/`, '');
  }

  console.log('cookieStr', cookieStr.length, arrayRun.length);
  // ${envParam}="${cookieStr.replace('"', '\\"')}"
  await runWithTimeout(
    `${globalState.whichProgram} ${fileParam} ${scriptParams}`,
  );
}

async function runElse(fileParam, scriptParams) {
  cd(dirScripts);
  const relativePath = dirname(fileParam);
  if (relativePath && fileParam.includes('/')) {
    cd(relativePath);
    fileParam = fileParam.replace(`${relativePath}/`, './');
  }

  await runWithTimeout(
    `${globalState.whichProgram} ${fileParam} ${scriptParams}`,
  );
}

function expandRange(rangeStr, max) {
  const tempRangeStr = rangeStr
    .replace(/-max/g, `-${max}`)
    .replace(/max-/g, `${max}-`);

  return tempRangeStr.split(' ').flatMap((part) => {
    const rangeMatch = part.match(/^(\d+)([-~_])(\d+)$/);
    if (rangeMatch) {
      const [, start, , end] = rangeMatch.map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return Number(part);
  });
}

async function main(taskShellParams, scriptParams) {
  const [fileParam, action, envParam, ...others] = taskShellParams;
  if (taskShellParams.length === 0) {
    return await usage();
  }
  if (fileParam && /\.(js|py|pyc|sh|ts)$/.test(fileParam)) {
    const filePath = fileParam.startsWith('/')
      ? fileParam
      : path.join(dirScripts, fileParam);
    if (!(await fs.exists(filePath))) {
      console.log(`文件不存在 ${fileParam}`);
      return;
    }
    switch (action) {
      case undefined:
        return await runNormal(fileParam, scriptParams);
      case 'now':
        return await runNormal(fileParam, scriptParams);
      case 'conc':
        return await runConcurrent(
          fileParam,
          envParam,
          others.join(' '),
          scriptParams,
        );
      case 'desi':
        return await runDesignated(
          fileParam,
          envParam,
          others.join(' '),
          scriptParams,
        );
    }
  }
  await runElse(fileParam, taskShellParams.slice(1).concat(scriptParams));
}

async function run() {
  const taskArgv = minimist(process.argv.slice(3), {
    '--': true,
  });
  const { _: taskShellParams, m, '--': scriptParams, GlobalState } = taskArgv;
  const cacheState = JSON.parse(GlobalState || '{}');
  for (const key in cacheState) {
    globalState[key] = cacheState[key];
  }
  if (m) {
    globalState.commandTimeoutTime = m;
  }
  globalState.whichProgram = await defineProgram(taskShellParams[0]);

  await handleTaskStart();
  await runTaskBefore();
  await main(taskShellParams, scriptParams);
  await runTaskAfter();
  await handleTaskEnd();
}

async function singleHandle() {}

const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
signals.forEach((sig) => process.on(sig, singleHandle));

await run();
