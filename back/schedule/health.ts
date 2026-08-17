import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import fs from 'fs/promises';
import path from 'path';
import { request } from 'undici';
import { HealthCheckRequest, HealthCheckResponse } from '../protos/health';
import config from '../config';

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const detailedError = error as Error & {
    cause?: unknown;
    code?: string;
    errors?: unknown[];
  };
  const details = [error.message, detailedError.code];
  if (Array.isArray(detailedError.errors)) {
    details.push(...detailedError.errors.map(formatError));
  } else if (detailedError.cause) {
    details.push(formatError(detailedError.cause));
  }

  return [...new Set(details.filter(Boolean))].join(': ') || error.name;
}

async function getRecentSystemLog(lineLimit = 300): Promise<string> {
  try {
    const entries = await fs.readdir(config.systemLogPath);
    const latestLog = entries
      .filter((entry) => entry.endsWith('.log'))
      .sort()
      .at(-1);
    if (!latestLog) {
      return `No system log found in ${config.systemLogPath}`;
    }
    const content = await fs.readFile(
      path.join(config.systemLogPath, latestLog),
      'utf8',
    );
    return content.split('\n').slice(-lineLimit).join('\n').trim();
  } catch (error) {
    return `Unable to read system log from ${config.systemLogPath}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

const check = async (
  call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
  callback: sendUnaryData<HealthCheckResponse>,
) => {
  switch (call.request.service) {
    case 'cron': {
      const healthUrl = `http://localhost:${config.port}${
        config.baseUrl || ''
      }/api/health`;
      let failure = '';
      try {
        const response = await request(healthUrl, {
          method: 'GET',
          headersTimeout: 5000,
          bodyTimeout: 5000,
        });
        const body = (await response.body.json()) as {
          code?: number;
          data?: { status?: string };
        };
        if (
          response.statusCode >= 200 &&
          response.statusCode < 300 &&
          body.code === 200 &&
          body.data?.status === 'ok'
        ) {
          return callback(null, { status: 1 });
        }
        failure = `HTTP ${response.statusCode}: ${JSON.stringify(body)}`;
      } catch (error) {
        failure = formatError(error);
      }

      const systemLog = await getRecentSystemLog();
      const containerHint =
        process.env.QL_CONTAINER === 'true'
          ? 'PM2 file logging is disabled in containers. Check `docker logs <container>` for early startup errors.'
          : 'Check `pm2 logs qinglong --lines 300` for early startup errors.';
      return callback(
        new Error(
          [
            `HTTP health check failed: ${healthUrl}`,
            failure,
            containerHint,
            `Recent system log (${config.systemLogPath}):`,
            systemLog,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    }

    default:
      return callback(null, { status: 1 });
  }
};

export { check };
