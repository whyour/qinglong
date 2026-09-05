import { resolveFileAccess } from '../shared/fileAccess';
import path from 'path';
import { Inject, Service } from 'typedi';
import winston from 'winston';
import config from '../config';

@Service()
export default class LogService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public checkFilePath(filePath: string, fileName: string) {
    return resolveFileAccess(
      config.logPath,
      [filePath || '', fileName],
      config.blackFileList,
    );
  }
}
