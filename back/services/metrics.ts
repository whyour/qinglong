import { performance } from 'perf_hooks';
import Logger from '../loaders/logger';

interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

export const MAX_METRIC_SAMPLES = 1000;
const METRIC_RETENTION_MS = 60 * 60 * 1000;

export class MetricsService {
  private metrics: Array<Metric | undefined> = new Array(MAX_METRIC_SAMPLES);
  private metricCount = 0;
  private nextMetricIndex = 0;
  private static instance: MetricsService;

  private constructor() {
    // 定期清理旧数据
    const cleanupTimer = setInterval(() => this.removeExpiredMetrics(), 60000);
    cleanupTimer.unref();
  }

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  record(name: string, value: number, tags?: Record<string, string>) {
    this.metrics[this.nextMetricIndex] = {
      name,
      value,
      timestamp: Date.now(),
      tags,
    };
    this.nextMetricIndex = (this.nextMetricIndex + 1) % MAX_METRIC_SAMPLES;
    this.metricCount = Math.min(this.metricCount + 1, MAX_METRIC_SAMPLES);
  }

  measure(name: string, fn: () => void, tags?: Record<string, string>) {
    const start = performance.now();
    try {
      fn();
    } finally {
      const duration = performance.now() - start;
      this.record(name, duration, tags);
    }
  }

  async measureAsync(
    name: string,
    fn: () => Promise<void>,
    tags?: Record<string, string>,
  ) {
    const start = performance.now();
    try {
      await fn();
    } finally {
      const duration = performance.now() - start;
      this.record(name, duration, tags);
    }
  }

  getMetrics(name?: string, tags?: Record<string, string>) {
    this.removeExpiredMetrics();
    let filtered = this.getMetricSnapshot();

    if (name) {
      filtered = filtered.filter((m) => m.name === name);
    }

    if (tags) {
      filtered = filtered.filter((m) => {
        if (!m.tags) return false;
        return Object.entries(tags).every(
          ([key, value]) => m.tags![key] === value,
        );
      });
    }

    const values = filtered.map((metric) => metric.value);
    return {
      count: filtered.length,
      average: values.length
        ? values.reduce((acc, value) => acc + value, 0) / values.length
        : 0,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      metrics: filtered,
    };
  }

  private getMetricSnapshot(): Metric[] {
    if (this.metricCount < MAX_METRIC_SAMPLES) {
      return this.metrics.slice(0, this.metricCount) as Metric[];
    }
    return [
      ...this.metrics.slice(this.nextMetricIndex),
      ...this.metrics.slice(0, this.nextMetricIndex),
    ] as Metric[];
  }

  private removeExpiredMetrics() {
    const oldestTimestamp = Date.now() - METRIC_RETENTION_MS;
    const retained = this.getMetricSnapshot().filter(
      (metric) => metric.timestamp > oldestTimestamp,
    );
    if (retained.length === this.metricCount) return;

    this.metrics = new Array(MAX_METRIC_SAMPLES);
    this.metricCount = 0;
    this.nextMetricIndex = 0;
    for (const metric of retained) {
      this.metrics[this.nextMetricIndex] = metric;
      this.nextMetricIndex = (this.nextMetricIndex + 1) % MAX_METRIC_SAMPLES;
      this.metricCount++;
    }
  }

  report() {
    const report = {
      timestamp: Date.now(),
      metrics: this.getMetrics(),
    };
    Logger.info('性能指标报告:', report);
    return report;
  }
}

export const metricsService = MetricsService.getInstance();
