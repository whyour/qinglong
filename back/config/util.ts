import * as fs from 'fs';
import * as path from 'path';
import got from 'got';
import iconv from 'iconv-lite';

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

  function getOne(arr) {
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
