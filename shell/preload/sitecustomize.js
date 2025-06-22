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
    const tempFile = `/tmp/env_${process.pid}.json`;

    const commands = [
      `source ${file_task_before} ${fileName}`,
      task_before ? `eval '${task_before.replace(/'/g, "'\\''")}'` : null,
      `echo -e '${splitStr}'`,
      `node -e "require('fs').writeFileSync('${tempFile}', JSON.stringify(process.env))"`,
    ].filter(Boolean);

    if (task_before) {
      console.log('执行前置命令\n');
    }

    const res = execSync(commands.join(' && '), {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/bash',
    });

    const [output] = res.split(splitStr);

    try {
      const envStr = require('fs').readFileSync(tempFile, 'utf-8');
      const newEnvObject = JSON.parse(envStr);
      if (typeof newEnvObject === 'object' && newEnvObject !== null) {
        for (const key in newEnvObject) {
          if (Object.prototype.hasOwnProperty.call(newEnvObject, key)) {
            process.env[key] = newEnvObject[key];
          }
        }
      }
      require('fs').unlinkSync(tempFile);
    } catch (jsonError) {
      console.log(
        '\ue926 Failed to parse environment variables:',
        jsonError.message,
      );
      try {
        require('fs').unlinkSync(tempFile);
      } catch (e) {}
    }

    if (output) {
      console.log(output);
    }
    if (task_before) {
      console.log('执行前置命令结束\n');
    }
  } catch (error) {
    if (!error.message.includes('spawnSync /bin/bash E2BIG')) {
      console.log(`\ue926 run task before error: `, error);
    } else {
      // environment variable is too large
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

  const { sendNotify } = require('./__ql_notify__.js');
  global.QLAPI = {
    notify: sendNotify,
    ...client,
  };
} catch (error) {
  console.log(`run builtin code error: `, error, '\n');
}
