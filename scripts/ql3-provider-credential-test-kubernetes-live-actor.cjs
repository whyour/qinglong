#!/usr/bin/env node

'use strict';

const fs = require('node:fs');

const {
  createModelProviderCredentialTransitionCommand,
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
} = require('@qinglong/ai/model-provider-credential-catalog');
const {
  modelProviderCredentialAdministrationOperationId,
} = require('@qinglong/ai/model-provider-credential-administration');
const {
  createModelProviderCredentialTestPlan,
  normalizeModelProviderCredentialTestAllowlist,
  resolveModelProviderCredentialTestEndpoint,
} = require('@qinglong/ai/model-provider-credential-test-connection');
const {
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
  PostgresModelProviderCredentialTestPlanRepository,
} = require('@qinglong/ai/postgres-model-provider-credential-test-connection');
const {
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
} = require('@qinglong/ai/provider-credential');
const {
  PostgresModelProviderCredentialRepository,
} = require('@qinglong/ai/postgres-model-provider-credential-storage');
const {
  createPostgresDatabaseOpener,
  loadPostgresCertificateAuthorityFile,
} = require('@qinglong/cluster-postgres/ai-credential-manager');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function fail(message) {
  throw new Error(`provider credential test live actor: ${message}`);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  return value;
}

function readCommand() {
  const commandFile = requiredEnvironment('QL3_LIVE_ACTOR_COMMAND_FILE');
  const stat = fs.lstatSync(commandFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    fail('command file is invalid');
  }
  return JSON.parse(fs.readFileSync(commandFile, 'utf8'));
}

function connection() {
  const ca = loadPostgresCertificateAuthorityFile(
    requiredEnvironment('QL3_LIVE_POSTGRES_CA_FILE'),
  );
  return createPostgresDatabaseOpener({
    role: 'ai-credential-manager',
    connection: {
      host: requiredEnvironment('QL3_LIVE_POSTGRES_HOST'),
      port: Number(requiredEnvironment('QL3_LIVE_POSTGRES_PORT')),
      database: requiredEnvironment('QL3_LIVE_POSTGRES_DATABASE'),
      user: requiredEnvironment('QL3_LIVE_POSTGRES_USER'),
      password: requiredEnvironment('QL3_LIVE_POSTGRES_PASSWORD'),
      applicationName: 'ql3-provider-credential-test-live-actor',
      tls: {
        mode: 'verify-full',
        servername: requiredEnvironment('QL3_LIVE_POSTGRES_TLS_SERVERNAME'),
        ca,
      },
    },
    pool: {
      max: 1,
      idleTimeoutMs: 1_000,
      connectionTimeoutMs: 5_000,
    },
    onPoolError() {},
  });
}

function subject(command) {
  return Object.freeze({
    type: 'user',
    id: identifier(command.actorId, 'actorId'),
  });
}

function fence() {
  return Object.freeze({ projectVersion: 1, bindingVersion: 1 });
}

