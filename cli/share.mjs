#!/usr/bin/env zx
import 'zx/globals';
// $.verbose = true;

import { updateCron, notifyApi } from './api.mjs';
import { restoreEnvVars } from './env.mjs';

export const dirRoot = process.env.QL_DIR;
export const dirTmp = path.join(dirRoot, '.tmp');
export const dirData = process.env.QL_DATA_DIR
  ? process.env.QL_DATA_DIR.endsWith('/')
    ? process.env.QL_DATA_DIR.slice(-1)
    : process.env.QL_DATA_DIR
  : path.join(dirRoot, 'data');
export const dirShell = path.join(dirRoot, 'shell');
export const dirCli = path.join(dirRoot, 'cli');
export const dirSample = path.join(dirRoot, 'sample');
export const dirStatic = path.join(dirRoot, 'static');
export const dirConfig = path.join(dirData, 'config');
export const dirScripts = path.join(dirData, 'scripts');
export const dirRepo = path.join(dirData, 'repo');
export const dirRaw = path.join(dirData, 'raw');
export const dirLog = path.join(dirData, 'log');
export const dirDb = path.join(dirData, 'db');
export const dirDep = path.join(dirData, 'deps');
export const dirListTmp = path.join(dirLog, '.tmp');
export const dirUpdateLog = path.join(dirLog, 'update');
export const qlStaticRepo = path.join(dirRepo, 'static');

export const fileConfigSample = path.join(dirSample, 'config.sample.sh');
export const fileEnv = path.join(dirConfig, 'env.sh');
export const jsFileEnv = path.join(dirConfig, 'env.js');
export const fileConfigUser = path.join(dirConfig, 'config.sh');
export const fileAuthSample = path.join(dirSample, 'auth.sample.json');
export const fileAuthUser = path.join(dirConfig, 'auth.json');
export const fileAuthToken = path.join(dirConfig, 'token.json');
export const fileExtraShell = path.join(dirConfig, 'extra.sh');
export const fileTaskBefore = path.join(dirConfig, 'task_before.sh');
export const fileTaskAfter = path.join(dirConfig, 'task_after.sh');
export const fileTaskSample = path.join(dirSample, 'task.sample.sh');
export const fileExtraSample = path.join(dirSample, 'extra.sample.sh');
export const fileNotifyJsSample = path.join(dirSample, 'notify.js');
export const fileNotifyPySample = path.join(dirSample, 'notify.py');
export const fileTestJsSample = path.join(dirSample, 'ql_sample.js');
export const fileTestPySample = path.join(dirSample, 'ql_sample.py');
export const fileNotifyPy = path.join(dirScripts, 'notify.py');
export const fileNotifyJs = path.join(dirScripts, 'sendNotify.js');
export const fileTestJs = path.join(dirScripts, 'ql_sample.js');
export const fileTestPy = path.join(dirScripts, 'ql_sample.py');
export const nginxAppConf = path.join(dirRoot, 'docker/front.conf');
export const nginxConf = path.join(dirRoot, 'docker/nginx.conf');
export const depNotifyPy = path.join(dirDep, 'notify.py');
export const depNotifyJs = path.join(dirDep, 'sendNotify.js');

export const listCrontabUser = path.join(dirConfig, 'crontab.list');
export const listCrontabSample = path.join(dirSample, 'crontab.sample.list');
export const listOwnScripts = path.join(dirListTmp, 'own_scripts.list');
export const listOwnUser = path.join(dirListTmp, 'own_user.list');
export const listOwnAdd = path.join(dirListTmp, 'own_add.list');
export const listOwnDrop = path.join(dirListTmp, 'own_drop.list');

export const globalState = {};

export const initEnv = () => {
  $.prefix +=
    'export NODE_PATH=/usr/local/bin:/usr/local/pnpm-global/5/node_modules:/usr/local/lib/node_modules:/root/.local/share/pnpm/global/5/node_modules;';
  $.prefix += 'export PYTHONUNBUFFERED=1;';
  $.prefix += 'export TERM=xterm-color;';
};

export const importConfig = async () => {
  if (await fs.exists(fileConfigUser)) {
    $.prefix += (await fs.readFile(fileConfigUser, 'utf8'));
  }
  // if (process.env.LOAD_ENV !== 'false' && (await fs.exists(fileEnv))) {
  //   $.prefix += (await fs.readFile(fileEnv, 'utf8'));
  // }
  require(jsFileEnv)

  globalState.qlBaseUrl = process.env.QlBaseUrl || '/';
  globalState.qlPort = process.env.QlPort || '5700';
  globalState.commandTimeoutTime = process.env.CommandTimeoutTime;
  globalState.fileExtensions = process.env.RepoFileExtensions || 'js py';
  globalState.proxyUrl = process.env.ProxyUrl || '';
  globalState.currentBranch = process.env.QL_BRANCH;

  if (process.env.DefaultCronRule) {
    globalState.defaultCron = process.env.DefaultCronRule;
  } else {
    globalState.defaultCron = `${Math.floor(Math.random() * 60)} ${Math.floor(
      Math.random() * 24,
    )} * * *`;
  }

  globalState.cpuWarn = process.env.CpuWarn;
  globalState.memWarn = process.env.MemoryWarn;
  globalState.diskWarn = process.env.DiskWarn;
};

