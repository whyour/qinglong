"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.promiseExec = exports.readDir = exports.readDirs = exports.concurrentRun = exports.createFile = exports.fileExist = exports.getPlatform = exports.getNetIp = exports.getToken = exports.createRandomString = exports.getLastModifyFilePath = exports.getFileContentByName = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const got_1 = __importDefault(require("got"));
const iconv_lite_1 = __importDefault(require("iconv-lite"));
const child_process_1 = require("child_process");
function getFileContentByName(fileName) {
    if (fs.existsSync(fileName)) {
        return fs.readFileSync(fileName, 'utf8');
    }
    return '';
}
exports.getFileContentByName = getFileContentByName;
function getLastModifyFilePath(dir) {
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
exports.getLastModifyFilePath = getLastModifyFilePath;
function createRandomString(min, max) {
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
exports.createRandomString = createRandomString;
function getToken(req) {
    const { authorization = '' } = req.headers;
    if (authorization && authorization.split(' ')[0] === 'Bearer') {
        return authorization
            .replace('Bearer ', '')
            .replace('mobile-', '')
            .replace('desktop-', '');
    }
    return '';
}
exports.getToken = getToken;
async function getNetIp(req) {
    const ipArray = [
        ...new Set([
            ...(req.headers['x-forwarded-for'] || '').split(','),
            ...(req.headers['x-real-ip'] || '').split(','),
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
            if (tmp === '192.168' ||
                (ipNumArray[0] === '172' &&
                    ipNumArray[1] >= 16 &&
                    ipNumArray[1] <= 32) ||
                tmp === '10.7' ||
                tmp === '127.0') {
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
        const baiduApi = got_1.default
            .get(`https://www.cip.cc/${ip}`, { timeout: 10000, retry: 0 })
            .text();
        const ipApi = got_1.default
            .get(`https://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`, {
            timeout: 10000,
            retry: 0,
        })
            .buffer();
        const [data, ipApiBody] = await await Promise.all([baiduApi, ipApi]);
        const ipRegx = /.*IP	:(.*)\n/;
        const addrRegx = /.*数据二	:(.*)\n/;
        if (data && ipRegx.test(data) && addrRegx.test(data)) {
            const ip = data.match(ipRegx)[1];
            const addr = data.match(addrRegx)[1];
            return { address: addr, ip };
        }
        else if (ipApiBody) {
            const { addr, ip } = JSON.parse(iconv_lite_1.default.decode(ipApiBody, 'GBK'));
            return { address: `${addr}`, ip };
        }
        else {
            return { address: `获取失败`, ip };
        }
    }
    catch (error) {
        return { address: `获取失败`, ip };
    }
}
exports.getNetIp = getNetIp;
function getPlatform(userAgent) {
    const ua = userAgent.toLowerCase();
    const testUa = (regexp) => regexp.test(ua);
    const testVs = (regexp) => (ua.match(regexp) || [])
        .toString()
        .replace(/[^0-9|_.]/g, '')
        .replace(/_/g, '.');
    // 系统
    let system = 'unknow';
    if (testUa(/windows|win32|win64|wow32|wow64/g)) {
        system = 'windows'; // windows系统
    }
    else if (testUa(/macintosh|macintel/g)) {
        system = 'macos'; // macos系统
    }
    else if (testUa(/x11/g)) {
        system = 'linux'; // linux系统
    }
    else if (testUa(/android|adr/g)) {
        system = 'android'; // android系统
    }
    else if (testUa(/ios|iphone|ipad|ipod|iwatch/g)) {
        system = 'ios'; // ios系统
    }
    let platform = 'desktop';
    if (system === 'windows' || system === 'macos' || system === 'linux') {
        platform = 'desktop';
    }
    else if (system === 'android' || system === 'ios' || testUa(/mobile/g)) {
        platform = 'mobile';
    }
    return platform;
}
exports.getPlatform = getPlatform;
async function fileExist(file) {
    return new Promise((resolve) => {
        try {
            fs.accessSync(file);
            resolve(true);
        }
        catch (error) {
            resolve(false);
        }
    });
}
exports.fileExist = fileExist;
async function createFile(file, data = '') {
    return new Promise((resolve) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        resolve(true);
    });
}
exports.createFile = createFile;
async function concurrentRun(fnList = [], max = 5) {
    if (!fnList.length)
        return;
    const replyList = []; // 收集任务执行结果
    const startTime = new Date().getTime(); // 记录任务执行开始时间
    // 任务执行程序
    const schedule = async (index) => {
        return new Promise(async (resolve) => {
            const fn = fnList[index];
            if (!fn)
                return resolve(null);
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
exports.concurrentRun = concurrentRun;
var FileType;
(function (FileType) {
    FileType[FileType["directory"] = 0] = "directory";
    FileType[FileType["file"] = 1] = "file";
})(FileType || (FileType = {}));
function readDirs(dir, baseDir = '', blacklist = []) {
    const relativePath = path.relative(baseDir, dir);
    const files = fs.readdirSync(dir);
    const result = files
        .filter((x) => !blacklist.includes(x))
        .map((file) => {
        const subPath = path.join(dir, file);
        const stats = fs.statSync(subPath);
        const key = path.join(relativePath, file);
        if (stats.isDirectory()) {
            return {
                title: file,
                key,
                type: 'directory',
                disabled: true,
                parent: relativePath,
                children: readDirs(subPath, baseDir).sort((a, b) => FileType[a.type] - FileType[b.type]),
            };
        }
        return {
            title: file,
            type: 'file',
            key,
            parent: relativePath,
        };
    });
    return result.sort((a, b) => FileType[a.type] - FileType[b.type]);
}
exports.readDirs = readDirs;
function readDir(dir, baseDir = '', blacklist = []) {
    const relativePath = path.relative(baseDir, dir);
    const files = fs.readdirSync(dir);
    const result = files
        .filter((x) => !blacklist.includes(x))
        .map((file) => {
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
exports.readDir = readDir;
function promiseExec(command) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.exec)(command, { maxBuffer: 200 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
            resolve(stdout || stderr || JSON.stringify(err));
        });
    });
}
exports.promiseExec = promiseExec;
//# sourceMappingURL=util.js.map