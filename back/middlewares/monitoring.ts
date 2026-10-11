import { Request, Response, NextFunction } from 'express';
import Logger from '../loaders/logger';
import { performance } from 'perf_hooks';
import { metricsService } from '../services/metrics';

const UNMONITORED_PATH_SUFFIXES = ['/api/health', '/open/health'];
const HTTP_METRIC_SAMPLE_INTERVAL = 10;
let requestSampleOffset = 0;

export const monitoringMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (UNMONITORED_PATH_SUFFIXES.some((path) => req.path.endsWith(path))) {
    return next();
  }

  const start = performance.now();
  const originalEnd = res.end;

  res.end = function (chunk?: any, encoding?: any, cb?: any) {
    const duration = performance.now() - start;
    const shouldSample = requestSampleOffset === 0;
    requestSampleOffset =
      (requestSampleOffset + 1) % HTTP_METRIC_SAMPLE_INTERVAL;
    if (shouldSample) {
      metricsService.record('http_request', duration, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode.toString(),
        ...(req.platform && { platform: req.platform }),
      });
    }

    if (duration > 1000) {
      Logger.warn(
        `Slow request detected: ${req.method} ${
          req.path
        } took ${duration.toFixed(2)}ms`,
      );
    }

    return originalEnd.call(this, chunk, encoding, cb);
  };

  next();
};
