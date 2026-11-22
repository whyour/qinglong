const { execFileSync } = require('child_process');
const Module = require('module');
const path = require('path');
const client = require('./client.js');
require(`./env.js`);

// 注册 ESM loader，使全局安装的包也可通过 import 导入
try {
  Module.register(new URL('esm-loader.mjs', `file://${__dirname}/`).href);
} catch (_) {}

function preferGlobalNodeModules() {
  const { QL_NODE_GLOBAL_PATH } = process.env;
  if (!QL_NODE_GLOBAL_PATH || Module._qlGlobalPathPatched) {
    return;
  }

  const clientModule = require.cache[require.resolve('./client.js')];
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (
      !clientModule.loadingPanelDependencies &&
      !Module.builtinModules.includes(request) &&
      !request.startsWith('node:') &&
      !request.startsWith('.') &&
      !path.isAbsolute(request)
    ) {
      try {
        return originalResolveFilename.call(this, request, parent, isMain, {
          ...options,
          paths: [QL_NODE_GLOBAL_PATH],
        });
      } catch (error) {}
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  Module._qlGlobalPathPatched = true;
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
    PREV_NODE_OPTIONS,
  } = process.env;

  try {
    process.env.NODE_OPTIONS = PREV_NODE_OPTIONS;

    const splitStr = '__sitecustomize__';
    // ts-node is argv[1] during preload; the task runner knows the actual script.
    const fileName = (process.env.QL_SCRIPT_ENTRY || process.argv[1]).replace(
      `${dir_scripts}/`,
      '',
    );
    const tempFile = `/tmp/env_${process.pid}.json`;

    // Pass paths as arguments: shell syntax in a filename must stay literal.
    const command = `file="$1"; output="$2"; inline="$3"; shift 3
source "$file" "$@" &&
{ if [ -n "$inline" ]; then eval "$inline"; fi; } &&
printf '%s\\n' '__sitecustomize__' &&
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' "$output"`;

    if (task_before) {
      console.log(
        process.env.QL_LANG === 'en'
          ? 'Executing before command\n'
          : '执行前置命令\n',
      );
    }

    const res = execFileSync(
      '/bin/bash',
      [
        '-c',
        command,
        'ql-before',
        file_task_before,
        tempFile,
        task_before || '',
        fileName,
      ],
      { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
    );

    const [output] = res.split(splitStr);

    try {
      const envStr = require('fs').readFileSync(tempFile, 'utf-8');
      const newEnvObject = JSON.parse(envStr);
      if (typeof newEnvObject === 'object' && newEnvObject !== null) {
        for (const key in newEnvObject) {
          if (
            Object.prototype.hasOwnProperty.call(newEnvObject, key) &&
            key !== 'NODE_PATH' &&
            key !== 'QL_NODE_GLOBAL_PATH'
          ) {
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
      console.log(
        process.env.QL_LANG === 'en'
          ? 'Before command finished\n'
          : '执行前置命令结束\n',
      );
    }
  } catch (error) {
    if (!error.message.includes('spawnSync /bin/bash E2BIG')) {
      console.log(`\ue926 run task before error: `, error);
    } else {
      // environment variable is too large
    }
    if (task_before) {
      console.log(
        process.env.QL_LANG === 'en'
          ? 'Before command finished\n'
          : '执行前置命令结束\n',
      );
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

  preferGlobalNodeModules();

  process.on('SIGTERM', (code) => {
    process.exit(15);
  });

  run();

  global.QLAPI = {
    notify(...args) {
      // Keep notification dependencies out of ordinary script startup.
      // require caches the module after the first notification.
      const { sendNotify } = require('./__ql_notify__.js');
      return sendNotify.apply(this, args);
    },
    ...client,
  };
} catch (error) {
  console.log(`run builtin code error: `, error, '\n');
}

if (process.env.QL_SCRIPT_ENTRY && process.env.QL_SCRIPT_START_FILE) {
  require('./script-start.cjs')(
    process.env.QL_SCRIPT_ENTRY,
    process.env.QL_SCRIPT_START_FILE,
  );
}
