import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import psTreeFun from 'ps-tree';
import { promisify } from 'util';
import { load } from 'js-yaml';
import config from './index';
import { PYTHON_INSTALL_DIR, TASK_COMMAND } from './const';
import Logger from '../loaders/logger';
import { writeFileWithLock } from '../shared/utils';
import { DependenceTypes } from '../data/dependence';
import { FormData } from 'undici';

export * from './share';

export async function getFileContentByName(fileName: string) {
  const _exsit = await fileExist(fileName);
  if (_exsit) {
    return await fs.readFile(fileName, 'utf8');
  }
  return '';
}

export function removeAnsi(text: string) {
  return text.replace(/\x1b\[\d+m/g, '');
}

export async function getLastModifyFilePath(dir: string) {
  let filePath = '';

  const _exsit = await fileExist(dir);
  if (_exsit) {
    const arr = await fs.readdir(dir);

    arr.forEach(async (item) => {
      const fullpath = path.join(dir, item);
      const stats = await fs.lstat(fullpath);
      if (stats.isFile()) {
        if (stats.mtimeMs >= 0) {
          filePath = fullpath;
        }
      }
    });
  }
  return filePath;
}

export function getToken(req: any) {
  const { authorization = '' } = req.headers;
  if (authorization && authorization.split(' ')[0] === 'Bearer') {
    return (authorization as string)
      .replace('Bearer ', '')
      .replace('mobile-', '')
      .replace('desktop-', '');
  }
  return '';
}

export function getPlatform(userAgent: string): 'mobile' | 'desktop' {
  const ua = userAgent.toLowerCase();
  const testUa = (regexp: RegExp) => regexp.test(ua);
  const testVs = (regexp: RegExp) =>
    (ua.match(regexp) || [])
      .toString()
      .replace(/[^0-9|_.]/g, '')
      .replace(/_/g, '.');

  // 系统
  let system = 'unknow';
  if (testUa(/windows|win32|win64|wow32|wow64/g)) {
    system = 'windows'; // windows系统
  } else if (testUa(/macintosh|macintel/g)) {
    system = 'macos'; // macos系统
  } else if (testUa(/x11/g)) {
    system = 'linux'; // linux系统
  } else if (testUa(/android|adr/g)) {
    system = 'android'; // android系统
  } else if (testUa(/ios|iphone|ipad|ipod|iwatch/g)) {
    system = 'ios'; // ios系统
  } else if (testUa(/openharmony/g)) {
    system = 'openharmony'; // openharmony系统
  }

  let platform = 'desktop';
  if (system === 'windows' || system === 'macos' || system === 'linux') {
    platform = 'desktop';
  } else if (
    system === 'android' ||
    system === 'ios' ||
    system === 'openharmony' ||
    testUa(/mobile/g)
  ) {
    platform = 'mobile';
  }

  return platform as 'mobile' | 'desktop';
}

export async function fileExist(file: any) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    return false;
  }
}

export async function createFile(file: string, data: string = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileWithLock(file, data);
}

export async function handleLogPath(
  logPath: string,
  data: string = '',
): Promise<string> {
  const absolutePath = path.resolve(config.logPath, logPath);
  const logFileExist = await fileExist(absolutePath);
  if (!logFileExist) {
    await createFile(absolutePath, data);
  }
  return absolutePath;
}

export async function concurrentRun(
  fnList: Array<() => Promise<any>> = [],
  max = 5,
) {
  if (!fnList.length) return;

  const replyList: any[] = []; // 收集任务执行结果
  const startTime = new Date().getTime(); // 记录任务执行开始时间

  // 任务执行程序
  const schedule = async (index: number) => {
    return new Promise(async (resolve) => {
      const fn = fnList[index];
      if (!fn) return resolve(null);

      // 执行当前异步任务
      const reply = await fn();
      replyList[index] = reply;

      // 执行完当前任务后，继续执行任务池的剩余任务
      await schedule(index + max);
      resolve(null);
    });
  };

  // 任务池执行程序
  const scheduleList = new Array(max)
    .fill(0)
    .map((_, index) => schedule(index));

  // 使用 Promise.all 批量执行
  const r = await Promise.all(scheduleList);
  const cost = (new Date().getTime() - startTime) / 1000;

  return replyList;
}

enum FileType {
  'directory',
  'file',
}

export interface IFile {
  title: string;
  key: string;
  type: 'directory' | 'file';
  parent: string;
  createTime: number;
  size?: number;
  children?: IFile[];
}

export function dirSort(a: IFile, b: IFile): number {
  if (a.type === 'file' && b.type === 'file') {
    return b.createTime - a.createTime;
  } else if (a.type === 'directory' && b.type === 'directory') {
    return a.title.localeCompare(b.title);
  } else {
    return a.type === 'directory' ? -1 : 1;
  }
}

