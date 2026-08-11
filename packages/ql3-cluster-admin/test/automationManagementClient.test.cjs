const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createServer } = require('node:https');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { afterEach, test } = require('node:test');

const {
  executeClusterAutomationManagementClient,
  validateClusterAutomationManagementClientResult,
} = require('@qinglong/cluster-admin/automation-management-client');

const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const CLI = resolve(
  __dirname,
  '../dist/automation-management/automationManagementClientCli.js',
);
const temporaryDirectories = [];

const taskCommand = Object.freeze({
  projectId: 'project-a',
  taskId: 'task-a',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Sensitive task name',
  kind: 'script',
  spec: {
    schema: 'qinglong/script@v1',
    config: { source: 'sensitive script body' },
  },
  labels: {},
  enabled: true,
  occurredAtMs: 1_000,
});
const triggerCommand = Object.freeze({
  projectId: 'project-a',
  triggerId: 'trigger-a',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174002',
  taskId: 'task-a',
  taskRevision: 1,
  taskContentDigest: 'a'.repeat(64),
  spec: {
    schema: 'qinglong/cron@v1',
    config: {
      expression: '*/5 * * * *',
      timezone: 'UTC',
      misfirePolicy: 'fire_once',
    },
  },
  enabled: true,
  occurredAtMs: 1_000,
});

function envelope(operation, command) {
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: Object.freeze({
      requestId: `request-${operation}`,
      command,
    }),
  });
}

function taskResult(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'task.publish',
    status: 'created',
    task: {
      projectId: 'project-a',
      taskId: 'task-a',
      revision: 1,
      kind: 'script',
      enabled: true,
      contentDigest: 'b'.repeat(64),
      updatedAtMs: 1_001,
      ...overrides,
    },
  };
}

function triggerResult(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'trigger.publish',
    status: 'created',
    trigger: {
      projectId: 'project-a',
      triggerId: 'trigger-a',
      revision: 1,
      taskId: 'task-a',
      taskRevision: 1,
      taskContentDigest: 'a'.repeat(64),
      enabled: true,
      contentDigest: 'c'.repeat(64),
      updatedAtMs: 1_001,
      ...overrides,
    },
  };
}

