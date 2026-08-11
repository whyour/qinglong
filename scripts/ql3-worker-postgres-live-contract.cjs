#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  createPostgresDatabaseOpener,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  runPostgresMigrations,
} = require('../packages/ql3-cluster-postgres/dist/migration/migration.js');
const {
  PostgresWorkerCredentialAdministrationRepository,
  PostgresTaskDefinitionRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/admin.js');
const {
  PostgresWorkerSessionRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/workerIngress.js');
const {
  createRecoverableWorkerCredentialIssuer,
  createWorkerCredentialDeliveryRecoveryService,
} = require('../packages/ql3-cluster-admin/dist/worker-credential/workerCredentialDelivery.js');
const {
  WorkerCredentialFileDeliveryAdapter,
} = require('../packages/ql3-cluster-admin/dist/worker-credential/workerCredentialFileDelivery.js');
const {
  createClusterWorkerRuntimePort,
} = require('../packages/ql3-cluster-control/dist/remote-execution/workerRuntimePort.js');
const {
  loadClusterWorkerIngressConfig,
} = require('../packages/ql3-cluster-control/dist/worker-ingress/workerIngressConfig.js');
const {
  startProductionClusterWorkerIngress,
} = require('../packages/ql3-cluster-control/dist/worker-ingress/productionWorkerIngress.js');
const {
  runProductionWorkerProcess,
} = require('../packages/ql3-worker-runtime/dist/process/workerProcessApplication.js');
const {
  startProductionWorkerApplication,
} = require('../packages/ql3-worker-runtime/dist/application-runtime/productionWorkerApplication.js');
const {
  generateWorkerCertificateEnrollment,
} = require('../packages/ql3-worker-runtime/dist/credential/workerCertificateEnrollment.js');
const {
  WorkerCertificateRenewalCoordinator,
} = require('../packages/ql3-worker-runtime/dist/credential/workerCertificateRenewal.js');
const {
  WorkerCertificateFileStore,
} = require('../packages/ql3-worker-runtime/dist/credential/workerCertificateStore.js');
const {
  WorkerTrustAnchorFileProvider,
} = require('../packages/ql3-worker-runtime/dist/process/workerProcessIdentity.js');
const {
  createCertificateAuthority,
} = require('../packages/ql3-worker-runtime/test/helpers/certificateAuthority.cjs');

const IMAGE = process.env.QL3_WORKER_POSTGRES_IMAGE ?? 'postgres:18';
const LINUX_NODE_IMAGE =
  process.env.QL3_WORKER_LIVE_NODE_IMAGE ?? 'node:24.18.0-bookworm-slim';
const DATABASE = 'ql3_worker_live';
const DATABASE_HOST = process.env.QL3_WORKER_POSTGRES_HOST ?? '127.0.0.1';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';
const MIGRATION_USER = 'ql3_migration';
const MIGRATION_PASSWORD = 'ql3_migration_live';
const RUNTIME_USER = 'ql3_runtime';
const RUNTIME_PASSWORD = 'ql3_runtime_live';
const ADMIN_USER = 'ql3_admin';
const ADMIN_PASSWORD = 'ql3_admin_live';
const AUTOMATION_MANAGER_USER = 'ql3_automation_manager';
const AUTOMATION_MANAGER_PASSWORD = 'ql3_automation_manager_live';
const APPROVAL_MANAGER_USER = 'ql3_approval_manager';
const APPROVAL_MANAGER_PASSWORD = 'ql3_approval_manager_live';
const PACKAGE_MANAGER_USER = 'ql3_package_manager';
const PACKAGE_MANAGER_PASSWORD = 'ql3_package_manager_live';
const PACKAGE_EXECUTOR_USER = 'ql3_package_executor';
const PACKAGE_EXECUTOR_PASSWORD = 'ql3_package_executor_live';
const WORKER_CREDENTIAL_MANAGER_USER = 'ql3_worker_credential_manager';
const WORKER_CREDENTIAL_MANAGER_PASSWORD = 'ql3_worker_credential_manager_live';
const WORKER_CREDENTIAL_EXECUTOR_USER = 'ql3_worker_credential_executor';
const WORKER_CREDENTIAL_EXECUTOR_PASSWORD =
  'ql3_worker_credential_executor_live';
const WORKER_INGRESS_USER = 'ql3_worker_ingress';
const WORKER_INGRESS_PASSWORD = 'ql3_worker_ingress_live';
const WORKER_ID = 'worker-postgres-live';
const RUN_ID = 'run-worker-postgres-live';
const ATTEMPT_ID = 'attempt-worker-postgres-live';
const TASK_ID = 'task-worker-postgres-live';
const PEPPER = Buffer.alloc(32, 19).toString('base64url');
const FIXTURES = path.resolve(
  __dirname,
  '../packages/ql3-cluster-control/test/fixtures/mtls',
);
const COMMAND_TIMEOUT_MS = 120_000;
const WAIT_TIMEOUT_MS = 30_000;
const LAUNCHER_PATH = path.resolve(
  __dirname,
  '../packages/ql3-local-process/assets/ql3-launcher.sh',
);

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stderr, result.stdout]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `docker ${args[0] ?? ''} failed with ${result.status}${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return Object.freeze({
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  });
}

function databaseUrl(user, password, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@${DATABASE_HOST}:${port}/${DATABASE}`;
}