export async function readDirs(
  dir: string,
  baseDir: string = '',
  blacklist: string[] = [],
  sort: (a: IFile, b: IFile) => number = dirSort,
): Promise<IFile[]> {
  const relativePath = path.relative(baseDir, dir);
  const files = await fs.readdir(dir);
  const result: IFile[] = [];

  for (const file of files) {
    const subPath = path.join(dir, file);
    const stats = await fs.lstat(subPath);
    const key = path.join(relativePath, file);

    if (blacklist.includes(file) || stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      const children = await readDirs(subPath, baseDir, blacklist, sort);
      result.push({
        title: file,
        key,
        type: 'directory',
        parent: relativePath,
        createTime: stats.birthtime.getTime(),
        children: children.sort(sort),
      });
    } else {
      result.push({
        title: file,
        type: 'file',
        key,
        parent: relativePath,
        size: stats.size,
        createTime: stats.birthtime.getTime(),
      });
    }
  }

  return result.sort(sort);
}

export async function readDir(
  dir: string,
  baseDir: string = '',
  blacklist: string[] = [],
): Promise<IFile[]> {
  const absoluteDir = path.join(baseDir, dir);
  const relativePath = path.relative(baseDir, absoluteDir);

  try {
    const files = await fs.readdir(absoluteDir);
    const result: IFile[] = [];

    for (const file of files) {
      const subPath = path.join(absoluteDir, file);
      const stats = await fs.lstat(subPath);
      const key = path.join(relativePath, file);

      if (blacklist.includes(file) || stats.isSymbolicLink()) {
        continue;
      }

      if (stats.isDirectory()) {
        result.push({
          title: file,
          type: 'directory',
          key,
          parent: relativePath,
          createTime: stats.birthtime.getTime(),
          children: [],
        });
      } else {
        result.push({
          title: file,
          type: 'file',
          key,
          parent: relativePath,
          size: stats.size,
          createTime: stats.birthtime.getTime(),
        });
      }
    }

    return result;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function promiseExec(command: string): Promise<string> {
  try {
    const { stderr, stdout } = await promisify(exec)(command, {
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout || stderr;
  } catch (error) {
    return JSON.stringify(error);
  }
}

export async function promiseExecSuccess(command: string): Promise<string> {
  try {
    const { stdout } = await promisify(exec)(command, {
      maxBuffer: 200 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout || '';
  } catch (error) {
    return '';
  }
}

export function parseHeaders(headers: string) {
  if (!headers) return {};

  const parsed: any = {};
  let key: string;
  let val: string;
  let i: number;

  headers &&
    headers.split('\n').forEach(function parser(line) {
      i = line.indexOf(':');
      key = line.substring(0, i).trim().toLowerCase();
      val = line.substring(i + 1).trim();

      if (!key) {
        return;
      }

      parsed[key] = parsed[key] ? parsed[key] + ', ' + val : val;
    });

  return parsed;
}

function parseString(
  input: string,
  valueFormatFn?: (v: string) => string,
): Record<string, string> {
  const regex = /(\w+):\s*((?:(?!\n\w+:).)*)/g;
  const matches: Record<string, string> = {};

  let match;
  while ((match = regex.exec(input)) !== null) {
    const [, key, value] = match;
    const _key = key.trim();
    if (!_key || matches[_key]) {
      continue;
    }

    let _value = value.trim();

    try {
      _value = valueFormatFn ? valueFormatFn(_value) : _value;
      const jsonValue = JSON.parse(_value);
      matches[_key] = jsonValue;
    } catch (error) {
      matches[_key] = _value;
    }
  }

  return matches;
}

export function parseBody(
  body: string,
  contentType:
    | 'application/json'
    | 'multipart/form-data'
    | 'application/x-www-form-urlencoded'
    | 'text/plain',
  valueFormatFn?: (v: string) => string,
) {
  if (contentType === 'text/plain' || !body) {
    return valueFormatFn && body ? valueFormatFn(body) : body;
  }

  const parsed = parseString(body, valueFormatFn);

  switch (contentType) {
    case 'multipart/form-data':
      return Object.keys(parsed).reduce((p, c) => {
        p.append(c, parsed[c]);
        return p;
      }, new FormData());
    case 'application/x-www-form-urlencoded':
      return Object.keys(parsed).reduce((p, c) => {
        return p ? `${p}&${c}=${parsed[c]}` : `${c}=${parsed[c]}`;
      });
  }

  return parsed;
}

export function psTree(pid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    psTreeFun(pid, (err: any, children) => {
      if (err) {
        reject(err);
      }
      resolve(children.map((x) => Number(x.PID)).filter((x) => !isNaN(x)));
    });
  });
}

export async function killTask(pid: number) {
  const pids = await psTree(pid);

  if (pids.length) {
    try {
      [pid, ...pids].reverse().forEach((x) => {
        process.kill(x, 15);
      });
    } catch (error) {}
  } else {
    process.kill(pid, 2);
  }
}

export async function getPid(cmd: string) {
  const taskCommand = `ps -eo pid,command | grep "${cmd}" | grep -v grep | awk '{print $1}' | head -1 | xargs echo -n`;
  const pid = await promiseExec(taskCommand);
  return pid ? Number(pid) : undefined;
}

interface IVersion {
  version: string;
  changeLogLink: string;
  changeLog: string;
  publishTime: string;
}

export async function parseVersion(path: string): Promise<IVersion> {
  return load(await fs.readFile(path, 'utf8')) as IVersion;
}

export function parseContentVersion(content: string): IVersion {
  return load(content) as IVersion;
}

export async function getUniqPath(
  command: string,
  id: string,
): Promise<string> {
  let suffix = '';
  if (/^\d+$/.test(id)) {
    suffix = `_${id}`;
  }

  let items = command.split(/ +/);

  const maxTimeCommandIndex = items.findIndex((x) => x === '-m');
  if (maxTimeCommandIndex !== -1) {
    items = items.slice(maxTimeCommandIndex + 2);
  }

  let str = items[0];
  if (items[0] === TASK_COMMAND) {
    str = items[1];
  }

  const dotIndex = str.lastIndexOf('.');

  if (dotIndex !== -1) {
    str = str.slice(0, dotIndex);
  }

  const slashIndex = str.lastIndexOf('/');

  let tempStr = '';
  if (slashIndex !== -1) {
    tempStr = str.slice(0, slashIndex);
    const _slashIndex = tempStr.lastIndexOf('/');
    if (_slashIndex !== -1) {
      tempStr = tempStr.slice(_slashIndex + 1);
    }
    str = `${tempStr}_${str.slice(slashIndex + 1)}`;
  }

  return `${str}${suffix}`;
}

export function safeJSONParse(value?: string) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    Logger.error('[safeJSONParse失败]', error);
    return {};
  }
}

export async function rmPath(path: string) {
  try {
    const _exsit = await fileExist(path);
    if (_exsit) {
      await fs.rm(path, { force: true, recursive: true, maxRetries: 5 });
    }
  } catch (error) {
    Logger.error('[rmPath失败]', error);
  }
}

export async function setSystemTimezone(timezone: string): Promise<boolean> {
  try {
    if (!(await fileExist(`/usr/share/zoneinfo/${timezone}`))) {
      throw new Error('Invalid timezone');
    }

    await promiseExec(`ln -sf /usr/share/zoneinfo/${timezone} /etc/localtime`);
    await promiseExec(`echo "${timezone}" > /etc/timezone`);

    return true;
  } catch (error) {
    Logger.error('[setSystemTimezone失败]', error);
    return false;
  }
}

export function getGetCommand(type: DependenceTypes, name: string): string {
  const baseCommands = {
    [DependenceTypes.nodejs]: `pnpm ls -g  | grep "${name}" | head -1`,
    [DependenceTypes.python3]: `
    python3 -c "exec('''
name='${name}'
try:
    from importlib.metadata import version
    print(version(name))
except:
    import importlib.util as u
    import importlib.metadata as m
    spec=u.find_spec(name)
    print(name if spec else '')
''')"`,
    [DependenceTypes.linux]: `apk info -es ${name}`,
  };

  return baseCommands[type];
}

export function getInstallCommand(type: DependenceTypes, name: string): string {
  const baseCommands = {
    [DependenceTypes.nodejs]: 'pnpm add -g',
    [DependenceTypes.python3]:
      'pip3 install --disable-pip-version-check --root-user-action=ignore',
    [DependenceTypes.linux]: 'apk add --no-check-certificate',
  };

  let command = baseCommands[type];

  if (type === DependenceTypes.python3 && PYTHON_INSTALL_DIR) {
    command = `${command} --prefix=${PYTHON_INSTALL_DIR}`;
  }

  return `${command} ${name.trim()}`;
}

export function getUninstallCommand(
  type: DependenceTypes,
  name: string,
): string {
  const baseCommands = {
    [DependenceTypes.nodejs]: 'pnpm remove -g',
    [DependenceTypes.python3]:
      'pip3 uninstall --disable-pip-version-check --root-user-action=ignore -y',
    [DependenceTypes.linux]: 'apk del',
  };

  return `${baseCommands[type]} ${name.trim()}`;
}

export function isDemoEnv() {
  return process.env.DeployEnv === 'demo';
}
