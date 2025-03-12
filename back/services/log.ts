import path from 'path';
import { Inject, Service } from 'typedi';
import winston from 'winston';
import config from '../config';

@Service()
export default class LogService {
  constructor(@Inject('logger') private logger: winston.Logger) {}

  public checkFilePath(filePath: string, fileName: string) {
    const finalPath = path.resolve(config.logPath, filePath, fileName);
    return finalPath.startsWith(config.logPath) ? finalPath : '';
  }
}
