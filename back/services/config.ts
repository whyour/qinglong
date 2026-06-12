import { Service, Inject } from 'typedi';
import path, { join } from 'path';
import config from '../config';
import { getFileContentByName } from '../config/util';
import { t } from '../shared/i18n';
import { Response } from 'express';
import { request } from 'undici';

@Service()
export default class ConfigService {
  constructor() {}

  public async getFile(filePath: string, res: Response) {
    let content = '';
    if (!filePath) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }
    const normalized = path.normalize(filePath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }
    const resolvedRoot = path.resolve(config.rootPath, normalized);
    const resolvedConfig = path.resolve(config.configPath, normalized);
    const isValidPath =
      resolvedRoot.startsWith(config.scriptPath) ||
      resolvedRoot.startsWith(config.configPath) ||
      resolvedConfig.startsWith(config.scriptPath) ||
      resolvedConfig.startsWith(config.configPath);
    if (!isValidPath) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }
    if (config.blackFileList.includes(path.basename(normalized))) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }

    if (filePath.startsWith('sample/')) {
      const res = await request(
        `https://gitlab.com/whyour/qinglong/-/raw/master/${filePath}`,
      );
      content = await res.body.text();
    } else if (filePath.startsWith('data/scripts/')) {
      content = await getFileContentByName(join(config.rootPath, filePath));
    } else {
      content = await getFileContentByName(join(config.configPath, filePath));
    }

    res.send({ code: 200, data: content });
  }
}
