import { Request, Response, NextFunction } from 'express';
import Logger from '../loaders/logger';
import { performance } from 'perf_hooks';
import { metricsService } from '../services/metrics';

interface RequestMetrics {
  method: string;
  path: string;
  duration: number;
  statusCode: number;
  timestamp: number;
  platform?: string;
}

const requestMetrics: RequestMetrics[] = [];

export const monitoringMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = performance.now();
  const originalEnd = res.end;

  res.end = function (chunk?: any, encoding?: any, cb?: any) {
    const duration = performance.now() - start;
    const metric: RequestMetrics = {
      method: req.method,
      path: req.path,
      duration,
      statusCode: res.statusCode,
      timestamp: Date.now(),
      platform: req.platform,
    };

    requestMetrics.push(metric);
    metricsService.record('http_request', duration, {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode.toString(),
      ...(req.platform && { platform: req.platform }),
    });

    if (requestMetrics.length > 1000) {
      requestMetrics.shift();
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

export const getMetrics = () => {
  return {
    totalRequests: requestMetrics.length,
    averageDuration:
      requestMetrics.reduce((acc, curr) => acc + curr.duration, 0) /
      requestMetrics.length,
    requestsByMethod: requestMetrics.reduce((acc, curr) => {
      acc[curr.method] = (acc[curr.method] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    requestsByPlatform: requestMetrics.reduce((acc, curr) => {
      if (curr.platform) {
        acc[curr.platform] = (acc[curr.platform] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>),
    recentRequests: requestMetrics.slice(-10),
  };
};
