const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const config = require('../../back/config').default;
const { check } = require('../../back/schedule/health');

function runCheck(service = 'cron') {
  return new Promise((resolve) => {
    check({ request: { service } }, (error, response) => {
      resolve({ error, response });
    });
  });
}

test('schedule health check uses the HTTP health endpoint and system logs', async (t) => {
  const originalBaseUrl = config.baseUrl;
  const originalPort = config.port;
  const originalSystemLogPath = config.systemLogPath;
  const originalContainer = process.env.QL_CONTAINER;

  t.after(() => {
    config.baseUrl = originalBaseUrl;
    config.port = originalPort;
    config.systemLogPath = originalSystemLogPath;
    if (originalContainer === undefined) {
      delete process.env.QL_CONTAINER;
    } else {
      process.env.QL_CONTAINER = originalContainer;
    }
  });

  await t.test(
    'returns serving for a healthy prefixed HTTP service',
    async () => {
      let requestedUrl = '';
      const server = http.createServer((request, response) => {
        requestedUrl = request.url;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ code: 200, data: { status: 'ok' } }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));

      config.baseUrl = '/ql';
      config.port = server.address().port;

      const result = await runCheck();
      assert.equal(result.error, null);
      assert.deepEqual(result.response, { status: 1 });
      assert.equal(requestedUrl, '/ql/api/health');
    },
  );

  await t.test(
    'reports recent system logs when HTTP startup fails',
    async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-health-'));
      t.after(() => fs.rm(logDir, { recursive: true, force: true }));
      const lines = Array.from(
        { length: 305 },
        (_, index) => `line-${index + 1}`,
      );
      await fs.writeFile(path.join(logDir, '2026-08-16.log'), 'older-log');
      await fs.writeFile(path.join(logDir, '2026-08-17.log'), lines.join('\n'));
      config.systemLogPath = logDir;
      config.port = 1;
      process.env.QL_CONTAINER = 'true';

      const result = await runCheck();
      assert.equal(result.response, undefined);
      assert.match(result.error.message, /ECONNREFUSED|connect/);
      assert.match(
        result.error.message,
        /http:\/\/localhost:1\/ql\/api\/health/,
      );
      assert.match(result.error.message, /docker logs <container>/);
      assert.match(result.error.message, /line-305/);
      assert.doesNotMatch(result.error.message, /line-1\n/);
      assert.doesNotMatch(result.error.message, /qinglong-error\.log/);
    },
  );
});
