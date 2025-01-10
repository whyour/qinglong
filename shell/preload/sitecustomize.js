const { execSync } = require('child_process');
const client = require('./client.js');
require(`./env.js`);

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
    PREV_NODE_OPTIONS,
  } = process.env;

  try {
    process.env.NODE_OPTIONS = PREV_NODE_OPTIONS;

    const splitStr = '__sitecustomize__';
    const fileName = process.argv[1].replace(`${dir_scripts}/`, '');
    let command = `bash -c "source ${file_task_before} ${fileName}`;
    if (task_before) {
      const escapeTaskBefore = task_before
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$');
      command = `${command} && eval '${escapeTaskBefore}'`;
      console.log('执行前置命令\n');
    }
    const res = execSync(
      `${command} && echo -e '${splitStr}' && node -p 'JSON.stringify(process.env)'"`,
      {
        encoding: 'utf-8',
      },
    );
    const [output, envStr] = res.split(splitStr);
    const newEnvObject = JSON.parse(envStr.trim());
    for (const key in newEnvObject) {
      process.env[key] = newEnvObject[key];
    }
    if (output) {
      console.log(output);
    }
    if (task_before) {
      console.log('执行前置命令结束\n');
    }
  } catch (error) {
    if (!error.message.includes('spawnSync /bin/sh E2BIG')) {
      console.log(`\ue926 run task before error: `, error);
    } else {
      console.log(
        `\ue926 The environment variable is too large. It is recommended to use task_before.js instead of task_before.sh\n`,
      );
    }
    if (task_before) {
      console.log('执行前置命令结束\n');
    }
  }

  require(file_task_before_js);

  if (envParam && numParam) {
    const array = (process.env[envParam] || '').split('&');
    const runArr = expandRange(numParam, array.length);
    const arrayRun = runArr.map((i) => array[i - 1]);
    const envStr = arrayRun.join('&');
    process.env[envParam] = envStr;
  }
}

try {
  if (!process.argv[1]) {
    return;
  }

  process.on('SIGTERM', (code) => {
    process.exit(15);
  });

  run();

  const { sendNotify } = require('./notify.js');
  global.QLAPI = {
    notify: sendNotify,
    ...client,
  };
} catch (error) {
  console.log(`run builtin code error: `, error, '\n');
}
