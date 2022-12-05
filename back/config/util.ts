import * as fs from 'fs';
import * as path from 'path';
import got from 'got';
import iconv from 'iconv-lite';
import { exec } from 'child_process';
import FormData from 'form-data';
import psTreeFun from 'pstree.remy';
import { promisify } from 'util';

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

export function createRandomString(min: number, max: number): string {
  const num = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const english = [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'r',
    's',
    't',
    'u',
    'v',
    'w',
    'x',
    'y',
    'z',
  ];
  const ENGLISH = [
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
  ];
  const special = ['-', '_'];
  const config = num.concat(english).concat(ENGLISH).concat(special);

  const arr = [];
  arr.push(getOne(num));
  arr.push(getOne(english));
  arr.push(getOne(ENGLISH));
  arr.push(getOne(special));

  const len = min + Math.floor(Math.random() * (max - min + 1));

  for (let i = 4; i < len; i++) {
    arr.push(config[Math.floor(Math.random() * config.length)]);
  }

  const newArr = [];
  for (let j = 0; j < len; j++) {
    newArr.push(arr.splice(Math.random() * arr.length, 1)[0]);
  }

  function getOne(arr: any[]) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  return newArr.join('');
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
  children?: IFile[];
}

export function dirSort(a: IFile, b: IFile) {
  if (a.type !== b.type) return FileType[a.type] < FileType[b.type] ? -1 : 1;
  else if (a.mtime !== b.mtime) return a.mtime > b.mtime ? -1 : 1;
}

export function readDirs(
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

export function emptyDir(path: string) {
  const files = fs.readdirSync(path);
  files.forEach((file) => {
    const filePath = `${path}/${file}`;
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      emptyDir(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
  });
  fs.rmdirSync(path);
}

export function promiseExec(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve(stdout || stderr || JSON.stringify(err));
      },
    );
  });
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
    process.kill(pids[0], 2);
  } else {
    process.kill(pid, 2);
  }
}

export async function getPid(name: string) {
  let taskCommand = `ps -ef | grep "${name}" | grep -v grep | awk '{print $1}'`;
  const execAsync = promisify(exec);
  let pid = (await execAsync(taskCommand)).stdout;
  return Number(pid);
}