export const setProxy = (proxy) => {
  if (proxy) {
    globalState.proxyUrl = proxy;
  }
  if (globalState.proxyUrl) {
    $`export http_proxy=${globalState.proxyUrl}`;
    $`export https_proxy=${globalState.proxyUrl}`;
  }
};

export const unsetProxy = () => {
  $`unset http_proxy`;
  $`unset https_proxy`;
};

export const makeDir = async (dir) => {
  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir, { recursive: true });
  }
};

export const detectTermux = () => {
  globalState.isTermux = process.env.PATH?.includes('com.termux') ? 1 : 0;
};

export const detectMacos = () => {
  globalState.isMacos = os.type() === 'Darwin' ? 1 : 0;
};

export const genRandomNum = (number) => {
  return Math.floor(Math.random() * number);
};

export const fixConfig = async () => {
  await makeDir(dirTmp);
  await makeDir(dirStatic);
  await makeDir(dirData);
  await makeDir(dirConfig);
  await makeDir(dirLog);
  await makeDir(dirDb);
  await makeDir(dirScripts);
  await makeDir(dirListTmp);
  await makeDir(dirRepo);
  await makeDir(dirRaw);
  await makeDir(dirUpdateLog);
  await makeDir(dirDep);

  if (!(await fs.exists(fileConfigUser))) {
    console.log(
      `复制一份 ${fileConfigSample} 为 ${fileConfigUser}，随后请按注释编辑你的配置文件：${fileConfigUser}`,
    );
    await fs.copyFile(fileConfigSample, fileConfigUser);
  }

  if (!(await fs.exists(fileEnv))) {
    console.log(
      '检测到config配置目录下不存在env.sh，创建一个空文件用于初始化...',
    );
    await fs.writeFile(fileEnv, '');
  }

  if (!(await fs.exists(fileTaskBefore))) {
    console.log(`复制一份 ${fileTaskSample} 为 ${fileTaskBefore}`);
    await fs.copyFile(fileTaskSample, fileTaskBefore);
  }

  if (!(await fs.exists(fileTaskAfter))) {
    console.log(`复制一份 ${fileTaskSample} 为 ${fileTaskAfter}`);
    await fs.copyFile(fileTaskSample, fileTaskAfter);
  }

  if (!(await fs.exists(fileExtraShell))) {
    console.log(`复制一份 ${fileExtraSample} 为 ${fileExtraShell}`);
    await fs.copyFile(fileExtraSample, fileExtraShell);
  }

  if (!(await fs.exists(fileAuthUser))) {
    console.log(`复制一份 ${fileAuthSample} 为 ${fileAuthUser}`);
    await fs.copyFile(fileAuthSample, fileAuthUser);
  }

  if (!(await fs.exists(fileNotifyPy))) {
    console.log(`复制一份 ${fileNotifyPySample} 为 ${fileNotifyPy}`);
    await fs.copyFile(fileNotifyPySample, fileNotifyPy);
  }

  if (!(await fs.exists(fileNotifyJs))) {
    console.log(`复制一份 ${fileNotifyJsSample} 为 ${fileNotifyJs}`);
    await fs.copyFile(fileNotifyJsSample, fileNotifyJs);
  }

  if (!(await fs.exists(fileTestJs))) {
    await fs.copyFile(fileTestJsSample, fileTestJs);
  }

  if (!(await fs.exists(fileTestPy))) {
    await fs.copyFile(fileTestPySample, fileTestPy);
  }

  if (await fs.exists('/etc/nginx/conf.d/default.conf')) {
    console.log('检测到你可能未修改过默认nginx配置，将帮你删除');
    await fs.unlink('/etc/nginx/conf.d/default.conf');
  }
  if (!(await fs.exists(depNotifyJs))) {
    console.log(`复制一份 ${fileNotifyJsSample} 为 ${depNotifyJs}`);
    await fs.copyFile(fileNotifyJsSample, depNotifyJs);
  }

  if (!(await fs.exists(depNotifyPy))) {
    console.log(`复制一份 ${fileNotifyPySample} 为 ${depNotifyPy}`);
    await fs.copyFile(fileNotifyPySample, depNotifyPy);
  }
};