function privateWrite(filePath, value) {
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function clientFiles(port, command) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'ql3-automation-client-')),
  );
  temporaryDirectories.push(directory);
  const paths = {
    configFile: join(directory, 'client.json'),
    commandFile: join(directory, 'command.json'),
    assertionFile: join(directory, 'assertion.jwt'),
  };
  const caFile = join(directory, 'ca.crt');
  const clientCertificateFile = join(directory, 'client.crt');
  const clientPrivateKeyFile = join(directory, 'client.key');
  privateWrite(caFile, readFileSync(join(FIXTURES, 'ca-cert.pem')));
  privateWrite(
    clientCertificateFile,
    readFileSync(join(FIXTURES, 'client-cert.pem')),
  );
  privateWrite(
    clientPrivateKeyFile,
    readFileSync(join(FIXTURES, 'client-key.pem')),
  );
  privateWrite(
    paths.configFile,
    `${JSON.stringify({
      schemaVersion: 1,
      endpoint: `https://localhost:${port}/api/v3/automations/management`,
      servername: 'localhost',
      caFile,
      clientCertificateFile,
      clientPrivateKeyFile,
      requestTimeoutMs: 2_000,
    })}\n`,
  );
  privateWrite(paths.commandFile, `${JSON.stringify(command)}\n`);
  privateWrite(
    paths.assertionFile,
    'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
  );
  return paths;
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, 'localhost', () => resolvePromise(server.address()));
  });
}

function close(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validates Task and Trigger low-sensitive results against the request fence', () => {
  const task = validateClusterAutomationManagementClientResult(
    taskResult(),
    envelope('task.publish', taskCommand),
  );
  const trigger = validateClusterAutomationManagementClientResult(
    triggerResult(),
    envelope('trigger.publish', triggerCommand),
  );
  assert.equal(task.task.taskId, 'task-a');
  assert.equal(trigger.trigger.triggerId, 'trigger-a');
  assert.doesNotMatch(
    JSON.stringify([task, trigger]),
    /Sensitive|script body|expression|mutationId|authenticationId/,
  );
  assert.throws(() =>
    validateClusterAutomationManagementClientResult(
      taskResult({ projectId: 'project-b' }),
      envelope('task.publish', taskCommand),
    ),
  );
  assert.throws(() =>
    validateClusterAutomationManagementClientResult(
      { ...triggerResult(), credential: 'must-not-leak' },
      envelope('trigger.publish', triggerCommand),
    ),
  );
});

test('validates bounded inspect/list results, absent state and stable cursors', () => {
  const taskInspectCommand = {
    schemaVersion: 1,
    operation: 'task.inspect',
    request: {
      requestId: 'request-task-inspect',
      auditEventId: '123e4567-e89b-42d3-a456-426614174010',
      projectId: 'project-a',
      taskId: 'task-a',
    },
  };
  const taskInspect = validateClusterAutomationManagementClientResult(
    {
      schemaVersion: 1,
      operation: 'task.inspect',
      status: 'found',
      task: taskResult().task,
    },
    taskInspectCommand,
  );
  assert.equal(taskInspect.task.taskId, 'task-a');
  const triggerInspectCommand = {
    schemaVersion: 1,
    operation: 'trigger.inspect',
    request: {
      requestId: 'request-trigger-inspect',
      auditEventId: '123e4567-e89b-42d3-a456-426614174011',
      projectId: 'project-a',
      triggerId: 'trigger-a',
    },
  };
  const absent = validateClusterAutomationManagementClientResult(
    {
      schemaVersion: 1,
      operation: 'trigger.inspect',
      status: 'absent',
      trigger: null,
    },
    triggerInspectCommand,
  );
  assert.equal(absent.trigger, null);
  const taskListCommand = {
    schemaVersion: 1,
    operation: 'task.list',
    request: {
      requestId: 'request-task-list',
      auditEventId: '123e4567-e89b-42d3-a456-426614174012',
      projectId: 'project-a',
      limit: 1,
      after: { taskId: 'task-0' },
    },
  };
  const taskList = validateClusterAutomationManagementClientResult(
    {
      schemaVersion: 1,
      operation: 'task.list',
      tasks: [taskResult().task],
      truncated: true,
      next: { taskId: 'task-a' },
    },
    taskListCommand,
  );
  assert.equal(taskList.next.taskId, 'task-a');
  assert.throws(() =>
    validateClusterAutomationManagementClientResult(
      {
        schemaVersion: 1,
        operation: 'task.list',
        tasks: [{ ...taskResult().task, spec: { secret: true } }],
        truncated: false,
        next: null,
      },
      taskListCommand,
    ),
  );
  assert.throws(() =>
    validateClusterAutomationManagementClientResult(
      {
        schemaVersion: 1,
        operation: 'task.list',
        tasks: [taskResult().task],
        truncated: true,
        next: { taskId: 'task-b' },
      },
      taskListCommand,
    ),
  );
});

test('sends one mTLS 1.3 automation command and validates its response', async () => {
  let observed;
  const server = createServer(
    {
      key: readFileSync(join(FIXTURES, 'server-key.pem')),
      cert: readFileSync(join(FIXTURES, 'server-cert.pem')),
      ca: readFileSync(join(FIXTURES, 'ca-cert.pem')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.once('end', () => {
        observed = {
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
          authorized: request.socket.authorized,
          protocol: request.socket.getProtocol(),
          command: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        const body = Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            requestId: 'http-request-1',
            result: taskResult(),
          }),
        );
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
        });
        response.end(body);
      });
    },
  );
  const address = await listen(server);
  try {
    const command = envelope('task.publish', taskCommand);
    const result = await executeClusterAutomationManagementClient(
      clientFiles(address.port, command),
    );
    assert.equal(result.requestId, 'http-request-1');
    assert.equal(result.result.task.taskId, 'task-a');
    assert.deepEqual(observed, {
      method: 'POST',
      path: '/api/v3/automations/management',
      authorization:
        'Bearer eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl',
      authorized: true,
      protocol: 'TLSv1.3',
      command,
    });
  } finally {
    await close(server);
  }
});

test('CLI exposes only private file paths and stable low-sensitive errors', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-automation-client /);
  assert.doesNotMatch(help.stdout, /token|secret|command body/i);

  const invalid = spawnSync(process.execPath, [CLI, '--assertion=value'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /USAGE_INVALID/);
  assert.doesNotMatch(invalid.stderr, /assertion=value/);
});
