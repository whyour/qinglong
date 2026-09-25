const test = require('node:test');
const assert = require('node:assert/strict');
const { request, authenticate } = require('../../dist/remote/api/client');

test('API diagnostics preserve resource scope, uncertainty, codes and secret suppression in both languages', async (t) => {
  const previous = process.env.QL_LANG;
  t.after(() => {
    if (previous === undefined) delete process.env.QL_LANG;
    else process.env.QL_LANG = previous;
  });
  let response;
  let calls = 0;
  t.mock.method(global, 'fetch', async () => {
    calls++;
    if (response instanceof Error) throw response;
    return response;
  });
  const config = {
    url: 'https://fixture.invalid',
    clientId: 'secret-id',
    clientSecret: 'secret-value',
    token: 'secret-token',
  };
  for (const language of ['zh', 'en']) {
    process.env.QL_LANG = language;
    for (const [endpoint, resource] of [
      ['crons/run', language === 'en' ? 'task' : '任务'],
      ['subscriptions/run', language === 'en' ? 'subscription' : '订阅'],
    ]) {
      for (const failure of ['permission', 'unavailable', 'network', 'api']) {
        response =
          failure === 'permission'
            ? new Response('secret-value', { status: 403 })
            : failure === 'unavailable'
            ? new Response('secret-value', { status: 503 })
            : failure === 'network'
            ? new Error('secret-value')
            : new Response(
                JSON.stringify({ code: 401, message: 'secret-value' }),
              );
        const before = calls;
        await assert.rejects(
          request(config, endpoint, { method: 'PUT', body: [1] }),
          (error) => {
            assert.equal(
              error.exitCode,
              ['permission', 'api'].includes(failure) ? 3 : 1,
            );
            assert.doesNotMatch(error.message, /secret-|fixture\.invalid/);
            if (failure === 'unavailable' || failure === 'network') {
              assert.ok(error.message.includes(resource));
              assert.match(
                error.message,
                language === 'en' ? /outcome.*unknown/ : /结果.*未知/,
              );
            }
            if (failure !== 'network') {
              assert.ok(
                error.message.includes(
                  endpoint.startsWith('subscriptions')
                    ? 'subscriptions'
                    : 'crons',
                ),
              );
              assert.match(
                error.message,
                language === 'en' ? /permission/ : /权限/,
              );
            }
            return true;
          },
        );
        assert.equal(
          calls - before,
          1,
          'diagnostics must not replay the mutation',
        );
      }
    }
    response = new Response(
      JSON.stringify({
        code: 200,
        data: { token: 'secret-token', expiration: 0 },
      }),
    );
    await assert.rejects(
      authenticate(config),
      language === 'en' ? /Invalid authentication response/ : /认证响应无效/,
    );
  }
});