export const npmInstallSub = async () => {
  if (globalState.isTermux === 1) {
    await $`npm install --production --no-bin-links`;
  } else if (!(await $`command -v pnpm`)) {
    await $`npm install --production`;
  } else {
    await $`pnpm install --loglevel error --production`;
  }
};

export const npmInstall = async (dirWork) => {
  const dirCurrent = process.cwd();

  await $`cd ${dirWork}`;
  console.log(`安装 ${dirWork} 依赖包...`);
  await npmInstallSub();
  await $`cd ${dirCurrent}`;
};

export const diffAndCopy = async (copySource, copyTo) => {
  if (
    !(await fs.exists(copyTo)) ||
    (await $`diff ${copySource} ${copyTo}`).exitCode !== 0
  ) {
    await fs.copyFile(copySource, copyTo);
  }
};

export const gitCloneScripts = async (url, dir, branch, proxy) => {
  const partCmd = branch ? `-b ${branch}` : '';
  console.log(`开始拉取仓库 ${globalState.uniqPath} 到 ${dir}`);

  setProxy(proxy);

  const res = await $`git clone -q --depth=1 ${partCmd} ${url} ${dir}`;
  globalState.exitStatus = res.exitCode;

  unsetProxy();
};

export const randomRange = (begin, end) => {
  return Math.floor(Math.random() * (end - begin) + begin);
};

export const deletePm2 = async () => {
  await $`cd ${dirRoot}`;
  await $`pm2 delete ecosystem.config.js`;
};

export const reloadPm2 = async () => {
  await $`cd ${dirRoot}`;
  restoreEnvVars();
  await $`pm2 flush &>/dev/null`;
  await $`pm2 startOrGracefulReload ecosystem.config.js`;
};

export const reloadUpdate = async () => {
  await $`cd ${dirRoot}`;
  restoreEnvVars();
  await $`pm2 flush &>/dev/null`;
  await $`pm2 startOrGracefulReload other.config.js`;
};

export const diffTime = (beginTime, endTime) => {
  let diffTime;
  if (globalState.isMacos === 1) {
    diffTime = (+new Date(endTime) - +new Date(beginTime)) / 1000;
  } else {
    diffTime =
      (new Date(endTime).getTime() - new Date(beginTime).getTime()) / 1000;
  }
  return diffTime;
};

export const formatTime = (time) => {
  // 秒
  return new Date(time).toLocaleString();
};

