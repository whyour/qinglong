const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_METRIC_SAMPLES,
  metricsService,
} = require('../../back/services/metrics');

test('metrics keep only the newest bounded samples', () => {
  const sampleCount = MAX_METRIC_SAMPLES * 50;
  for (let index = 0; index < sampleCount; index++) {
    metricsService.record('http_request', index, {
      path: `/health/${index}`,
    });
  }

  const result = metricsService.getMetrics('http_request');
  assert.equal(result.count, MAX_METRIC_SAMPLES);
  assert.equal(result.metrics[0].value, sampleCount - MAX_METRIC_SAMPLES);
  assert.equal(result.metrics.at(-1).value, sampleCount - 1);
});

test('empty metric queries return finite aggregates', () => {
  const result = metricsService.getMetrics('missing_metric');
  assert.deepEqual(
    {
      count: result.count,
      average: result.average,
      min: result.min,
      max: result.max,
    },
    { count: 0, average: 0, min: 0, max: 0 },
  );
});
