#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { loadPanelClient } = require('./ql3-panel-run-control-live-client.cjs');

const TIMEOUT_MS = 45_000;

function fail(message) {
  throw new Error(
    `QingLong Local API cancellation scenario failed: ${message}`,
  );
}

function options(argv) {
  if (argv.length !== 3)
    fail('usage: artifact-root evidence-root edge|standalone');
  const [artifactRoot, evidenceRoot, profile] = argv;
  for (const [value, label] of [
    [artifactRoot, 'artifact root'],
    [evidenceRoot, 'evidence root'],
  ]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) {
      fail(`${label} must be absolute and normalized`);
    }
  }
  if (!['edge', 'standalone'].includes(profile)) fail('profile is invalid');
  return Object.freeze({ artifactRoot, evidenceRoot, profile });
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail(`private directory is invalid: ${directory}`);
  }
}

function privateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function procStartTicks(pid) {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
  const ticks = fields[21];
  if (!/^[1-9][0-9]*$/.test(ticks ?? ''))
    fail('process start ticks are invalid');
  return ticks;
}

function sameProcessExists(pid, startTicks) {
  try {
    return procStartTicks(pid) === startTicks;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return false;
    throw error;
  }
}

function rssBytes(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (!match) fail('process RSS is unavailable');
  return Number(match[1]) * 1024;
}

function request(port, token, requestPath, values = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: values.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          connection: 'close',
          ...(values.headers ?? {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              statusCode: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.once('error', reject);
    if (values.body !== undefined) outgoing.write(values.body);
    outgoing.end();
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === 'string') {
          reject(new Error('dynamic loopback port is unavailable'));
        } else resolve(address.port);
      });
    });
  });
}

async function waitFor(probe, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`${label} did not converge${lastError ? `: ${lastError.message}` : ''}`);
}

function query(databasePath, sql, ...parameters) {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 100,
  });
  try {
    return database.prepare(sql).get(...parameters);
  } finally {
    database.close();
  }
}

function insertTaskAndIdentity(
  modules,
  databasePath,
  pepperKeyId,
  pepper,
  now,
) {
  const {
    apiCredentialSecretDigest,
    createBuiltInTaskSpecSemanticRegistry,
    createTaskDefinitionRecord,
    compileLocalCommandTaskDefinition,
    formatApiCredentialToken,
  } = modules;
  const credentialId = 'local-live-operator';
  const subjectId = 'local-live-user';
  const secret = crypto.randomBytes(32).toString('base64url');
  const taskSemantics = createBuiltInTaskSpecSemanticRegistry();
  const taskCommand = {
    projectId: 'default',
    taskId: 'live-cancellation-task',
    expectedRevision: null,
    mutationId: '019f8700-0000-7000-8000-000000000001',
    name: 'Local API cancellation live task',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/bin/sh',
          args: [
            '-c',
            'trap "exit 0" TERM INT; printf "qinglong3-panel-live-log\\n"; while :; do sleep 1; done',
          ],
        },
      },
    },
    labels: {},
    enabled: true,
    occurredAtMs: now,
  };
  const definition = createTaskDefinitionRecord(
    {
      ...taskCommand,
      spec: taskSemantics.normalize({
        projectId: taskCommand.projectId,
        taskId: taskCommand.taskId,
        kind: taskCommand.kind,
        spec: taskCommand.spec,
      }),
    },
    now,
  );
  const execution = compileLocalCommandTaskDefinition(
    definition,
    taskSemantics,
  );
  const database = new DatabaseSync(databasePath, { timeout: 100 });
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
         "subject_type", "subject_id", "status", "version",
         "created_at_ms", "updated_at_ms"
       ) VALUES ('user', ?, 'active', 1, ?, ?)`,
      )
      .run(subjectId, now, now);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
         "credential_id", "version", "state", "subject_type", "subject_id",
         "secret_digest", "created_at_ms", "not_before_at_ms", "expires_at_ms"
       ) VALUES (?, 1, 'active', 'user', ?, ?, ?, ?, ?)`,
      )
      .run(
        credentialId,
        subjectId,
        apiCredentialSecretDigest(pepper, credentialId, secret),
        now,
        now,
        now + 3_600_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
         "credential_id", "credential_version", "pepper_key_id"
       ) VALUES (?, 1, ?)`,
      )
      .run(credentialId, pepperKeyId);
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES ('default', 'user', ?, 1, 'active', 'operator', ?, 'system',
                 'local-live-gate', ?)`,
      )
      .run(subjectId, 'local-live-role-binding', now);
    database
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitions" (
         "project_id", "task_id", "current_revision", "created_at_ms",
         "updated_at_ms"
       ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        definition.projectId,
        definition.taskId,
        definition.revision,
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
         "project_id", "task_id", "revision", "mutation_id", "name",
         "description", "kind", "spec_json", "labels_json", "enabled",
         "content_digest", "created_at_ms"
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        definition.projectId,
        definition.taskId,
        definition.revision,
        definition.mutationId,
        definition.name,
        definition.kind,
        JSON.stringify(definition.spec),
        JSON.stringify(definition.labels),
        definition.contentDigest,
        now,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalExecutionContextRecipes" (
         "context_ref", "environment_json", "content_digest", "created_at_ms"
       ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        execution.contextRecipe.contextRef,
        JSON.stringify(execution.contextRecipe.environment),
        execution.contextRecipe.contentDigest,
        execution.contextRecipe.createdAtMs,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalTaskExecutionRevisions" (
         "project_id", "task_id", "task_revision", "executor_type",
         "command_json", "working_directory", "timeout_ms", "context_ref",
         "content_digest", "created_at_ms"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.executionRevision.projectId,
        execution.executionRevision.taskId,
        execution.executionRevision.taskRevision,
        execution.executionRevision.executorType,
        JSON.stringify(execution.executionRevision.command),
        execution.executionRevision.workingDirectory ?? null,
        execution.executionRevision.timeoutMs ?? null,
        execution.executionRevision.contextRef,
        execution.executionRevision.contentDigest,
        execution.executionRevision.createdAtMs,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  return Object.freeze({
    definition,
    token: formatApiCredentialToken(credentialId, secret),
  });
}

