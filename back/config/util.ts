import * as fs from 'fs';
import * as path from 'path';
import got from 'got';
import iconv from 'iconv-lite';
import { exec } from 'child_process';
import FormData from 'form-data';
import psTreeFun from 'pstree.remy';
import { promisify } from 'util';
import { load } from 'js-yaml';
import config from './index';
import { TASK_COMMAND } from './const';
import Logger from '../loaders/logger';

export * from './share';

export function getFileContentByName(fileName: string) {
  if (fs.existsSync(fileName)) {
    return fs.readFileSync(fileName, 'utf8');
  }
  return '';
}

export function getLastModifyFilePath(dir: string) {
  let filePath = '';

  if (fs.existsSync(dir)) {
    const arr = fs.readdirSync(dir);

    arr.forEach((item) => {
      const fullpath = path.join(dir, item);
      const stats = fs.statSync(fullpath);
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

export async function getNetIp(req: any) {
  const ipArray = [
    ...new Set([
      ...(req.headers['x-real-ip'] || '').split(','),
      ...(req.headers['x-forwarded-for'] || '').split(','),
      req.ip,
      ...req.ips,
      req.socket.remoteAddress,
    ]),
  ];
  let ip = ipArray[0];

  if (ipArray.length > 1) {
    for (let i = 0; i < ipArray.length; i++) {
      const ipNumArray = ipArray[i].split('.');
      const tmp = ipNumArray[0] + '.' + ipNumArray[1];
      if (
        tmp === '192.168' ||
        (ipNumArray[0] === '172' &&
          ipNumArray[1] >= 16 &&
          ipNumArray[1] <= 32) ||
        tmp === '10.7' ||
        tmp === '127.0'
      ) {
        continue;
      }
      ip = ipArray[i];
      break;
    }
  }
  ip = ip.substr(ip.lastIndexOf(':') + 1, ip.length);
  if (ip.includes('127.0') || ip.includes('192.168') || ip.includes('10.7')) {
    ip = '';
  }

  if (!ip) {
    return { address: `获取失败`, ip };
  }

  try {
    const baiduApi = got
      .get(`https://www.cip.cc/${ip}`, { timeout: 10000, retry: 0 })
      .text();
    const ipApi = got
      .get(`https://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`, {
        timeout: 10000,
        retry: 0,
      })
      .buffer();
    const [data, ipApiBody] = await await Promise.all<any>([baiduApi, ipApi]);

    const ipRegx = /.*IP	:(.*)\n/;
    const addrRegx = /.*数据二	:(.*)\n/;
    if (data && ipRegx.test(data) && addrRegx.test(data)) {
      const ip = data.match(ipRegx)[1];
      const addr = data.match(addrRegx)[1];
      return { address: addr, ip };
    } else if (ipApiBody) {
      const { addr, ip } = JSON.parse(iconv.decode(ipApiBody, 'GBK'));
      return { address: `${addr}`, ip };
    } else {
      return { address: `获取失败`, ip };
    }
  } catch (error) {
    return { address: `获取失败`, ip };
  }
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
  }

  let platform = 'desktop';
  if (system === 'windows' || system === 'macos' || system === 'linux') {
    platform = 'desktop';
  } else if (system === 'android' || system === 'ios' || testUa(/mobile/g)) {
    platform = 'mobile';
  }

  return platform as 'mobile' | 'desktop';
}

export async function fileExist(file: any) {
  return new Promise((resolve) => {
    try {
      fs.accessSync(file);
      resolve(true);
    } catch (error) {
      resolve(false);
    }
  });
}

export async function createFile(file: string, data: string = '') {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    resolve(true);
  });
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

interface IFile {
  title: string;
  key: string;
  type: 'directory' | 'file';
  parent: string;
  mtime: number;
  size?: number;
  children?: IFile[];
}

export function dirSort(a: IFile, b: IFile): number {
  if (a.type !== b.type) {
    return FileType[a.type] < FileType[b.type] ? -1 : 1
  } else if (a.mtime !== b.mtime) {
    return a.mtime > b.mtime ? -1 : 1
  } else {
    return 0;
  }
}

export function readDirs(
  dir: string,
  baseDir: string = '',
  blacklist: string[] = [],
): IFile[] {
  const relativePath = path.relative(baseDir, dir);
  const files = fs.readdirSync(dir);
  const result: IFile[] = files
    .filter((x) => !blacklist.includes(x))
    .map((file: string) => {
      const subPath = path.join(dir, file);
      const stats = fs.statSync(subPath);
      const key = path.join(relativePath, file);
      if (stats.isDirectory()) {
        return {
          title: file,
          key,
          type: 'directory',
          parent: relativePath,
          mtime: stats.mtime.getTime(),
          children: readDirs(subPath, baseDir).sort(dirSort),
        };
      }
      return {
        title: file,
        type: 'file',
        isLeaf: true,
        key,
        parent: relativePath,
        size: stats.size,
        mtime: stats.mtime.getTime(),
      };
    });
  return result.sort(dirSort);
}

export function readDir(
  dir: string,
  baseDir: string = '',
  blacklist: string[] = [],
) {
  const relativePath = path.relative(baseDir, dir);
  const files = fs.readdirSync(dir);
  const result: any = files
    .filter((x) => !blacklist.includes(x))
    .map((file: string) => {
      const subPath = path.join(dir, file);
      const stats = fs.statSync(subPath);
      const key = path.join(relativePath, file);
      return {
        title: file,
        type: stats.isDirectory() ? 'directory' : 'file',
        key,
        parent: relativePath,
      };
    });
  return result;
}

export async function emptyDir(path: string) {
  const pathExist = await fileExist(path);
  if (!pathExist) {
    return;
  }
  const files = fs.readdirSync(path);
  files.forEach(async (file) => {
    const filePath = `${path}/${file}`;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      await emptyDir(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
  });
  fs.rmdirSync(path);
}

export async function promiseExec(command: string): Promise<string> {
  try {
    const { stderr, stdout } = await promisify(exec)(command, { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' });
    return stdout || stderr;
  } catch (error) {
    return JSON.stringify(error);
  }
}

export async function promiseExecSuccess(command: string): Promise<string> {
  try {
    const { stdout } = await promisify(exec)(command, { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' });
    return stdout || '';
  } catch (error) {
    return '';
  }
}

export function parseHeaders(headers: string) {
  if (!headers) return {};

  const parsed: any = {};
  let key;
  let val;
  let i;

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

export function parseBody(
  body: string,
  contentType:
    | 'application/json'
    | 'multipart/form-data'
    | 'application/x-www-form-urlencoded',
) {
  if (!body) return '';

  const parsed: any = {};
  let key;
  let val;
  let i;

  body &&
    body.split('\n').forEach(function parser(line) {
      i = line.indexOf(':');
      key = line.substring(0, i).trim().toLowerCase();
      val = line.substring(i + 1).trim();

      if (!key || parsed[key]) {
        return;
      }

      try {
        const jsonValue = JSON.parse(val);
        parsed[key] = jsonValue;
      } catch (error) {
        parsed[key] = val;
      }
    });

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
    psTreeFun(pid, (err: any, pids: number[]) => {
      if (err) {
        reject(err);
      }
      resolve(pids.filter((x) => !isNaN(x)));
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
    } catch (error) { }
  } else {
    process.kill(pid, 2);
  }
}

export async function getPid(name: string) {
  const taskCommand = `ps -eo pid,command | grep "${name}" | grep -v grep | awk '{print $1}' | head -1 | xargs echo -n`;
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
  return load(await promisify(fs.readFile)(path, 'utf8')) as IVersion;
}

export async function parseContentVersion(content: string): Promise<IVersion> {
  return load(content) as IVersion;
}

export async function getUniqPath(command: string, id: string): Promise<string> {
  if (/^\d+$/.test(id)) {
    id = `_${id}`;
  } else {
    id = '';
  }

  const items = command.split(/ +/);
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

  return `${str}${id}`;
}

export function safeJSONParse(value?: string) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    Logger.error('[JSON.parse失败]', error)
    return {};
  }
}