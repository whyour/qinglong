import { Service, Inject } from 'typedi';
import path from 'path';
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

    // Remote sample files are fetched (and path-checked) separately.
    if (filePath.startsWith('sample/')) {
      const sampleRes = await request(
        `https://gitlab.com/whyour/qinglong/-/raw/master/${normalized}`,
      );
      return res.send({ code: 200, data: await sampleRes.body.text() });
    }

    // Resolve the ACTUAL file path first, then validate that it stays within
    // its allowed base. Validating a different path than the one read is what
    // previously allowed `data/scripts/../db/database.sqlite` style traversal.
    const isScripts = filePath.startsWith('data/scripts/');
    const base = path.resolve(isScripts ? config.scriptPath : config.configPath);
    const rel = isScripts ? filePath.slice('data/scripts/'.length) : filePath;
    const finalPath = path.resolve(base, rel);
    if (finalPath !== base && !finalPath.startsWith(base + path.sep)) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }
    if (config.blackFileList.includes(path.basename(finalPath))) {
      return res.send({ code: 403, message: t('文件无法访问') });
    }

    content = await getFileContentByName(finalPath);
    res.send({ code: 200, data: content });
  }
}
