const { execSync } = require('child_process');
const { sendNotify } = require('./notify.js');
require(`./env.js`);

function initGlobal() {
  global.QLAPI = {
    notify: sendNotify,
  };
}

function expandRange(rangeStr, max) {
  const tempRangeStr = rangeStr
    .trim()
    .replace(/-max/g, `-${max}`)
    .replace(/max-/g, `${max}-`);

  return tempRangeStr.split(' ').flatMap((part) => {
    const rangeMatch = part.match(/^(\d+)([-~_])(\d+)$/);
    if (rangeMatch) {
      const [, start, , end] = rangeMatch.map(Number);
      const step = start < end ? 1 : -1;
      return Array.from(
        { length: Math.abs(end - start) + 1 },
        (_, i) => start + i * step,
      );
    }
    return Number(part);
  });
}

function run() {
  const {
    envParam,
    numParam,
    file_task_before,
    file_task_before_js,
    dir_scripts,
    task_before,
  } = process.env;

  require(file_task_before_js);

  try {
    const splitStr = '__sitecustomize__';
    const fileName = process.argv[1].replace(`${dir_scripts}/`, '');
    let command = `bash -c "source ${file_task_before} ${fileName}`;
    if (task_before) {
      const escapeTaskBefore = task_before.replace(/"/g, '\\"');
      command = `${command} && echo -e '执行前置命令\n' && eval '${escapeTaskBefore}' && echo -e '\n执行前置命令结束\n'`;
    }
    const res = execSync(
      `${command} && echo -e '${splitStr}' && NODE_OPTIONS= node -p 'JSON.stringify(process.env)'"`,
      {
        encoding: 'utf-8',
      },
    );
    const [output, envStr] = res.split(splitStr);
    const newEnvObject = JSON.parse(envStr.trim());
    for (const key in newEnvObject) {
      process.env[key] = newEnvObject[key];
    }
    console.log(output);
  } catch (error) {
    if (!error.message.includes('spawnSync /bin/sh E2BIG')) {
      console.log(`run task before error: `, error);
    }
  }

  if (envParam && numParam) {
    const array = (process.env[envParam] || '').split('&');
    const runArr = expandRange(numParam, array.length);
    const arrayRun = runArr.map((i) => array[i - 1]);
    const envStr = arrayRun.join('&');
    process.env[envParam] = envStr;
  }
}

try {
  initGlobal();
  run();
} catch (error) {
  console.log(`run builtin code error: `, error, '\n');
}
