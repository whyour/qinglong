const assert = require('node:assert/strict');
const test = require('node:test');

const { monitoringMiddleware } = require('../../back/middlewares/monitoring');
const { metricsService } = require('../../back/services/metrics');

function createResponse() {
  return {
    statusCode: 200,
    ended: false,
    end() {
      this.ended = true;
    },
  };
}

test('health probes bypass request metric retention with or without base URL', () => {
  const before = metricsService.getMetrics('http_request', {
    path: '/api/health',
  }).count;
  let nextCalled = false;

  for (const path of ['/api/health', '/ql/api/health']) {
    const response = createResponse();
    monitoringMiddleware({ method: 'GET', path }, response, () => {
      nextCalled = true;
    });
    response.end();
    assert.equal(response.ended, true);
  }

  const after = metricsService.getMetrics('http_request', {
    path: '/api/health',
  }).count;
  assert.equal(nextCalled, true);
  assert.equal(after, before);
});

test('non-health requests keep bounded service metrics', () => {
  const path = '/api/monitoring-test';
  const before = metricsService.getMetrics('http_request', { path }).count;
  const response = createResponse();

  monitoringMiddleware(
    { method: 'GET', path, platform: 'desktop' },
    response,
    () => {},
  );
  response.end();

  const after = metricsService.getMetrics('http_request', { path }).count;
  assert.equal(response.ended, true);
  assert.equal(after, before + 1);
});

test('ordinary request metrics are sampled instead of retained per request', () => {
  const path = '/api/monitoring-sampling-test';
  const before = metricsService.getMetrics('http_request', { path }).count;

  for (let index = 0; index < 30; index += 1) {
    const response = createResponse();
    monitoringMiddleware(
      { method: 'GET', path, platform: 'desktop' },
      response,
      () => {},
    );
    response.end();
  }

  const recorded =
    metricsService.getMetrics('http_request', { path }).count - before;
  assert.ok(recorded >= 2 && recorded <= 3);
});