function startApi(executable, configPath) {
  const child = spawn(process.execPath, [executable, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  const events = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const index = stdout.indexOf('\n');
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return Object.freeze({ child, events, exit, stderr: () => stderr });
}

async function stopApi(active) {
  active.child.kill('SIGTERM');
  const outcome = await Promise.race([
    active.exit,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('API stop timeout')), 30_000),
    ),
  ]);
  if (outcome.code !== 0 || outcome.signal !== null) {
    fail(
      `API process did not stop cleanly: ${JSON.stringify({
        ...outcome,
        stderr: active.stderr(),
      })}`,
    );
  }
  return outcome;
}

async function main(argv = process.argv.slice(2)) {
  const value = options(argv);
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/stat')) {
    fail('a real Linux /proc runtime is required');
  }
  privateDirectory(value.evidenceRoot);
  const deploymentRoot = path.join(value.evidenceRoot, 'deployment');
  for (const directory of [
    deploymentRoot,
    path.join(deploymentRoot, 'owner-peppers'),
    path.join(deploymentRoot, 'receipts'),
    path.join(deploymentRoot, 'artifacts'),
    path.join(deploymentRoot, 'plugin-staging'),
    path.join(deploymentRoot, 'plugin-activation'),
  ])
    privateDirectory(directory);

  const artifactRequire = createRequire(
    path.join(value.artifactRoot, 'package.json'),
  );
  const { migrateLocalSqlitePath } = artifactRequire(
    '@qinglong/local-sqlite/migration',
  );
  const { LocalOwnerPepperKeyringFileProvider, provisionLocalOwnerPepperKey } =
    artifactRequire('@qinglong/local-owner-console/pepper-custody');
  const { provisionLocalSecretKeyring } = artifactRequire(
    '@qinglong/local-secret',
  );
  const tokenModule = artifactRequire(
    '@qinglong/runtime-core/api-credential-token',
  );
  const definitionModule = artifactRequire(
    '@qinglong/runtime-core/task-definition',
  );
  const compilerModule = artifactRequire(
    '@qinglong/runtime-core/task-definition-execution-compiler',
  );
  const semanticModule = artifactRequire(
    '@qinglong/runtime-core/task-spec-semantic',
  );
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const pepperKeyId = 'owner-v1';
  const now = Date.now();
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: path.join(deploymentRoot, 'owner-peppers'),
    pepperKeyId,
  });
  await migrateLocalSqlitePath({ databasePath, profile: value.profile });
  await provisionLocalSecretKeyring(
    path.join(deploymentRoot, 'local-secret-keyring.json'),
  );
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
         "pepper_key_id", "material_digest", "backup_digest", "state",
         "version", "register_mutation_id", "activate_mutation_id",
         "registered_at_ms", "activated_at_ms"
       ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        pepperKeyId,
        pepperSummary.digest,
        'b'.repeat(64),
        '019f8700-0000-4000-8000-000000000002',
        '019f8700-0000-4000-8000-000000000003',
        now,
        now,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
         "generation", "mutation_id", "expected_generation",
         "previous_pepper_key_id", "active_pepper_key_id", "material_digest",
         "backup_digest", "activated_at_ms"
       ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '019f8700-0000-4000-8000-000000000003',
        pepperKeyId,
        pepperSummary.digest,
        'b'.repeat(64),
        now,
      );
  } finally {
    database.close();
  }
  const pepper = new LocalOwnerPepperKeyringFileProvider(
    path.join(deploymentRoot, 'owner-peppers'),
  ).resolve(pepperKeyId).pepper;
  const seeded = insertTaskAndIdentity(
    {
      ...tokenModule,
      ...definitionModule,
      ...compilerModule,
      ...semanticModule,
    },
    databasePath,
    pepperKeyId,
    pepper,
    now,
  );
  const port = await reservePort();
  const applicationConfigPath = path.join(
    deploymentRoot,
    'local-application.json',
  );
  const apiConfigPath = path.join(deploymentRoot, 'local-api.json');
  privateJson(applicationConfigPath, {
    schema: 'qinglong/local-application-process@v2',
    instanceId: `local-api-cancellation-${value.profile}`,
    profile: value.profile,
    storage: { mode: 'fresh', databasePath, busyTimeoutMs: 100 },
    runtime: {
      receiptRoot: path.join(deploymentRoot, 'receipts'),
      artifactRoot: path.join(deploymentRoot, 'artifacts'),
      secretKeyringPath: path.join(deploymentRoot, 'local-secret-keyring.json'),
    },
    pluginPackages: {
      stagingRoot: path.join(deploymentRoot, 'plugin-staging'),
      activationRoot: path.join(deploymentRoot, 'plugin-activation'),
      recoverySource: { mode: 'disabled' },
      pageSize: value.profile === 'edge' ? 4 : 16,
      maxPages: 1,
      taskPublicationPageSize: value.profile === 'edge' ? 4 : 16,
      taskPublicationMaxPages: 1,
    },
    ai: { deployment: 'excluded' },
  });
  privateJson(apiConfigPath, {
    schema: 'qinglong/local-api-process@v1',
    deploymentRoot,
    applicationConfigFilePath: applicationConfigPath,
    ownerPepperKeyringDirectory: path.join(deploymentRoot, 'owner-peppers'),
    listener: { host: '127.0.0.1', port },
  });
  const executable = path.join(
    value.artifactRoot,
    'node_modules/@qinglong/local-api/dist/cli.js',
  );
  let active = startApi(executable, apiConfigPath);
  try {
    await waitFor(
      () => active.events.some((event) => event.event === 'listening'),
      'Local API listener',
    );
    const unauthorized = await request(
      port,
      '',
      '/api/v3/projects/default/tasks/live-cancellation-task',
    );
    assert.equal(unauthorized.statusCode, 401);
    const panel = loadPanelClient(
      path.join(value.evidenceRoot, 'panel-client'),
      port,
    );
    const capabilities = await panel.auth.discoverQingLong3(
      '/api/v3/capabilities',
    );
    assert.equal(capabilities?.panel.runControl, 'task_run_v1');
    assert.equal(panel.auth.setQingLong3Credential(seeded.token), true);
    const client = panel.control.createPanelRunControl(
      {
        ql3: {
          projectId: 'default',
          taskId: 'live-cancellation-task',
        },
      },
      capabilities,
    );
    const task = await client.readTask();
    assert.equal(task.revision, seeded.definition.revision);
    assert.equal(task.contentDigest, seeded.definition.contentDigest);
    const start = client.prepareStart(task);
    assert.equal(panel.requests.filter((r) => r.method === 'POST').length, 0);
    const started = await start.execute();
    assert.equal(started.status, 'accepted');
    const running = await waitFor(() => {
      const row = query(
        databasePath,
        `SELECT run.status, attempt.status AS attemptStatus, attempt.pid
           FROM Runs AS run JOIN RunAttempts AS attempt ON attempt.run_id = run.id
          WHERE run.id = ?`,
        started.runId,
      );
      return row?.status === 'running' &&
        row?.attemptStatus === 'running' &&
        row?.pid
        ? row
        : null;
    }, 'task process start');
    const taskPid = Number(running.pid);
    const taskStartTicks = procStartTicks(taskPid);
    const apiRssBytes = rssBytes(active.child.pid);
    const page = await client.listRuns();
    assert.equal(page.scanned, 1);
    assert.equal(page.runs[0]?.id, started.runId);
    let selected;
    await waitFor(async () => {
      selected = await client.readRun(started.runId);
      return (await client.readLog(selected)).includes(
        'qinglong3-panel-live-log',
      );
    }, 'panel reads running process log marker');
    assert.equal(selected.status, 'running');
    const cancellation = client.prepareCancel(selected);
    panel.loseNextCancellationResponse();
    await assert.rejects(
      cancellation.execute(),
      (error) => error.uncertain === true,
    );
    const replay = await cancellation.execute();
    assert.equal(replay.status, 'already_requested');
    assert.equal(replay.runId, started.runId);
    const cancelRequests = panel.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/cancellation'),
    );
    assert.equal(cancelRequests.length, 2);
    assert.equal(cancelRequests[0].body, cancelRequests[1].body);
    assert.equal(cancelRequests[0].path, cancelRequests[1].path);
    const terminal = await waitFor(() => {
      const row = query(
        databasePath,
        `SELECT run.status, attempt.status AS attemptStatus
           FROM Runs AS run JOIN RunAttempts AS attempt ON attempt.run_id = run.id
          WHERE run.id = ?`,
        started.runId,
      );
      return row?.status === 'cancelled' && row?.attemptStatus === 'cancelled'
        ? row
        : null;
    }, 'durable cancellation');
    await waitFor(
      () => !sameProcessExists(taskPid, taskStartTicks),
      'task process identity exit',
    );
    await waitFor(async () => {
      const current = await client.readRun(started.runId);
      return (await client.readLog(current)).includes(
        'qinglong3-panel-live-log',
      );
    }, 'panel reads actual task log marker');
    await stopApi(active);
    active = startApi(executable, apiConfigPath);
    await waitFor(
      () => active.events.some((event) => event.event === 'listening'),
      'restarted Local API listener',
    );
    const observed = await client.readRun(started.runId);
    assert.equal(observed.status, 'cancelled');
    assert.ok(
      (await client.readLog(observed)).includes('qinglong3-panel-live-log'),
    );
    client.dispose();
    panel.auth.clearQingLong3Credential();
    await stopApi(active);
    const facts = query(
      databasePath,
      `SELECT
         (SELECT COUNT(*) FROM RunEvents WHERE run_id = ? AND type = 'run.cancel_requested') AS cancelEvents,
         (SELECT COUNT(*) FROM RunEvents WHERE run_id = ? AND type = 'run.cancelled') AS cancelledEvents,
         (SELECT COUNT(*) FROM QingLong3SecurityAuditEvents WHERE operation_id = 'run.cancel' AND outcome = 'allowed') AS cancelAudits,
         (SELECT integrity_check FROM pragma_integrity_check LIMIT 1) AS integrity`,
      started.runId,
      started.runId,
    );
    if (
      facts.cancelEvents !== 1 ||
      facts.cancelledEvents !== 1 ||
      facts.cancelAudits !== 2 ||
      facts.integrity !== 'ok'
    )
      fail(`durable facts drifted: ${JSON.stringify(facts)}`);
    const report = {
      schemaVersion: 2,
      profile: value.profile,
      platform: { os: 'linux', architecture: process.arch, procfs: true },
      resourceEnvelope: {
        memoryBytes:
          value.profile === 'edge' ? 128 * 1024 * 1024 : 256 * 1024 * 1024,
        pids: value.profile === 'edge' ? 64 : 256,
        apiRssBytes,
      },
      observations: {
        taskStartAccepted: true,
        cancellationAccepted: true,
        exactReplay: true,
        durableIntentEvents: facts.cancelEvents,
        durableCancellationEvents: facts.cancelledEvents,
        durableAllowedAudits: facts.cancelAudits,
        processIdentityObserved: true,
        processIdentityGone: !sameProcessExists(taskPid, taskStartTicks),
        restartObservedCancelled: true,
        sqliteIntegrity: facts.integrity,
      },
      panelClient: {
        authSourceSha256: panel.manifest.auth.sourceSha256,
        controlSourceSha256: panel.manifest.control.sourceSha256,
        unauthenticatedStatus: unauthorized.statusCode,
        capabilityDiscovered: true,
        runListed: true,
        logMarkerObserved: true,
        restartLogMarkerObserved: true,
        cancellationResponseLost: true,
        exactCancellationBodyReplay: true,
        startPosts: panel.requests.filter(
          (r) => r.method === 'POST' && r.path.endsWith('/runs'),
        ).length,
        cancellationPosts: cancelRequests.length,
        browserRendering: false,
        ownerProvisioning: 'seeded_fixture',
      },
      qualification: {
        evidenceClass: 'linux_virtualized_live_contract',
        physicalDevice: false,
        passed: true,
      },
      compatible: terminal.status === 'cancelled',
    };
    privateJson(path.join(value.evidenceRoot, 'report.json'), report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    if (active.child.exitCode === null && active.child.signalCode === null) {
      active.child.kill('SIGKILL');
      await active.exit.catch(() => undefined);
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = { options };
