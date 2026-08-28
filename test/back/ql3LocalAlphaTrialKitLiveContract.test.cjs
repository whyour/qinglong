'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  consoleSurfaceContract,
} = require('../../scripts/ql3-local-alpha-trial-kit-live-contract.cjs');

const DIGEST = 'a'.repeat(64);
const RUN_ID = '019f8680-143d-7000-8000-000000000051';
const ATTEMPT_ID = '019f8680-143d-7000-8000-000000000052';

function surfaceResponse(status) {
  return {
    status,
    body: { cancel: async () => {} },
  };
}

function fixture(startStatus) {
  let runReads = 0;
  let logReads = 0;
  const calls = [];
  return {
    calls,
    adapters: {
      async fetch(pathname) {
        return surfaceResponse(pathname.endsWith('/tasks') ? 401 : 200);
      },
      credentialToken() {
        return 'private-owner-token';
      },
      async delay() {},
      async apiRequest(pathname, token, options = {}) {
        calls.push({ pathname, token, method: options.method ?? 'GET' });
        if (pathname.endsWith('/tasks/alpha-first-automation')) {
          return {
            status: 200,
            body: { task: { revision: 1, contentDigest: DIGEST } },
          };
        }
        if (pathname.endsWith('/tasks/alpha-first-automation/runs')) {
          return {
            status: startStatus === 'accepted' ? 202 : 200,
            body: { status: startStatus, runId: RUN_ID, attemptId: ATTEMPT_ID },
          };
        }
        if (pathname.endsWith(`/runs/${RUN_ID}`)) {
          runReads += 1;
          return {
            status: 200,
            body: { run: { status: runReads === 1 ? 'running' : 'succeeded' } },
          };
        }
        if (pathname.includes('/log?')) {
          logReads += 1;
          return logReads === 1
            ? { status: 202, body: { status: 'pending' } }
            : {
                status: 200,
                body: {
                  status: 'available',
                  content: Buffer.from(
                    'qinglong3-alpha-first-automation\n',
                  ).toString('base64'),
                },
              };
        }
        throw new Error(`unexpected request ${pathname}`);
      },
    },
  };
}

for (const startStatus of ['accepted', 'existing']) {
  test(`proves one ${startStatus} fenced Run after the log becomes available`, async () => {
    const { adapters, calls } = fixture(startStatus);
    const result = await consoleSurfaceContract({}, adapters);
    assert.deepEqual(result, {
      listener: '127.0.0.1:5700',
      rootStatus: 200,
      unauthenticatedApiStatus: 401,
      firstAutomation: {
        taskId: 'alpha-first-automation',
        runStatus: 'succeeded',
        logMarkerObserved: true,
      },
    });
    assert.equal(
      calls.filter(({ pathname }) => pathname.includes('/log?')).length,
      2,
    );
  });
}

test('preserves a rejected start status, code and reason for diagnosis', async () => {
  const { adapters } = fixture('rejected');
  adapters.apiRequest = async (pathname) => {
    if (pathname.endsWith('/tasks/alpha-first-automation')) {
      return {
        status: 200,
        body: { task: { revision: 1, contentDigest: DIGEST } },
      };
    }
    return {
      status: 409,
      body: {
        code: 'task_start_fence_rejected',
        reason: 'definition_changed',
      },
    };
  };
  await assert.rejects(
    consoleSurfaceContract({}, adapters),
    /status=409, code=task_start_fence_rejected, reason=definition_changed/,
  );
});
