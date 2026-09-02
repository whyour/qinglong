'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applicationEphemeralFilesystemArguments,
  applicationNetworkArguments,
  consoleSurfaceContract,
  dockerDesktopMetadataRetryable,
  trialTemporaryBaseDirectory,
  trialVolumeArguments,
} = require('../../scripts/ql3-local-alpha-trial-kit-live-contract.cjs');

const DIGEST = 'a'.repeat(64);
const RUN_ID = '019f8680-143d-7000-8000-000000000051';
const ATTEMPT_ID = '019f8680-143d-7000-8000-000000000052';

test('uses the Docker Desktop durable temporary volume on macOS', () => {
  assert.equal(
    trialTemporaryBaseDirectory('darwin', '/private/var/folders/user/T'),
    '/private/tmp',
  );
  assert.equal(
    trialTemporaryBaseDirectory('linux', '/tmp/runner'),
    '/tmp/runner',
  );
});

test('mounts the trial parent so the private deployment root remains a child', () => {
  assert.deepEqual(trialVolumeArguments({ mountRoot: '/tmp/trial-parent' }), [
    '--volume',
    '/tmp/trial-parent:/var/lib',
  ]);
});

test('retries only observed Docker Desktop metadata propagation failures', () => {
  assert.equal(
    dockerDesktopMetadataRetryable(
      '{"code":"LOCAL_OWNER_PEPPER_UNAVAILABLE"}',
      'darwin',
    ),
    true,
  );
  assert.equal(
    dockerDesktopMetadataRetryable(
      '{"code":"LOCAL_OWNER_SECRET_DELIVERY_FAILED"}',
      'darwin',
    ),
    true,
  );
  assert.equal(
    dockerDesktopMetadataRetryable(
      '{"code":"QL3_LOCAL_SETUP_CONFIGURATION_INVALID"}',
      'darwin',
    ),
    true,
  );
  assert.equal(
    dockerDesktopMetadataRetryable(
      '{"code":"LOCAL_OWNER_CONSOLE_CONFIGURATION_INVALID"}',
      'linux',
    ),
    false,
  );
  assert.equal(
    dockerDesktopMetadataRetryable(
      '{"code":"LOCAL_OWNER_CLI_CONFIGURATION_INVALID"}',
      'darwin',
    ),
    false,
  );
});

test('uses a loopback-published relay only for Docker Desktop Console trials', () => {
  assert.deepEqual(applicationNetworkArguments('console', 'darwin'), [
    '--network',
    'bridge',
    '--publish',
    '127.0.0.1:5700:5701',
  ]);
  assert.deepEqual(applicationNetworkArguments('console', 'linux'), [
    '--network',
    'host',
  ]);
  assert.deepEqual(applicationNetworkArguments('headless', 'darwin'), [
    '--network',
    'none',
  ]);
});

test('uses bounded native filesystems for Darwin trial receipts and artifacts', () => {
  assert.deepEqual(
    applicationEphemeralFilesystemArguments({ uid: 501, gid: 20 }, 'darwin'),
    [
      '--tmpfs',
      '/var/lib/qinglong3/receipts:rw,nosuid,nodev,noexec,size=4m,mode=0700,uid=501,gid=20',
      '--tmpfs',
      '/var/lib/qinglong3/artifacts:rw,nosuid,nodev,noexec,size=80m,mode=0700,uid=501,gid=20',
    ],
  );
  assert.deepEqual(
    applicationEphemeralFilesystemArguments({ uid: 1000, gid: 1000 }, 'linux'),
    [],
  );
});

function surfaceResponse(status) {
  return {
    status,
    body: { cancel: async () => {} },
  };
}

function fixture(startStatus, firstLogStatus = 'pending') {
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
          if (logReads === 1 && firstLogStatus === 'unavailable') {
            return { status: 503, body: { code: 'artifact_unavailable' } };
          }
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

test('bounds Docker Desktop artifact propagation as a pending log state', async () => {
  const { adapters } = fixture('accepted', 'unavailable');
  adapters.platform = 'darwin';
  const result = await consoleSurfaceContract({}, adapters);
  assert.equal(result.firstAutomation.logMarkerObserved, true);
});

test('keeps artifact unavailable terminal on Linux', async () => {
  const { adapters } = fixture('accepted', 'unavailable');
  adapters.platform = 'linux';
  await assert.rejects(
    consoleSurfaceContract({}, adapters),
    /starter Run log became unavailable: status=503, code=artifact_unavailable/,
  );
});

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