function databaseOpener(role, connectionString, applicationName) {
  return createPostgresDatabaseOpener({
    role,
    connection: {
      connectionString,
      tls: { mode: 'disable' },
    },
    pool: {
      applicationName,
      maxConnections: role === 'migration' ? 1 : 4,
      connectionTimeoutMs: 2_000,
    },
    onPoolError() {},
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorFact(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) {
    return String(error);
  }
  return Object.freeze({
    name: error.name,
    message: error.message,
    code: error.code,
    reason: error.reason,
    statusCode: error.statusCode,
    httpStatus: error.httpStatus,
    ...(error.cause === undefined
      ? {}
      : { cause: errorFact(error.cause, depth + 1) }),
  });
}

async function waitFor(operation, description, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function mappedPostgresPort(containerName) {
  const output = docker(['port', containerName, '5432/tcp']).stdout;
  const match = output.match(/:(\d+)\s*$/);
  if (!match) throw new Error(`cannot parse PostgreSQL port: ${output}`);
  return Number(match[1]);
}

async function waitForPostgres(containerName) {
  return waitFor(
    () =>
      docker(
        [
          'exec',
          containerName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          SUPERUSER,
          '-d',
          DATABASE,
        ],
        { allowFailure: true },
      ).status === 0,
    'PostgreSQL readiness',
  );
}

async function runInsideLinuxContainer() {
  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const containerName = `ql3-worker-live-pg-${suffix}`;
  const repositoryRoot = path.resolve(__dirname, '..');
  let containerStarted = false;
  try {
    docker([
      'run',
      '--name',
      containerName,
      '--detach',
      '-e',
      `POSTGRES_DB=${DATABASE}`,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '-p',
      '127.0.0.1::5432',
      IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const postgresPort = mappedPostgresPort(containerName);
    const result = docker(
      [
        'run',
        '--rm',
        '--add-host',
        'host.docker.internal:host-gateway',
        '-e',
        'QL3_WORKER_LIVE_INSIDE_LINUX=true',
        '-e',
        'QL3_WORKER_POSTGRES_EXTERNAL=true',
        '-e',
        'QL3_WORKER_POSTGRES_HOST=host.docker.internal',
        '-e',
        `QL3_WORKER_POSTGRES_PORT=${postgresPort}`,
        '-e',
        `QL3_WORKER_POSTGRES_IMAGE=${IMAGE}`,
        '-v',
        `${repositoryRoot}:/workspace:ro`,
        '-w',
        '/workspace',
        LINUX_NODE_IMAGE,
        'node',
        'scripts/ql3-worker-postgres-live-contract.cjs',
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
    process.stdout.write(`${result.stdout}\n`);
  } finally {
    if (containerStarted) {
      docker(['rm', '--force', containerName], { allowFailure: true });
    }
  }
}

function createMemoryArtifactStore() {
  const entries = new Map();
  const key = (value) =>
    [value.projectId, value.runId, value.attemptId, value.logArtifactId].join(
      '\0',
    );
  return Object.freeze({
    async put(command, content) {
      const chunks = [];
      let byteLength = 0;
      const digest = createHash('sha256');
      for await (const chunk of content) {
        const copy = Buffer.from(chunk);
        chunks.push(copy);
        byteLength += copy.byteLength;
        digest.update(copy);
      }
      assert.equal(byteLength, command.byteLength);
      const sha256 = digest.digest('hex');
      const storageKey = key(command);
      const existing = entries.get(storageKey);
      if (existing) {
        assert.equal(existing.receipt.byteLength, byteLength);
        assert.equal(existing.receipt.sha256, sha256);
        return Object.freeze({
          ...existing.receipt,
          status: 'already_stored',
        });
      }
      const receipt = Object.freeze({
        status: 'stored',
        projectId: command.projectId,
        runId: command.runId,
        attemptId: command.attemptId,
        logArtifactId: command.logArtifactId,
        byteLength,
        sha256,
        ...(command.truncated === undefined
          ? {}
          : { truncated: command.truncated }),
      });
      entries.set(
        storageKey,
        Object.freeze({
          receipt,
          content: Buffer.concat(chunks, byteLength),
        }),
      );
      return receipt;
    },
    async inspect(lookup) {
      return entries.get(key(lookup))?.receipt;
    },
    read(lookup) {
      return entries.get(key(lookup));
    },
  });
}

async function seedRun(pool) {
  const occurredAtMs = Date.now();
  await pool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ('default', 'Default', 'default', 'active', 1, $1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [occurredAtMs],
  );
  const definition = await new PostgresTaskDefinitionRepository(
    pool,
  ).appendTaskDefinitionRevision({
    projectId: 'default',
    taskId: TASK_ID,
    expectedRevision: null,
    mutationId: randomUUID(),
    name: 'Worker PostgreSQL live Run',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/bin/sh',
          args: [
            '-c',
            'printf "ql3-live-start\\n"; sleep 7; printf "ql3-live-finish\\n"',
          ],
        },
      },
    },
    labels: {},
    enabled: true,
    occurredAtMs,
  });
  assert.equal(definition.status, 'created');
  const taskRevision =
    `qltd:v1:${definition.definition.revision}:` +
    definition.definition.contentDigest;
  await pool.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, trigger_type,
       execution_origin, execution_owner, status, priority,
       created_at_ms, queued_at_ms, version, event_sequence
     ) VALUES (
       $1, 'default', $2, $3, 'manual',
       'manual', 'runtime', 'queued', 10,
       $4, $4, 0, 0
     )`,
    [RUN_ID, TASK_ID, taskRevision, occurredAtMs],
  );
  await pool.query(
    `INSERT INTO "ql3"."run_attempts" (
       id, run_id, attempt, status, executor_type,
       callback_sequence, created_at_ms
     ) VALUES ($1, $2, 1, 'claimed', 'remote_worker', 0, $3)`,
    [ATTEMPT_ID, RUN_ID, occurredAtMs],
  );
}

async function readRunFacts(pool) {
  const result = await pool.query(
    `SELECT
       run.status AS "runStatus",
       run.version AS "runVersion",
       run.event_sequence AS "runEventSequence",
       run.started_at_ms AS "runStartedAtMs",
       run.finished_at_ms AS "runFinishedAtMs",
       attempt.status AS "attemptStatus",
       attempt.callback_sequence AS "callbackSequence",
       attempt.log_artifact_id AS "logArtifactId",
       attempt.exit_code AS "exitCode",
       attempt.lease_version AS "attemptLeaseVersion",
       lease.status AS "leaseStatus",
       lease.version AS "leaseVersion",
       lease.completed_at_ms AS "leaseCompletedAtMs",
       worker.status AS "workerStatus",
       worker.available_slots AS "workerAvailableSlots",
       worker.capabilities_json AS "workerCapabilitiesJson",
       ARRAY(
         SELECT audit.operation_id
           FROM "ql3"."security_audit_events" AS audit
          WHERE audit.subject_type = 'worker'
            AND audit.subject_id = $3
          ORDER BY audit.occurred_at_ms, audit.event_id
       ) AS "workerOperations",
       (
         SELECT count(*)::integer
           FROM "ql3"."task_execution_revisions" AS revision
          WHERE revision.project_id = run.project_id
            AND revision.task_id = run.task_id
            AND revision.executor_type = 'remote_worker'
       ) AS "executionRevisionCount",
       ARRAY(
         SELECT event.type
           FROM "ql3"."run_events" AS event
          WHERE event.run_id = run.id
          ORDER BY event.sequence
       ) AS events
     FROM "ql3"."runs" AS run
     JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
     LEFT JOIN "ql3"."run_dispatch_leases" AS lease
       ON lease.attempt_id = attempt.id
     LEFT JOIN "ql3"."worker_sessions" AS worker ON worker.worker_id = $3
     WHERE run.id = $1 AND attempt.id = $2`,
    [RUN_ID, ATTEMPT_ID, WORKER_ID],
  );
  return result.rows[0];
}

async function readWorkerStateFacts(stateRoot) {
  const journalRoot = path.join(stateRoot, 'journal');
  const offersRoot = path.join(journalRoot, 'offers');
  const names = await fs.readdir(offersRoot).catch(() => []);
  const offers = [];
  for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
    const value = JSON.parse(
      await fs.readFile(path.join(offersRoot, name), 'utf8'),
    );
    offers.push({
      offerId: value.offer?.offerId,
      state: value.state,
      recoveryReason: value.recoveryReason,
      revision: value.revision,
      executorStartedAtMs: value.executorStartedAtMs,
      executorHandle: value.executorHandle,
      logArtifactId: value.logArtifactId,
      callbackSequence: value.completionReceiptCallbackSequence,
      callbackTokenDigest: value.completionReceiptTokenDigest,
      leaseVersion: value.offer?.lease?.version,
      leaseExpiresAtMs: value.offer?.lease?.expiresAtMs,
    });
  }
  const entries = await fs
    .readdir(stateRoot, { recursive: true })
    .catch(() => []);
  return Object.freeze({ offers, entries: entries.sort() });
}

async function readCompletionEvidence(stateRoot, workerState) {
  const offer = workerState.offers[0];
  if (!offer) return Object.freeze({ offerPresent: false });
  const receiptFile = path.join(
    stateRoot,
    'receipts',
    ATTEMPT_ID.slice(0, 2),
    `${ATTEMPT_ID}.json`,
  );
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  } catch {
    return Object.freeze({ offerPresent: true, receiptPresent: false });
  }
  const logFile = path.join(
    stateRoot,
    'logs',
    offer.logArtifactId.slice(5, 7),
    `${offer.logArtifactId}.log`,
  );
  const log = await fs.readFile(logFile).catch(() => undefined);
  const token = Buffer.from(receipt.token ?? '', 'base64url');
  try {
    return Object.freeze({
      offerPresent: true,
      receiptPresent: true,
      receiptRunMatches: receipt.runId === RUN_ID,
      receiptAttemptMatches: receipt.attemptId === ATTEMPT_ID,
      callbackSequenceMatches:
        receipt.callbackSequence === offer.callbackSequence,
      callbackTokenDigestMatches:
        createHash('sha256').update(token).digest('hex') ===
        offer.callbackTokenDigest,
      startedAtMatches: receipt.startedAtMs === offer.executorStartedAtMs,
      finishedAtIsCurrent:
        Number.isSafeInteger(receipt.finishedAtMs) &&
        receipt.finishedAtMs <= Date.now(),
      exitCode: receipt.exitCode,
      logPresent: log !== undefined,
      logByteLength: log?.byteLength,
    });
  } finally {
    token.fill(0);
    log?.fill(0);
  }
}

async function writePrivate(file, value, mode) {
  await fs.writeFile(file, value, { mode });
  await fs.chmod(file, mode);
}

async function probeMutualTls({ port, trustAnchor, certificate, privateKey }) {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: '127.0.0.1',
        port,
        path: '/__ql3_transport_probe__',
        method: 'GET',
        ca: trustAnchor,
        cert: certificate,
        key: privateKey,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
        agent: false,
        timeout: 3_000,
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolve(
            Object.freeze({
              accepted: true,
              statusCode: response.statusCode,
            }),
          ),
        );
      },
    );
    request.once('timeout', () => request.destroy(new Error('probe timeout')));
    request.once('error', (error) =>
      resolve(
        Object.freeze({
          accepted: false,
          code: error.code,
        }),
      ),
    );
    request.end();
  });
}

async function readActiveCertificate(store, trustAnchors, now = Date.now()) {
  const anchors = await trustAnchors.load(new AbortController().signal);
  try {
    return await store.readActive(anchors, now);
  } finally {
    anchors.forEach((anchor) => anchor.fill(0));
  }
}

async function prepareWorkerFiles(root) {
  const authority = path.join(root, 'authority');
  const stages = path.join(root, 'credential-stages');
  const state = path.join(root, 'state');
  await Promise.all([
    fs.mkdir(authority, { mode: 0o700 }),
    fs.mkdir(stages, { mode: 0o700 }),
    fs.mkdir(state, { mode: 0o700 }),
  ]);
  await Promise.all([
    fs.chmod(authority, 0o700),
    fs.chmod(stages, 0o700),
    fs.chmod(state, 0o700),
  ]);
  const serverAuthority = await fs.readFile(path.join(FIXTURES, 'ca-cert.pem'));
  const [initialAuthority, renewalAuthority] = await Promise.all([
    createCertificateAuthority(),
    createCertificateAuthority(),
  ]);
  const enrollment = await generateWorkerCertificateEnrollment({
    workerId: WORKER_ID,
  });
  let clientCertificate;
  let clientPrivateKey;
  try {
    clientCertificate = Buffer.from(
      await initialAuthority.issue(enrollment.certificateSigningRequestPem, {
        notAfterMs: Date.now() + 2 * 60 * 60_000,
      }),
    );
    clientPrivateKey = Buffer.from(enrollment.privateKeyPem);
  } finally {
    enrollment.dispose();
  }
  const initialAuthorityCertificate = Buffer.from(
    initialAuthority.certificatePem,
  );
  const renewalAuthorityCertificate = Buffer.from(
    renewalAuthority.certificatePem,
  );
  const workerTrustBundle = Buffer.concat([
    serverAuthority,
    initialAuthorityCertificate,
    renewalAuthorityCertificate,
  ]);
  const ingressInitialTrustBundle = Buffer.concat([
    initialAuthorityCertificate,
    renewalAuthorityCertificate,
  ]);
  const capabilitiesFile = path.join(authority, 'capabilities.json');
  const trustAnchorFile = path.join(authority, 'ca.crt');
  const ingressClientCaFile = path.join(authority, 'ingress-client-ca.crt');
  const ingressRotatedClientCaFile = path.join(
    authority,
    'ingress-client-ca-rotated.crt',
  );
  const certificateFile = path.join(authority, 'tls.crt');
  const privateKeyFile = path.join(authority, 'tls.key');
  const tokenFile = path.join(authority, 'credential-token');
  await Promise.all([
    writePrivate(
      capabilitiesFile,
      `${JSON.stringify({
        architecture: process.arch,
        operatingSystem: process.platform,
        executors: ['remote-worker'],
        runtimes: [{ name: 'node', version: process.versions.node }],
        labels: { contract: 'postgres-live' },
        capacity: {
          cpuCores: 1,
          memoryBytes: 256 * 1024 * 1024,
        },
        features: [],
      })}\n`,
      0o400,
    ),
    writePrivate(trustAnchorFile, workerTrustBundle, 0o400),
    writePrivate(ingressClientCaFile, ingressInitialTrustBundle, 0o400),
    writePrivate(
      ingressRotatedClientCaFile,
      renewalAuthorityCertificate,
      0o400,
    ),
    writePrivate(certificateFile, clientCertificate, 0o400),
    writePrivate(privateKeyFile, clientPrivateKey, 0o600),
  ]);
  serverAuthority.fill(0);
  initialAuthorityCertificate.fill(0);
  renewalAuthorityCertificate.fill(0);
  workerTrustBundle.fill(0);
  ingressInitialTrustBundle.fill(0);
  clientCertificate.fill(0);
  clientPrivateKey.fill(0);
  return Object.freeze({
    authority,
    stages,
    state,
    capabilitiesFile,
    trustAnchorFile,
    ingressClientCaFile,
    ingressRotatedClientCaFile,
    certificateFile,
    privateKeyFile,
    tokenFile,
    renewalAuthority,
  });
}

function issueRequest({
  credentialId,
  previousCredentialId,
  deploymentTargetDigest,
  deploymentGeneration,
  principal,
}) {
  const nowMs = Date.now();
  return Object.freeze({
    mutationId: randomUUID(),
    requestId: `worker-live-issue:${credentialId}`,
    expectedCurrentVersion: 0,
    credentialId,
    workerId: WORKER_ID,
    principal,
    notBeforeAtMs: nowMs,
    expiresAtMs: nowMs + 60 * 60_000,
    previousCredentialId,
    deploymentTargetDigest,
    deploymentGeneration,
  });
}

async function deliveryState(admin, deliveryId, state) {
  const delivery = await admin.resolveDelivery(deliveryId);
  return delivery?.state === state ? delivery : null;
}

async function readFacts(pool, firstCredentialId, secondCredentialId) {
  const result = await pool.query(
    `SELECT
       (SELECT row_to_json(session_record)
          FROM (
            SELECT session_id AS "sessionId",
                   generation,
                   status,
                   version,
                   max_concurrent_runs AS "maxConcurrentRuns"
              FROM "ql3"."worker_sessions"
             WHERE worker_id = $1
          ) AS session_record) AS session,
       (SELECT array_agg(authentication_id ORDER BY occurred_at_ms, event_id)
          FROM "ql3"."security_audit_events"
         WHERE subject_type = 'worker'
           AND subject_id = $1
           AND outcome = 'allowed') AS "authenticationIds",
       (SELECT array_agg(operation_id ORDER BY occurred_at_ms, event_id)
          FROM "ql3"."security_audit_events"
         WHERE subject_type = 'worker'
           AND subject_id = $1
           AND outcome = 'allowed') AS operations,
       (SELECT state
          FROM "ql3"."worker_credentials"
         WHERE credential_id = $2
         ORDER BY version DESC LIMIT 1) AS "firstCredentialState",
       (SELECT state
          FROM "ql3"."worker_credentials"
         WHERE credential_id = $3
         ORDER BY version DESC LIMIT 1) AS "secondCredentialState",
       NOT EXISTS (
         SELECT 1
           FROM (
             SELECT to_jsonb(credential)::text AS payload
               FROM "ql3"."worker_credentials" AS credential
              WHERE worker_id = $1
             UNION ALL
             SELECT to_jsonb(delivery)::text AS payload
               FROM "ql3"."worker_credential_deliveries" AS delivery
              WHERE worker_id = $1
             UNION ALL
             SELECT to_jsonb(audit)::text AS payload
               FROM "ql3"."security_audit_events" AS audit
              WHERE subject_type = 'worker' AND subject_id = $1
           ) AS persisted
          WHERE persisted.payload LIKE '%ql3w_%'
       ) AS "secretsAbsent"`,
    [WORKER_ID, firstCredentialId, secondCredentialId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function main() {
  if (
    process.platform !== 'linux' &&
    process.env.QL3_WORKER_LIVE_INSIDE_LINUX !== 'true'
  ) {
    await runInsideLinuxContainer();
    return;
  }
  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const containerName = `ql3-worker-live-pg-${suffix}`;
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql3-worker-postgres-live-'),
  );
  let containerStarted = false;
  let superuserDatabase;
  let migrationDatabase;
  let runtimeDatabase;
  let adminDatabase;
  let ingress;
  let signalListener;
  let workerPromise;
  const events = [];
  const serverFailures = [];
  const workerFailures = [];
  const startedAt = performance.now();
  try {
    let postgresPort;
    if (process.env.QL3_WORKER_POSTGRES_EXTERNAL === 'true') {
      postgresPort = Number(process.env.QL3_WORKER_POSTGRES_PORT);
      if (
        !Number.isInteger(postgresPort) ||
        postgresPort < 1 ||
        postgresPort > 65535
      ) {
        throw new Error('external PostgreSQL port is invalid');
      }
    } else {
      docker([
        'run',
        '--name',
        containerName,
        '--detach',
        '-e',
        `POSTGRES_DB=${DATABASE}`,
        '-e',
        `POSTGRES_USER=${SUPERUSER}`,
        '-e',
        `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
        '-p',
        '127.0.0.1::5432',
        IMAGE,
      ]);
      containerStarted = true;
      await waitForPostgres(containerName);
      postgresPort = mappedPostgresPort(containerName);
    }
    superuserDatabase = await databaseOpener(
      'migration',
      databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, postgresPort),
      'ql3-worker-live-bootstrap',
    )();
    await superuserDatabase.pool.query(
      `CREATE ROLE ${MIGRATION_USER} LOGIN PASSWORD '${MIGRATION_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${ADMIN_USER} LOGIN PASSWORD '${ADMIN_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${AUTOMATION_MANAGER_USER} LOGIN PASSWORD '${AUTOMATION_MANAGER_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${APPROVAL_MANAGER_USER} LOGIN PASSWORD '${APPROVAL_MANAGER_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${PACKAGE_MANAGER_USER} LOGIN PASSWORD '${PACKAGE_MANAGER_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${PACKAGE_EXECUTOR_USER} LOGIN PASSWORD '${PACKAGE_EXECUTOR_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${WORKER_CREDENTIAL_MANAGER_USER} LOGIN PASSWORD '${WORKER_CREDENTIAL_MANAGER_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${WORKER_CREDENTIAL_EXECUTOR_USER} LOGIN PASSWORD '${WORKER_CREDENTIAL_EXECUTOR_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `CREATE ROLE ${WORKER_INGRESS_USER} LOGIN PASSWORD '${WORKER_INGRESS_PASSWORD}'`,
    );
    await superuserDatabase.pool.query(
      `ALTER DATABASE ${DATABASE} OWNER TO ${MIGRATION_USER}`,
    );
    migrationDatabase = await databaseOpener(
      'migration',
      databaseUrl(MIGRATION_USER, MIGRATION_PASSWORD, postgresPort),
      'ql3-worker-live-migration',
    )();
    await runPostgresMigrations({ pool: migrationDatabase.pool });
    runtimeDatabase = await databaseOpener(
      'runtime',
      databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, postgresPort),
      'ql3-worker-live-runtime',
    )();
    adminDatabase = await databaseOpener(
      'admin',
      databaseUrl(ADMIN_USER, ADMIN_PASSWORD, postgresPort),
      'ql3-worker-live-admin',
    )();
    const files = await prepareWorkerFiles(root);
    const deliveryAdapter = new WorkerCredentialFileDeliveryAdapter({
      stageDirectory: files.stages,
      targetTokenFile: files.tokenFile,
    });
    const administration = new PostgresWorkerCredentialAdministrationRepository(
      adminDatabase.pool,
    );
    const principal = Object.freeze({
      subject: Object.freeze({
        type: 'user',
        id: 'usr_worker_live_operator',
      }),
      authenticationId: 'session:worker-live-operator',
      authenticatedAtMs: Date.now() - 1_000,
      expiresAtMs: Date.now() + 60 * 60_000,
      assurance: 'multi_factor',
    });
    const firstCredentialId = `worker_live_a_${suffix}`;
    const firstRequest = issueRequest({
      credentialId: firstCredentialId,
      previousCredentialId: null,
      deploymentTargetDigest: deliveryAdapter.deploymentTargetDigest,
      deploymentGeneration: 'worker-live-generation-1',
      principal,
    });
    const firstIssued = await createRecoverableWorkerCredentialIssuer(
      administration,
      deliveryAdapter,
      PEPPER,
      { now: () => firstRequest.notBeforeAtMs },
    ).issue(firstRequest);
    assert.equal(firstIssued.status, 'published');
    assert.equal(firstIssued.delivery.state, 'published');

    const ingressPort = await freePort();
    const artifactStore = createMemoryArtifactStore();
    const launcherSha256 = createHash('sha256')
      .update(await fs.readFile(LAUNCHER_PATH))
      .digest('hex');
    const ingressConfig = loadClusterWorkerIngressConfig({
      QL_DEPLOYMENT_PROFILE: 'cluster-control',
      QL3_WORKER_INGRESS_ENABLED: 'true',
      QL3_WORKER_INGRESS_HOST: '127.0.0.1',
      QL3_WORKER_INGRESS_PORT: String(ingressPort),
      QL3_POSTGRES_WORKER_INGRESS_URL: databaseUrl(
        WORKER_INGRESS_USER,
        WORKER_INGRESS_PASSWORD,
        postgresPort,
      ),
      QL3_WORKER_INGRESS_POSTGRES_TLS_MODE: 'disable',
      QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE: 'true',
      QL3_WORKER_CREDENTIAL_PEPPER: PEPPER,
      QL3_WORKER_ARTIFACT_S3_BUCKET: 'qinglong-worker-live',
      QL3_WORKER_ARTIFACT_S3_REGION: 'us-east-1',
      QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: path.join(
        FIXTURES,
        'server-key.pem',
      ),
      QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: path.join(
        FIXTURES,
        'server-cert.pem',
      ),
      QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: files.ingressClientCaFile,
    });
    assert.equal(ingressConfig.enabled, true);
    const runtimePort = createClusterWorkerRuntimePort(runtimeDatabase.pool, {
      artifactStore,
    });
    const runtime = Object.freeze({
      ...runtimePort,
      activation: Object.freeze({
        acknowledgeStarting: (...args) =>
          runtimePort.activation.acknowledgeStarting(...args),
        async acknowledgeRunning(...args) {
          try {
            return await runtimePort.activation.acknowledgeRunning(...args);
          } catch (error) {
            if (serverFailures.length < 4) {
              serverFailures.push(errorFact(error));
            }
            throw error;
          }
        },
        failStart: (...args) => runtimePort.activation.failStart(...args),
      }),
    });
    ingress = await startProductionClusterWorkerIngress({
      config: ingressConfig,
      runtime,
    });
    assert.equal(ingress.status, 'active');
    assert.equal(ingress.transport, 'mutual-tls');

    let renewalNowMs = Date.now();
    let renewalIssues = 0;
    const certificateStore = new WorkerCertificateFileStore({
      rootDirectory: path.join(files.state, 'identity'),
      retainedGenerations: 2,
    });
    const certificateTrust = new WorkerTrustAnchorFileProvider(
      files.trustAnchorFile,
    );
    const certificateRenewal = new WorkerCertificateRenewalCoordinator({
      workerId: WORKER_ID,
      store: certificateStore,
      trustAnchors: certificateTrust,
      issuer: {
        async issue({ certificateSigningRequestPem, signal }) {
          signal.throwIfAborted();
          renewalIssues += 1;
          const certificateChainPem = await files.renewalAuthority.issue(
            certificateSigningRequestPem,
            {
              notBeforeMs: Date.now() - 60_000,
              notAfterMs: Date.now() + 7 * 24 * 60 * 60_000,
            },
          );
          signal.throwIfAborted();
          return { certificateChainPem };
        },
      },
      policy: {
        renewBeforeMs: 60 * 60_000,
        minimumIssuedValidityMs: 2 * 60 * 60_000,
        operationTimeoutMs: 30_000,
        backoffBaseMs: 1_000,
        backoffMaximumMs: 60_000,
      },
      now: () => renewalNowMs,
    });

    workerPromise = runProductionWorkerProcess({
      environment: {
        QL_DEPLOYMENT_PROFILE: 'worker',
        QL3_WORKER_RUNTIME_ENABLED: 'true',
        QL3_WORKER_ID: WORKER_ID,
        QL3_WORKER_CONTROL_ORIGIN: `https://127.0.0.1:${ingress.address.port}`,
        QL3_WORKER_CAPACITY_PROFILE: 'edge',
        QL3_WORKER_CAPABILITIES_FILE: files.capabilitiesFile,
        QL3_WORKER_JOURNAL_ROOT: path.join(files.state, 'journal'),
        QL3_WORKER_LOG_ROOT: path.join(files.state, 'logs'),
        QL3_WORKER_RECEIPT_ROOT: path.join(files.state, 'receipts'),
        QL3_WORKER_CERTIFICATE_STORE_ROOT: path.join(files.state, 'identity'),
        QL3_WORKER_TRUST_ANCHOR_FILE: files.trustAnchorFile,
        QL3_WORKER_CREDENTIAL_TOKEN_FILE: files.tokenFile,
        QL3_WORKER_IDENTITY_BOOTSTRAP_PRIVATE_KEY_FILE: files.privateKeyFile,
        QL3_WORKER_IDENTITY_BOOTSTRAP_CERTIFICATE_FILE: files.certificateFile,
        QL3_WORKER_CADENCE_MS: '100',
        QL3_WORKER_HEARTBEAT_INTERVAL_MS: '5000',
        QL3_WORKER_SESSION_LEASE_DURATION_MS: '15000',
        QL3_WORKER_DRAIN_POLL_MS: '25',
        QL3_WORKER_LAUNCHER_PATH: LAUNCHER_PATH,
        QL3_WORKER_LAUNCHER_SHA256: launcherSha256,
      },
      signals: {
        subscribe(listener) {
          signalListener = listener;
          return () => {
            signalListener = undefined;
          };
        },
      },
      emit(event) {
        events.push(event);
      },
      async createCertificateRenewal(config, credentials) {
        assert.equal(config.workerId, WORKER_ID);
        assert.equal(typeof credentials.load, 'function');
        return certificateRenewal;
      },
      start(options) {
        return startProductionWorkerApplication({
          ...options,
          diagnostic(fact) {
            if (
              workerFailures.filter((failure) => failure.code === fact.code)
                .length < 4
            ) {
              workerFailures.push(
                Object.freeze({
                  code: fact.code,
                  offerId: fact.offerId,
                  error: errorFact(fact.error),
                }),
              );
            }
            return options.diagnostic(fact);
          },
        });
      },
    });

    const firstObserved = await waitFor(
      () => deliveryState(administration, firstRequest.mutationId, 'observed'),
      'first credential observation through a real Worker heartbeat',
    );
    const online = await readFacts(
      migrationDatabase.pool,
      firstCredentialId,
      firstCredentialId,
    );
    assert.equal(online.session.status, 'online');
    assert.equal(online.session.generation, 1);
    const sessionId = online.session.sessionId;

    const initialCertificateIdentity = await readActiveCertificate(
      certificateStore,
      certificateTrust,
    );
    assert(initialCertificateIdentity);
    renewalNowMs += 90 * 60_000;
    const renewedCertificateIdentity = await waitFor(async () => {
      const active = await readActiveCertificate(
        certificateStore,
        certificateTrust,
        renewalNowMs,
      );
      return active?.certificateSha256 !==
        initialCertificateIdentity.certificateSha256
        ? active
        : null;
    }, 'Worker certificate renewal through the production cadence');
    assert.equal(renewalIssues, 1);

    const [serverPrivateKey, serverCertificate, rotatedClientAuthority] =
      await Promise.all([
        fs.readFile(path.join(FIXTURES, 'server-key.pem')),
        fs.readFile(path.join(FIXTURES, 'server-cert.pem')),
        fs.readFile(files.ingressRotatedClientCaFile),
      ]);
    let transportGeneration;
    try {
      transportGeneration = ingress.reloadTransport({
        privateKey: serverPrivateKey,
        certificateChain: serverCertificate,
        clientCertificateAuthorities: [rotatedClientAuthority],
      });
    } finally {
      serverPrivateKey.fill(0);
      serverCertificate.fill(0);
      rotatedClientAuthority.fill(0);
    }
    assert.equal(transportGeneration > 1, true);

    const [
      probeTrust,
      oldCertificate,
      oldPrivateKey,
      newCertificate,
      newPrivateKey,
    ] = await Promise.all([
      fs.readFile(files.trustAnchorFile),
      fs.readFile(files.certificateFile),
      fs.readFile(files.privateKeyFile),
      fs.readFile(renewedCertificateIdentity.certificateChainFile),
      fs.readFile(renewedCertificateIdentity.privateKeyFile),
    ]);
    let oldCertificateProbe;
    let newCertificateProbe;
    try {
      [oldCertificateProbe, newCertificateProbe] = await Promise.all([
        probeMutualTls({
          port: ingress.address.port,
          trustAnchor: probeTrust,
          certificate: oldCertificate,
          privateKey: oldPrivateKey,
        }),
        probeMutualTls({
          port: ingress.address.port,
          trustAnchor: probeTrust,
          certificate: newCertificate,
          privateKey: newPrivateKey,
        }),
      ]);
    } finally {
      probeTrust.fill(0);
      oldCertificate.fill(0);
      oldPrivateKey.fill(0);
      newCertificate.fill(0);
      newPrivateKey.fill(0);
    }
    assert.equal(oldCertificateProbe.accepted, false);
    assert.equal(newCertificateProbe.accepted, true);

    const afterReload = await readFacts(
      migrationDatabase.pool,
      firstCredentialId,
      firstCredentialId,
    );
    const authenticatedAfterCertificateRotation = await waitFor(async () => {
      const facts = await readFacts(
        migrationDatabase.pool,
        firstCredentialId,
        firstCredentialId,
      );
      return facts.authenticationIds.length >
        afterReload.authenticationIds.length
        ? facts
        : null;
    }, 'authenticated Worker request after certificate trust contraction');
    assert.equal(
      authenticatedAfterCertificateRotation.session.sessionId,
      sessionId,
    );
    assert.equal(authenticatedAfterCertificateRotation.session.generation, 1);

    await seedRun(migrationDatabase.pool);
    let running;
    try {
      running = await waitFor(async () => {
        const facts = await readRunFacts(migrationDatabase.pool);
        return facts?.attemptStatus === 'running' ? facts : null;
      }, 'real Run starting and running activation');
    } catch (error) {
      const facts = await readRunFacts(migrationDatabase.pool);
      const diagnostics = events
        .filter((event) => event.event === 'runtime_diagnostic')
        .map((event) => event.diagnostic.code);
      const workerState = await readWorkerStateFacts(files.state);
      throw new Error(
        `real Run activation evidence: ${JSON.stringify({
          facts,
          diagnostics: [...new Set(diagnostics)],
          serverFailures,
          workerFailures,
          workerState,
        })}`,
        { cause: error },
      );
    }
    assert.equal(running.runStatus, 'running');
    assert.equal(running.leaseStatus, 'leased');
    assert.equal(running.callbackSequence, 1);

    const secondCredentialId = `worker_live_b_${suffix}`;
    const secondRequest = issueRequest({
      credentialId: secondCredentialId,
      previousCredentialId: firstCredentialId,
      deploymentTargetDigest: deliveryAdapter.deploymentTargetDigest,
      deploymentGeneration: 'worker-live-generation-2',
      principal,
    });
    const secondIssued = await createRecoverableWorkerCredentialIssuer(
      administration,
      deliveryAdapter,
      PEPPER,
      { now: () => secondRequest.notBeforeAtMs },
    ).issue(secondRequest);
    assert.equal(secondIssued.status, 'published');
    assert.equal(secondIssued.delivery.state, 'published');
    let secondObserved;
    try {
      secondObserved = await waitFor(
        () =>
          deliveryState(administration, secondRequest.mutationId, 'observed'),
        'rotated credential observation through the same Worker Session',
      );
    } catch (error) {
      const [sessionFacts, runFacts, workerState, tokenText] =
        await Promise.all([
          readFacts(
            migrationDatabase.pool,
            firstCredentialId,
            secondCredentialId,
          ),
          readRunFacts(migrationDatabase.pool),
          readWorkerStateFacts(files.state),
          fs.readFile(files.tokenFile, 'utf8'),
        ]);
      const completionEvidence = await readCompletionEvidence(
        files.state,
        workerState,
      );
      let heartbeatProbe;
      try {
        const result = await new PostgresWorkerSessionRepository(
          migrationDatabase.pool,
        ).heartbeatAuthenticated(
          {
            workerId: WORKER_ID,
            sessionId: sessionFacts.session.sessionId,
            generation: sessionFacts.session.generation,
            expectedVersion: sessionFacts.session.version,
            availableSlots: 0,
            leaseDurationMs: 15_000,
          },
          {
            workerId: WORKER_ID,
            credentialId: secondCredentialId,
            credentialVersion: 1,
          },
        );
        heartbeatProbe = Object.freeze({
          status: 'succeeded',
          version: result.version,
        });
      } catch (probeError) {
        heartbeatProbe = Object.freeze({
          status: 'failed',
          error: errorFact(probeError),
        });
      }
      throw new Error(
        `rotated credential evidence: ${JSON.stringify({
          sessionFacts,
          runFacts,
          diagnostics: [
            ...new Set(
              events
                .filter((event) => event.event === 'runtime_diagnostic')
                .map((event) => event.diagnostic.code),
            ),
          ],
          serverFailures,
          workerFailures,
          workerState,
          completionEvidence,
          heartbeatProbe,
          tokenFileReferencesSecondCredential:
            tokenText.includes(secondCredentialId),
        })}`,
        { cause: error },
      );
    }
    const recovery = await createWorkerCredentialDeliveryRecoveryService(
      administration,
      deliveryAdapter,
      PEPPER,
      principal,
    ).recoverPage({ limit: 16 });
    assert.equal(
      recovery.outcomes.some(
        (outcome) =>
          outcome.deliveryId === secondRequest.mutationId &&
          outcome.state === 'previous_revoked',
      ),
      true,
    );

    const rotated = await waitFor(async () => {
      const facts = await readFacts(
        migrationDatabase.pool,
        firstCredentialId,
        secondCredentialId,
      );
      return facts.authenticationIds?.some(
        (authenticationId) =>
          authenticationId === `worker_credential:${secondCredentialId}:1`,
      )
        ? facts
        : null;
    }, 'post-rotation authenticated Worker request');
    assert.equal(rotated.session.sessionId, sessionId);
    assert.equal(rotated.session.generation, 1);
    assert.equal(rotated.firstCredentialState, 'revoked');
    assert.equal(rotated.secondCredentialState, 'active');
    assert.equal(rotated.secretsAbsent, true);

    const completed = await waitFor(async () => {
      const facts = await readRunFacts(migrationDatabase.pool);
      return facts?.attemptStatus === 'succeeded' ? facts : null;
    }, 'real Run Artifact upload and completion');
    assert.equal(completed.runStatus, 'succeeded');
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.leaseStatus, 'completed');
    assert.equal(completed.leaseVersion > running.leaseVersion, true);
    assert.equal(completed.attemptLeaseVersion, completed.leaseVersion);
    assert.equal(completed.callbackSequence, 1);
    assert.equal(completed.events.includes('attempt.starting'), true);
    assert.equal(completed.events.includes('attempt.running'), true);
    assert.equal(completed.events.includes('attempt.succeeded'), true);
    assert.equal(completed.events.includes('run.succeeded'), true);
    const artifact = artifactStore.read({
      projectId: 'default',
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      logArtifactId: completed.logArtifactId,
    });
    assert(artifact);
    assert.equal(
      artifact.content.toString('utf8'),
      'ql3-live-start\nql3-live-finish\n',
    );
    assert.equal(
      artifact.receipt.sha256,
      createHash('sha256').update(artifact.content).digest('hex'),
    );

    signalListener?.('SIGTERM');
    assert.equal(await workerPromise, 'stopped');
    workerPromise = undefined;
    const stopped = await waitFor(async () => {
      const facts = await readFacts(
        migrationDatabase.pool,
        firstCredentialId,
        secondCredentialId,
      );
      return facts.session?.status === 'offline' ? facts : null;
    }, 'Worker drain and offline transition');
    assert.equal(stopped.session.sessionId, sessionId);
    assert.equal(stopped.session.generation, 1);
    assert.equal(stopped.operations.includes('worker.register'), true);
    assert.equal(stopped.operations.includes('worker.offers'), true);
    for (const operation of [
      'worker.starting',
      'worker.running',
      'worker.artifacts',
      'worker.completion',
      'worker.lease-control',
    ]) {
      assert.equal(stopped.operations.includes(operation), true);
    }
    assert.equal(
      stopped.operations.filter(
        (operation) => operation === 'worker.transition',
      ).length >= 2,
      true,
    );

    const privilegeFacts = await migrationDatabase.pool.query(
      `SELECT
         NOT has_table_privilege(
           $1, 'ql3.worker_credentials', 'SELECT'
         ) AS "runtimeCannotReadCredentials",
         NOT has_table_privilege(
           $2, 'ql3.runs', 'UPDATE'
         ) AS "ingressCannotMutateRuns",
         has_table_privilege(
           $2, 'ql3.worker_sessions', 'UPDATE'
         ) AS "ingressCanUpdateSessions"`,
      [RUNTIME_USER, WORKER_INGRESS_USER],
    );
    assert.deepEqual(privilegeFacts.rows[0], {
      runtimeCannotReadCredentials: true,
      ingressCannotMutateRuns: true,
      ingressCanUpdateSessions: true,
    });

    const report = Object.freeze({
      schemaVersion: 1,
      contract: 'qinglong3-worker-postgres-live',
      postgres: Object.freeze({
        image: IMAGE,
        serverVersion: (
          await migrationDatabase.pool.query('SHOW server_version')
        ).rows[0].server_version,
      }),
      transport: Object.freeze({
        protocol: 'TLSv1.3',
        mutualTls: true,
      }),
      certificateRotation: Object.freeze({
        renewalIssues,
        transportGeneration,
        initialCertificateSha256: initialCertificateIdentity.certificateSha256,
        renewedCertificateSha256: renewedCertificateIdentity.certificateSha256,
        sameSessionPreserved:
          authenticatedAfterCertificateRotation.session.sessionId === sessionId,
        oldCertificateRejected: !oldCertificateProbe.accepted,
        renewedCertificateAccepted: newCertificateProbe.accepted,
      }),
      worker: Object.freeze({
        workerId: WORKER_ID,
        sessionId,
        generation: stopped.session.generation,
        finalStatus: stopped.session.status,
        processEvents: events.map((event) => event.event),
        diagnosticCodes: events
          .filter((event) => event.event === 'runtime_diagnostic')
          .map((event) => event.diagnostic.code),
      }),
      credentialRotation: Object.freeze({
        firstDeliveryStates: [
          'credential_committed',
          'published',
          firstObserved.state,
        ],
        secondDeliveryStates: [
          'credential_committed',
          'published',
          secondObserved.state,
          'previous_revoked',
        ],
        sameSessionPreserved: true,
        firstCredentialRevoked: true,
        secondCredentialActive: true,
        secretsAbsentFromPostgres: stopped.secretsAbsent,
      }),
      execution: Object.freeze({
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        runStatus: completed.runStatus,
        attemptStatus: completed.attemptStatus,
        exitCode: completed.exitCode,
        callbackSequence: completed.callbackSequence,
        leaseStatus: completed.leaseStatus,
        leaseRenewals: completed.leaseVersion,
        eventTypes: completed.events,
        artifact: Object.freeze({
          logArtifactId: artifact.receipt.logArtifactId,
          byteLength: artifact.receipt.byteLength,
          sha256: artifact.receipt.sha256,
          content: artifact.content.toString('utf8'),
        }),
        completedAfterCredentialRotation:
          stopped.authenticationIds.at(-1) ===
          `worker_credential:${secondCredentialId}:1`,
      }),
      authority: privilegeFacts.rows[0],
      elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
      gates: Object.freeze({
        passed: true,
      }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (workerPromise) {
      signalListener?.('SIGTERM');
      await Promise.race([workerPromise.catch(() => undefined), delay(10_000)]);
    }
    await ingress?.stop().catch(() => undefined);
    await Promise.all([
      adminDatabase?.close().catch(() => undefined),
      runtimeDatabase?.close().catch(() => undefined),
      migrationDatabase?.close().catch(() => undefined),
      superuserDatabase?.close().catch(() => undefined),
    ]);
    if (containerStarted) {
      docker(['rm', '--force', containerName], { allowFailure: true });
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `QingLong 3.0 Worker PostgreSQL live contract failed: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
