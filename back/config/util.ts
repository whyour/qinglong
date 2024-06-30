import * as fs from 'fs/promises';
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
import os from 'os';

export * from './share';

let osType: 'Debian' | 'Ubuntu' | 'Alpine' | undefined;

export async function getFileContentByName(fileName: string) {
  const _exsit = await fileExist(fileName);
  if (_exsit) {
    return await fs.readFile(fileName, 'utf8');
  }
  return '';
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

export async function getNetIp(req: any) {
  const ipArray = [
    ...new Set([
      ...(req.headers['x-real-ip'] || '').split(','),
      ...(req.headers['x-forwarded-for'] || '').split(','),
      req.ip,
      ...req.ips,
      req.socket.remoteAddress,
    ]),
  ].filter(Boolean);

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
    const csdnApi = got
      .get(`https://searchplugin.csdn.net/api/v1/ip/get?ip=${ip}`, {
        timeout: 10000,
        retry: 0,
      })
      .text();
    const pconlineApi = got
      .get(`https://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`, {
        timeout: 10000,
        retry: 0,
      })
      .buffer();
    const [csdnBody, pconlineBody] = await await Promise.all<any>([
      csdnApi,
      pconlineApi,
    ]);
    const csdnRes = JSON.parse(csdnBody);
    const pconlineRes = JSON.parse(iconv.decode(pconlineBody, 'GBK'));
    let address = '';
    if (csdnBody && csdnRes.code == 200) {
      address = csdnRes.data.address;
    } else if (pconlineRes && pconlineRes.addr) {
      address = pconlineRes.addr;
    }
    return { address, ip };
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
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    return false;
  }
}

export async function createFile(file: string, data: string = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
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
  if (a.type === 'file' && b.type === 'file') {
    return b.mtime - a.mtime;
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
        mtime: stats.mtime.getTime(),
        children: children.sort(sort),
      });
    } else {
      result.push({
        title: file,
        type: 'file',
        key,
        parent: relativePath,
        size: stats.size,
        mtime: stats.mtime.getTime(),
      });
    }
  }

  return result.sort(sort);
}

export async function readDir(
  dir: string,
  baseDir: string = '',
  blacklist: string[] = [],
) {
  const relativePath = path.relative(baseDir, dir);
  const files = await fs.readdir(dir);
  const result: any = files
    .filter((x) => !blacklist.includes(x))
    .map(async (file: string) => {
      const subPath = path.join(dir, file);
      const stats = await fs.lstat(subPath);
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

export async function parseContentVersion(content: string): Promise<IVersion> {
  return load(content) as IVersion;
}

export async function getUniqPath(
  command: string,
  id: string,
): Promise<string> {
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
    Logger.error('[JSON.parse失败]', error);
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

async function getOSReleaseInfo(): Promise<string> {
  const osRelease = await fs.readFile('/etc/os-release', 'utf8');
  return osRelease;
}

function isDebian(osReleaseInfo: string): boolean {
  return osReleaseInfo.includes('Debian');
}

function isUbuntu(osReleaseInfo: string): boolean {
  return osReleaseInfo.includes('Ubuntu');
}

function isCentOS(osReleaseInfo: string): boolean {
  return osReleaseInfo.includes('CentOS') || osReleaseInfo.includes('Red Hat');
}

function isAlpine(osReleaseInfo: string): boolean {
  return osReleaseInfo.includes('Alpine');
}

export async function detectOS(): Promise<
  'Debian' | 'Ubuntu' | 'Alpine' | undefined
> {
  if (osType) return osType;
  const platform = os.platform();

  if (platform === 'linux') {
    const osReleaseInfo = await getOSReleaseInfo();
    if (isDebian(osReleaseInfo)) {
      osType = 'Debian';
    } else if (isUbuntu(osReleaseInfo)) {
      osType = 'Ubuntu';
    } else if (isAlpine(osReleaseInfo)) {
      osType = 'Alpine';
    } else {
      Logger.error(`Unknown Linux Distribution: ${osReleaseInfo}`);
      console.error(`Unknown Linux Distribution: ${osReleaseInfo}`);
    }
  } else {
    Logger.error(`Unsupported platform: ${platform}`);
    console.error(`Unsupported platform: ${platform}`);
  }

  return osType;
}

async function getCurrentMirrorDomain(
  filePath: string,
): Promise<string | null> {
  const fileContent = await fs.readFile(filePath, 'utf8');
  const lines = fileContent.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('#')) {
      continue;
    }
    const match = line.match(/https?:\/\/[^\/]+/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

async function replaceDomainInFile(
  filePath: string,
  oldDomainWithScheme: string,
  newDomainWithScheme: string,
): Promise<void> {
  let fileContent = await fs.readFile(filePath, 'utf8');
  let updatedContent = fileContent.replace(
    new RegExp(oldDomainWithScheme, 'g'),
    newDomainWithScheme,
  );

  if (!newDomainWithScheme.endsWith('/')) {
    newDomainWithScheme += '/';
  }

  await fs.writeFile(filePath, updatedContent, 'utf8');
}

async function _updateLinuxMirror(
  osType: string,
  mirrorDomainWithScheme: string,
): Promise<string> {
  let filePath: string, currentDomainWithScheme: string | null;
  switch (osType) {
    case 'Debian':
      filePath = '/etc/apt/sources.list';
      currentDomainWithScheme = await getCurrentMirrorDomain(filePath);
      if (currentDomainWithScheme) {
        await replaceDomainInFile(
          filePath,
          currentDomainWithScheme,
          mirrorDomainWithScheme || 'http://deb.debian.org',
        );
        return 'apt-get update';
      } else {
        throw Error(`Current mirror domain not found.`);
      }
    case 'Ubuntu':
      filePath = '/etc/apt/sources.list';
      currentDomainWithScheme = await getCurrentMirrorDomain(filePath);
      if (currentDomainWithScheme) {
        await replaceDomainInFile(
          filePath,
          currentDomainWithScheme,
          mirrorDomainWithScheme || 'http://archive.ubuntu.com',
        );
        return 'apt-get update';
      } else {
        throw Error(`Current mirror domain not found.`);
      }
    case 'Alpine':
      filePath = '/etc/apk/repositories';
      currentDomainWithScheme = await getCurrentMirrorDomain(filePath);
      if (currentDomainWithScheme) {
        await replaceDomainInFile(
          filePath,
          currentDomainWithScheme,
          mirrorDomainWithScheme || 'http://dl-cdn.alpinelinux.org',
        );
        return 'apk update';
      } else {
        throw Error(`Current mirror domain not found.`);
      }
    default:
      throw Error('Unsupported OS type for updating mirrors.');
  }
}

export async function updateLinuxMirrorFile(mirror: string): Promise<string> {
  const detectedOS = await detectOS();
  if (!detectedOS) {
    throw Error(`Unknown Linux Distribution`);
  }
  return await _updateLinuxMirror(detectedOS, mirror);
}