function pad(n, min = 10) {
  return n < min ? '0' + n : n;
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export const formatLogTime = (date) => {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  const milliSecond = pad(date.getMilliseconds(), 100);

  return `${year}-${month}-${day}-${hour}-${minute}-${second}-${milliSecond}`;
};

export const formatTimestamp = (date) => {
  return Math.floor(date.getTime() / 1000);
};

export const patchVersion = async () => {
  await $`git config --global pull.rebase false`;

  if (await fs.exists(path.join(dirRoot, 'db/cookie.db'))) {
    console.log('检测到旧的db文件，拷贝为新db...');
    await $`mv ${path.join(dirRoot, 'db/cookie.db')} ${path.join(
      dirRoot,
      'db/env.db',
    )}`;
    await $`rm -rf ${path.join(dirRoot, 'db/cookie.db')}`;
  }

  if (await fs.exists(path.join(dirRoot, 'db'))) {
    console.log('检测到旧的db目录，拷贝到data目录...');
    await $`cp -rf ${path.join(dirRoot, 'config')} ${dirData}`;
  }

  if (await fs.exists(path.join(dirRoot, 'scripts'))) {
    console.log('检测到旧的scripts目录，拷贝到data目录...');
    await $`cp -rf ${path.join(dirRoot, 'scripts')} ${dirData}`;
  }

  if (await fs.exists(path.join(dirRoot, 'log'))) {
    console.log('检测到旧的log目录，拷贝到data目录...');
    await $`cp -rf ${path.join(dirRoot, 'log')} ${dirData}`;
  }

  if (await fs.exists(path.join(dirRoot, 'config'))) {
    console.log('检测到旧的config目录，拷贝到data目录...');
    await $`cp -rf ${path.join(dirRoot, 'config')} ${dirData}`;
  }
};

export const initNginx = async () => {
  await fs.copyFile(nginxConf, '/etc/nginx/nginx.conf');
  await fs.copyFile(nginxAppConf, '/etc/nginx/conf.d/front.conf');
  let locationUrl = '/';
  let aliasStr = '';
  let rootStr = '';
  let qlBaseUrl = globalState.qlBaseUrl;
  let qlPort = globalState.qlPort;
  if (qlBaseUrl !== '/') {
    if (!qlBaseUrl.startsWith('/')) {
      qlBaseUrl = `/${qlBaseUrl}`;
    }
    if (!qlBaseUrl.endsWith('/')) {
      qlBaseUrl = `${qlBaseUrl}/`;
    }
    locationUrl = `^~${qlBaseUrl.slice(0, -1)}`;
    aliasStr = `alias ${path.join(dirStatic, 'dist')};`;
    const file = await fs.readFile(
      path.join(dirStatic, 'dist/index.html'),
      'utf8',
    );
    if (!file.includes(`<base href="${qlBaseUrl}">`)) {
      await fs.writeFile(
        path.join(dirStatic, 'dist/index.html'),
        `<base href="${qlBaseUrl}">\n${file}`,
      );
    }
  } else {
    rootStr = `root ${path.join(dirStatic, 'dist')};`;
  }
  await $`sed -i "s,QL_ALIAS_CONFIG,${aliasStr},g" /etc/nginx/conf.d/front.conf`;
  await $`sed -i "s,QL_ROOT_CONFIG,${rootStr},g" /etc/nginx/conf.d/front.conf`;
  await $`sed -i "s,QL_BASE_URL_LOCATION,${locationUrl},g" /etc/nginx/conf.d/front.conf`;
  let ipv6Str = '';
  const ipv6 = await $`ip a | grep inet6`;
  if (ipv6.stdout.trim()) {
    ipv6Str = 'listen [::]:${qlPort} ipv6only=on;';
  }
  const ipv4Str = `listen ${qlPort};`;
  await $`sed -i "s,IPV6_CONFIG,${ipv6Str},g" /etc/nginx/conf.d/front.conf`;
  await $`sed -i "s,IPV4_CONFIG,${ipv4Str},g" /etc/nginx/conf.d/front.conf`;
};

async function checkServer() {
  const cpuWarn = parseInt(process.env.cpuWarn || '0');
  const memWarn = parseInt(process.env.memWarn || '0');
  const diskWarn = parseInt(process.env.diskWarn || '0');

  if (cpuWarn && memWarn && diskWarn) {
    const topResult = await $`top -b -n 1`;
    const cpuUse = parseInt(
      topResult.stdout.match(/CPU\s+(\d+)\%/)?.[1] || '0',
    );
    const memFree = parseInt(
      (await $`free -m`).stdout.match(/Mem:\s+(\d+)/)?.[1] || '0',
    );
    const memTotal = parseInt(
      (await $`free -m`).stdout.match(/Mem:\s+\d+\s+(\d+)/)?.[1] || '0',
    );
    const diskUse = parseInt(
      (await $`df -P`).stdout.match(/\/dev.*\s+(\d+)\%/)?.[1] || '0',
    );
    if (memFree && memTotal && diskUse && cpuUse) {
      const memUse = Math.floor((memFree * 100) / memTotal);

      if (cpuUse > cpuWarn || memFree < memWarn || diskUse > diskWarn) {
        const resource = topResult.stdout
          .split('\n')
          .slice(7, 17)
          .map((line) => line.replace(/\s+/g, ' '))
          .join('\\n');
        await notifyApi(
          '服务器资源异常警告',
          `当前CPU占用 ${cpuUse}% 内存占用 ${memUse}% 磁盘占用 ${diskUse}% \n资源占用详情 \n\n ${resource}`,
        );
      }
    }
  }
}

export const handleTaskStart = async () => {
  if (globalState.ID) {
    await updateCron(
      [globalState.ID],
      '0',
      String(process.pid),
      globalState.logPath,
      globalState.beginTimestamp,
    );
  }
  console.log(`## 开始执行... ${globalState.beginTime}\n`);
};

export const runTaskBefore = async () => {
  if (globalState.isMacos === 0) {
    await checkServer();
  }
  await $`. ${fileTaskBefore} "$@"`;

  if (globalState.taskBefore) {
    console.log('执行前置命令');
    await $`eval ${globalState.taskBefore}`;
    console.log('执行前置命令结束');
  }
};

export const runTaskAfter = async () => {
  await $`. ${fileTaskAfter} "$@"`;

  if (globalState.taskAfter) {
    console.log('执行后置命令');
    await $`eval "${globalState.taskAfter}"`;
    console.log('执行后置命令结束');
  }
};

export const handleTaskEnd = async () => {
  const etime = new Date();
  const endTime = formatDate(etime);
  const endTimestamp = formatTimestamp(etime);
  let diffTime = endTimestamp - globalState.beginTimestamp;

  if (diffTime === 0) {
    diffTime = 1;
  }

  if (globalState.ID) {
    await updateCron(
      [globalState.ID],
      '1',
      `${process.pid}`,
      globalState.logPath,
      globalState.beginTimestamp,
      diffTime,
    );
  }

  console.log(`\n## 执行结束... ${endTime}  耗时 ${diffTime} 秒`);
};

initEnv();
detectTermux();
detectMacos();
await importConfig();
