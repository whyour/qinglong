import { Service } from 'typedi';
import config from '../config';
import { getFileContentByName } from '../config/util';
import { t } from '../shared/i18n';
import { Response } from 'express';
import { request } from 'undici';
import { resolveFileAccess } from '../shared/fileAccess';

@Service()
export default class ConfigService {
  constructor() {}

  public async getFile(filePath: string, res: Response) {
    let content = '';
    if (!filePath || filePath.startsWith('data/scripts/')) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }
    const resolved = resolveFileAccess(
      config.configPath,
      [filePath],
      config.blackFileList,
    );
    if (!resolved) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }

    if (filePath.startsWith('sample/')) {
      const res = await request(
        `https://gitlab.com/whyour/qinglong/-/raw/master/${filePath}`,
      );
      content = await res.body.text();
    } else {
      content = await getFileContentByName(resolved);
    }

    res.send({ code: 200, data: content });
  }
}
