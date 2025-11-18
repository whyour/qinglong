import { performance } from 'perf_hooks';
import Logger from '../loaders/logger';

interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

class MetricsService {
  private metrics: Metric[] = [];
  private static instance: MetricsService;

  private constructor() {
    // 定期清理旧数据
    setInterval(() => {
      const oneHourAgo = Date.now() - 3600000;
      this.metrics = this.metrics.filter(m => m.timestamp > oneHourAgo);
    }, 60000);
  }

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  record(name: string, value: number, tags?: Record<string, string>) {
    this.metrics.push({
      name,
      value,
      timestamp: Date.now(),
      tags,
    });
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

  async measureAsync(name: string, fn: () => Promise<void>, tags?: Record<string, string>) {
    const start = performance.now();
    try {
      await fn();
    } finally {
      const duration = performance.now() - start;
      this.record(name, duration, tags);
    }
  }

  getMetrics(name?: string, tags?: Record<string, string>) {
    let filtered = this.metrics;
    
    if (name) {
      filtered = filtered.filter(m => m.name === name);
    }
    
    if (tags) {
      filtered = filtered.filter(m => {
        if (!m.tags) return false;
        return Object.entries(tags).every(([key, value]) => m.tags![key] === value);
      });
    }

    return {
      count: filtered.length,
      average: filtered.reduce((acc, curr) => acc + curr.value, 0) / filtered.length,
      min: Math.min(...filtered.map(m => m.value)),
      max: Math.max(...filtered.map(m => m.value)),
      metrics: filtered,
    };
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