import dotenv from 'dotenv';
import path from 'path';
import { createRandomString } from './share';

dotenv.config({
  path: path.join(__dirname, '../../.env'),
});

interface Config {
  port: number;
  grpcPort: number;
  nodeEnv: string;
  isDevelopment: boolean;
  isProduction: boolean;
  jwt: {
    secret: string;
    expiresIn?: string;
  };
  cors: {
    origin: string[];
    methods: string[];
  };
  logs: {
    level: string;
  };
  api: {
    prefix: string;
  };
}

const config: Config = {
  port: parseInt(process.env.BACK_PORT || '5600', 10),
  grpcPort: parseInt(process.env.GRPC_PORT || '5500', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
  logs: {
    level: process.env.LOG_LEVEL || 'silly',
  },
  api: {
    prefix: '/api',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'whyour-secret',
    expiresIn: process.env.JWT_EXPIRES_IN,
  },
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : ['*'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  },
};

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.QL_DIR) {
  let qlHomePath = path.join(__dirname, '../../');
  if (qlHomePath.endsWith('/static/')) {
    qlHomePath = path.join(qlHomePath, '../');
  }
  process.env.QL_DIR = qlHomePath.replace(/\/$/g, '');
}

const lastVersionFile = `https://qn.whyour.cn/version.yaml`;

const rootPath = process.env.QL_DIR as string;
const envFound = dotenv.config({ path: path.join(rootPath, '.env') });

let dataPath = path.join(rootPath, 'data/');

if (process.env.QL_DATA_DIR) {
  dataPath = process.env.QL_DATA_DIR.replace(/\/$/g, '');
}

const shellPath = path.join(rootPath, 'shell/');
const preloadPath = path.join(shellPath, 'preload/');
const tmpPath = path.join(rootPath, '.tmp/');
const samplePath = path.join(rootPath, 'sample/');
const configPath = path.join(dataPath, 'config/');
const scriptPath = path.join(dataPath, 'scripts/');
const repoPath = path.join(dataPath, 'repo/');
const bakPath = path.join(dataPath, 'bak/');
const logPath = path.join(dataPath, 'log/');
const dbPath = path.join(dataPath, 'db/');
const uploadPath = path.join(dataPath, 'upload/');
const sshdPath = path.join(dataPath, 'ssh.d/');
const systemLogPath = path.join(dataPath, 'syslog/');
const dependenceCachePath = path.join(dataPath, 'dep_cache/');

const envFile = path.join(preloadPath, 'env.sh');
const jsEnvFile = path.join(preloadPath, 'env.js');
const pyEnvFile = path.join(preloadPath, 'env.py');
const jsNotifyFile = path.join(preloadPath, '__ql_notify__.js');
const pyNotifyFile = path.join(preloadPath, '__ql_notify__.py');
const confFile = path.join(configPath, 'config.sh');
const crontabFile = path.join(configPath, 'crontab.list');
const authConfigFile = path.join(configPath, 'auth.json');
const extraFile = path.join(configPath, 'extra.sh');
const confBakDir = path.join(dataPath, 'config/bak/');
const sampleFile = path.join(samplePath, 'config.sample.sh');
const sqliteFile = path.join(samplePath, 'database.sqlite');

const authError = '错误的用户名密码，请重试';
const loginFaild = '请先登录!';
const configString = 'config sample crontab shareCode diy';
const versionFile = path.join(rootPath, 'version.yaml');
const dataTgzFile = path.join(tmpPath, 'data.tgz');
const shareShellFile = path.join(shellPath, 'share.sh');
const dependenceProxyFile = path.join(configPath, 'dependence-proxy.sh');

if (envFound.error) {
  throw new Error("⚠️  Couldn't find .env file  ⚠️");
}

export default {
  ...config,
  jwt: config.jwt,
  rootPath,
  tmpPath,
  dataPath,
  dataTgzFile,
  shareShellFile,
  dependenceProxyFile,
  configString,
  loginFaild,
  authError,
  logPath,
  extraFile,
  authConfigFile,
  confBakDir,
  crontabFile,
  sampleFile,
  confFile,
  envFile,
  jsEnvFile,
  pyEnvFile,
  jsNotifyFile,
  pyNotifyFile,
  dbPath,
  uploadPath,
  configPath,
  scriptPath,
  repoPath,
  samplePath,
  blackFileList: [
    'auth.json',
    'config.sh.sample',
    'cookie.sh',
    'crontab.list',
    'dependence-proxy.sh',
    'env.sh',
    'env.js',
    'env.py',
    'token.json',
  ],
  writePathList: [configPath, scriptPath],
  bakPath,
  apiWhiteList: [
    '/api/user/login',
    '/api/health',
    '/open/auth/token',
    '/api/user/two-factor/login',
    '/api/system',
    '/api/user/init',
    '/api/user/notification/init',
    '/open/user/login',
    '/open/user/two-factor/login',
    '/open/system',
    '/open/user/init',
    '/open/user/notification/init',
  ],
  versionFile,
  lastVersionFile,
  sqliteFile,
  sshdPath,
  systemLogPath,
  dependenceCachePath,
};
