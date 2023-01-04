import dotenv from 'dotenv';
import path from 'path';

if (!process.env.QL_DIR) {
  // 声明QL_DIR环境变量
  let qlHomePath = path.join(__dirname, '../../../');
  // 生产环境
  if (qlHomePath.endsWith('/static/')) {
    qlHomePath = path.join(qlHomePath, '../');
  }
  process.env.QL_DIR = qlHomePath.replace(/\/$/g, '');
}
const rootPath = process.env.QL_DIR as string;
const envFound = dotenv.config({ path: path.join(rootPath, '.env') });

if (envFound.error) {
  throw new Error("⚠️  Couldn't find .env file  ⚠️");
}

const envs = process.env;
console.log(envs);
export default { ...envs };
