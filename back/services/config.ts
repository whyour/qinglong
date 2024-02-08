import { Service, Inject } from 'typedi';
import path, { join } from 'path';
import config from '../config';
import { getFileContentByName } from '../config/util';
import { Response } from 'express';
import got from 'got';

@Service()
export default class ConfigService {
  constructor() {}

  public async getFile(filePath: string, res: Response) {
    let content = '';
    if (config.blackFileList.includes(filePath) || !filePath) {
      res.send({ code: 403, message: '文件无法访问' });
    }
    if (filePath.startsWith('sample/')) {
      const res = await got.get(
        `https://gitlab.com/whyour/qinglong/-/raw/master/${filePath}`,
      );
      content = res.body;
    } else if (filePath.startsWith('data/scripts/')) {
      content = await getFileContentByName(join(config.rootPath, filePath));
    } else {
      content = await getFileContentByName(join(config.configPath, filePath));
    }

    res.send({ code: 200, data: content });
  }
}