async function bind(database, command) {
  if (
    !exact(command, [
      'action',
      'actorId',
      'mutationId',
      'occurredAtMs',
      'projectId',
      'provider',
      'requestId',
      'schemaVersion',
      'secretName',
    ]) ||
    command.schemaVersion !== 1 ||
    command.action !== 'bind'
  ) {
    fail('bind command is invalid');
  }
  const actor = subject(command);
  const projectId = identifier(command.projectId, 'projectId');
  const provider = identifier(command.provider, 'provider');
  const mutationId = uuid(command.mutationId, 'mutationId');
  const occurredAtMs = timestamp(command.occurredAtMs, 'occurredAtMs');
  const binding = Object.freeze({
    schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
    projectId,
    provider,
    revision: 'live-material-v1',
    secretRef: createSecretRef({
      projectId,
      name: identifier(command.secretName, 'secretName'),
    }),
    scheme: 'bearer',
  });
  const catalogCommand = createModelProviderCredentialTransitionCommand({
    schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
    mutationId,
    projectId,
    provider,
    expectedGeneration: 0,
    action: 'bind',
    binding,
    changedBy: actor,
  });
  const result = await new PostgresModelProviderCredentialRepository(
    database.pool,
  ).commitAuthorized({
    command: catalogCommand,
    actor,
    fence: fence(),
    audit: {
      eventId: mutationId,
      requestId: identifier(command.requestId, 'requestId'),
      operationId: modelProviderCredentialAdministrationOperationId('bind'),
      projectId,
      subject: actor,
      authenticationId: `live-bind-${mutationId}`,
      outcome: 'allowed',
      reasons: ['project_owner'],
      fence: fence(),
      occurredAtMs,
    },
  });
  return Object.freeze({
    schemaVersion: 1,
    action: 'bind',
    status: result.status,
    projectId,
    provider,
    generation: result.transition.generation,
    revision: result.transition.binding?.revision ?? null,
  });
}

async function plan(database, command) {
  if (
    !exact(command, [
      'action',
      'actorId',
      'allowlist',
      'expiresAtMs',
      'occurredAtMs',
      'projectId',
      'provider',
      'requestId',
      'schemaVersion',
      'testId',
    ]) ||
    command.schemaVersion !== 1 ||
    command.action !== 'plan'
  ) {
    fail('plan command is invalid');
  }
  const actor = subject(command);
  const projectId = identifier(command.projectId, 'projectId');
  const provider = identifier(command.provider, 'provider');
  const testId = uuid(command.testId, 'testId');
  const occurredAtMs = timestamp(command.occurredAtMs, 'occurredAtMs');
  const allowlist = normalizeModelProviderCredentialTestAllowlist(
    command.allowlist,
  );
  const value = createModelProviderCredentialTestPlan({
    testId,
    requestId: identifier(command.requestId, 'requestId'),
    projectId,
    provider,
    endpoint: resolveModelProviderCredentialTestEndpoint(allowlist, provider),
    requestedBy: actor,
    fence: fence(),
    plannedAtMs: occurredAtMs,
    expiresAtMs: timestamp(command.expiresAtMs, 'expiresAtMs'),
  });
  const result = await new PostgresModelProviderCredentialTestPlanRepository(
    database.pool,
    { quotaWindowMs: 60_000, quotaLimit: 32 },
  ).createAuthorized({
    plan: value,
    audit: {
      eventId: testId,
      requestId: value.requestId,
      operationId: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
      projectId,
      subject: actor,
      authenticationId: `live-plan-${testId}`,
      outcome: 'allowed',
      reasons: ['project_owner'],
      fence: fence(),
      occurredAtMs,
    },
  });
  return Object.freeze({
    schemaVersion: 1,
    action: 'plan',
    status: result.status,
    testId,
    projectId,
    provider,
    planDigest: result.plan.planDigest,
    endpointConfigDigest: result.plan.endpoint.configDigest,
  });
}

async function main() {
  const command = readCommand();
  const openDatabase = connection();
  const database = await openDatabase();
  try {
    const result =
      command.action === 'bind'
        ? await bind(database, command)
        : command.action === 'plan'
        ? await plan(database, command)
        : fail('action is unsupported');
    const serialized = JSON.stringify(result);
    fs.writeFileSync('/dev/termination-log', serialized, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`${serialized}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  const failure = JSON.stringify({
    schemaVersion: 1,
    event: 'live_actor_failed',
    name: error instanceof Error ? error.name : 'Error',
    message:
      error instanceof Error
        ? error.message.slice(0, 1_024)
        : 'unknown actor failure',
  });
  process.stderr.write(`${failure}\n`);
  try {
    fs.writeFileSync('/dev/termination-log', failure, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Kubernetes falls back to the bounded stderr line on actor failure.
  }
  process.exitCode = 1;
});
