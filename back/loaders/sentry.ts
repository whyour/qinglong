import * as Sentry from '@sentry/node';
import Logger from './logger';
import fs from 'fs';
import config from '../config';
import { parseContentVersion } from '../config/util';

let version = '1.0.0';
try {
  const content = fs.readFileSync(config.versionFile, 'utf-8');
  ({ version } = parseContentVersion(content));
} catch (error) {}

Sentry.init({
  ignoreErrors: [
    /SequelizeUniqueConstraintError/i,
    /Validation error/i,
    /UnauthorizedError/i,
    /celebrate request validation failed/i,
  ],
  dsn: 'https://8b5c84cfef3e22541bc84de0ed00497b@o1098464.ingest.sentry.io/6122819',
  tracesSampleRate: 0.5,
  release: version,
});

Logger.info('✌️ Sentry loaded');
console.log('✌️ Sentry loaded');
