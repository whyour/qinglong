#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  createPostgresDatabaseOpener,
  inspectPostgresCertificateAuthorityFile,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  auditPostgresCaOverlapFingerprints,
} = require('./ql3-postgres-ca-overlap-audit.cjs');

const IMAGE = process.env.QL3_TLS_POSTGRES_IMAGE ?? 'postgres:18';
const DATABASE = 'ql3_tls_contract';
const USER = 'postgres';
const PASSWORD = 'postgres';
const SERVERNAME = 'postgres-rw.internal';
const WRONG_SERVERNAME = 'standby.internal';
const COMMAND_TIMEOUT_MS = 120_000;
const IMAGE_PULL_TIMEOUT_MS = 300_000;
const WAIT_TIMEOUT_MS = 30_000;

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
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function runCertificateTool(directory, args) {
  docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--volume',
    `${directory}:/work`,
    '--workdir',
    '/work',
    IMAGE,
    'openssl',
    ...args,
  ]);
}

function createCertificateAuthorities(directory) {
  for (const authority of ['a', 'b']) {
    runCertificateTool(directory, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '2',
      '-nodes',
      '-subj',
      `/CN=QL3 PostgreSQL TLS Test CA ${authority.toUpperCase()}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      `/work/ca-${authority}.key`,
      '-out',
      `/work/ca-${authority}.crt`,
    ]);
  }
  runCertificateTool(directory, [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-subj',
    `/CN=${SERVERNAME}`,
    '-addext',
    `subjectAltName=DNS:${SERVERNAME}`,
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-keyout',
    '/work/server.key',
    '-out',
    '/work/server.csr',
  ]);
  for (const authority of ['a', 'b']) {
    runCertificateTool(directory, [
      'x509',
      '-req',
      '-in',
      '/work/server.csr',
      '-CA',
      `/work/ca-${authority}.crt`,
      '-CAkey',
      `/work/ca-${authority}.key`,
      '-CAcreateserial',
      '-days',
      '2',
      '-sha256',
      '-copy_extensions',
      'copy',
      '-out',
      `/work/server-${authority}.crt`,
    ]);
  }

  const oldBundle = fs.readFileSync(path.join(directory, 'ca-a.crt'), 'utf8');
  const newBundle = fs.readFileSync(path.join(directory, 'ca-b.crt'), 'utf8');
  fs.writeFileSync(
    path.join(directory, 'ca-overlap.crt'),
    `${oldBundle.trim()}\n${newBundle.trim()}\n`,
    { mode: 0o400 },
  );
  activateServerCertificate(directory, 'a');
  for (const fileName of [
    'ca-a.crt',
    'ca-b.crt',
    'ca-overlap.crt',
    'server-a.crt',
    'server-b.crt',
    'active.crt',
  ]) {
    fs.chmodSync(path.join(directory, fileName), 0o400);
  }
  fs.chmodSync(path.join(directory, 'server.key'), 0o600);
}

function activateServerCertificate(directory, generation) {
  const source = path.join(directory, `server-${generation}.crt`);
  const target = path.join(directory, 'active.crt');
  const temporary = path.join(directory, `.active-${process.pid}.crt`);
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, 0o400);
  fs.renameSync(temporary, target);
}

function preparePostgresFileOwnership(directory) {
  const identity = docker([
    'run',
    '--rm',
    IMAGE,
    'sh',
    '-c',
    'id -u postgres; id -g postgres',
  ]).stdout.split(/\s+/);
  if (
    identity.length !== 2 ||
    !identity.every((value) => /^\d+$/.test(value))
  ) {
    throw new Error('cannot resolve PostgreSQL container identity');
  }
  docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--volume',
    `${directory}:/work`,
    IMAGE,
    'chown',
    `${identity[0]}:${identity[1]}`,
    '/work/server.key',
  ]);
}

function mappedPostgresPort(containerName) {
  const output = docker(['port', containerName, '5432/tcp']).stdout;
  const match = output.match(/:(\d+)\s*$/);
  if (!match) throw new Error(`cannot parse mapped PostgreSQL port: ${output}`);
  return Number(match[1]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(operation, description, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
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

async function waitForPostgres(containerName) {
  await waitFor(
    () =>
      docker(
        [
          'exec',
          containerName,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          USER,
          '-d',
          DATABASE,
        ],
        { allowFailure: true },
      ).status === 0,
    'TLS PostgreSQL readiness',
  );
}

function databaseUrl(port) {
  return `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
}

function databaseOpener(port, certificateAuthority, servername, label) {
  return createPostgresDatabaseOpener({
    role: 'runtime',
    connection: {
      connectionString: databaseUrl(port),
      tls: {
        mode: 'verify-full',
        ca: certificateAuthority,
        servername,
      },
    },
    pool: {
      applicationName: `ql3-tls-${label}`,
      maxConnections: 1,
      connectionTimeoutMs: 3_000,
    },
    onPoolError() {},
  });
}

async function inspectTlsConnection(
  port,
  certificateAuthority,
  servername,
  label,
) {
  const database = await databaseOpener(
    port,
    certificateAuthority,
    servername,
    label,
  )();
  try {
    const result = await database.pool.query(`
      SELECT ssl.ssl,
             ssl.version AS "tlsVersion",
             pg_is_in_recovery() AS "inRecovery",
             current_setting('transaction_read_only') AS "transactionReadOnly",
             current_user AS "currentUser",
             current_setting('server_version_num') AS "serverVersionNum"
      FROM pg_stat_ssl ssl
      WHERE ssl.pid = pg_backend_pid()
    `);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0];
    assert.equal(row.ssl, true);
    assert.match(row.tlsVersion, /^TLSv1\.[23]$/);
    assert.equal(row.inRecovery, false);
    assert.equal(row.transactionReadOnly, 'off');
    assert.equal(row.currentUser, USER);
    assert.match(row.serverVersionNum, /^18\d{4}$/);
    return Object.freeze({
      tlsVersion: row.tlsVersion,
      writablePrimary: true,
      serverVersionNum: row.serverVersionNum,
    });
  } finally {
    await database.close();
  }
}

async function expectTlsRejection(
  port,
  certificateAuthority,
  servername,
  label,
) {
  let database;
  try {
    database = await databaseOpener(
      port,
      certificateAuthority,
      servername,
      label,
    )();
    await database.pool.query('SELECT 1');
  } catch (error) {
    return Object.freeze({
      rejected: true,
      code:
        error &&
        typeof error === 'object' &&
        typeof error.code === 'string' &&
        /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : 'TLS_REJECTED',
    });
  } finally {
    await database?.close().catch(() => {});
  }
  throw new Error(`${label} unexpectedly established a TLS connection`);
}

async function reloadCertificate(containerName, directory, generation) {
  activateServerCertificate(directory, generation);
  docker(['kill', '--signal', 'HUP', containerName]);
  await delay(500);
}

async function main() {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const containerName = `ql3-postgres-tls-${suffix}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-postgres-tls-'));
  fs.chmodSync(directory, 0o755);
  let containerStarted = false;
  const startedAt = performance.now();
  try {
    if (
      docker(['image', 'inspect', IMAGE], { allowFailure: true }).status !== 0
    ) {
      docker(['pull', IMAGE], { timeoutMs: IMAGE_PULL_TIMEOUT_MS });
    }
    createCertificateAuthorities(directory);
    preparePostgresFileOwnership(directory);

    const oldInspection = inspectPostgresCertificateAuthorityFile(
      path.join(directory, 'ca-a.crt'),
    );
    const overlapInspection = inspectPostgresCertificateAuthorityFile(
      path.join(directory, 'ca-overlap.crt'),
    );
    const newInspection = inspectPostgresCertificateAuthorityFile(
      path.join(directory, 'ca-b.crt'),
    );
    const overlapContract = auditPostgresCaOverlapFingerprints({
      oldFingerprints: oldInspection.fingerprints256,
      overlapFingerprints: overlapInspection.fingerprints256,
      newFingerprints: newInspection.fingerprints256,
    });

    docker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--env',
      `POSTGRES_DB=${DATABASE}`,
      '--env',
      `POSTGRES_USER=${USER}`,
      '--env',
      `POSTGRES_PASSWORD=${PASSWORD}`,
      '--publish',
      '127.0.0.1::5432',
      '--volume',
      `${directory}:/tls:ro`,
      IMAGE,
      '-c',
      'ssl=on',
      '-c',
      'ssl_cert_file=/tls/active.crt',
      '-c',
      'ssl_key_file=/tls/server.key',
      '-c',
      'ssl_min_protocol_version=TLSv1.2',
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const port = mappedPostgresPort(containerName);

    const oldOnly = await inspectTlsConnection(
      port,
      oldInspection.bundle,
      SERVERNAME,
      'old-only',
    );
    const wrongServername = await expectTlsRejection(
      port,
      oldInspection.bundle,
      WRONG_SERVERNAME,
      'wrong-servername',
    );
    const overlapOnOld = await inspectTlsConnection(
      port,
      overlapInspection.bundle,
      SERVERNAME,
      'overlap-old',
    );

    await reloadCertificate(containerName, directory, 'b');
    const oldAfterRotation = await expectTlsRejection(
      port,
      oldInspection.bundle,
      SERVERNAME,
      'old-after-rotation',
    );
    const newOnly = await inspectTlsConnection(
      port,
      newInspection.bundle,
      SERVERNAME,
      'new-only',
    );
    const overlapOnNew = await inspectTlsConnection(
      port,
      overlapInspection.bundle,
      SERVERNAME,
      'overlap-new',
    );

    await reloadCertificate(containerName, directory, 'a');
    const newAfterRollback = await expectTlsRejection(
      port,
      newInspection.bundle,
      SERVERNAME,
      'new-after-rollback',
    );
    const overlapAfterRollback = await inspectTlsConnection(
      port,
      overlapInspection.bundle,
      SERVERNAME,
      'overlap-rollback',
    );
    const oldAfterRollback = await inspectTlsConnection(
      port,
      oldInspection.bundle,
      SERVERNAME,
      'old-rollback',
    );

    const image = docker([
      'image',
      'inspect',
      '--format',
      '{{.Architecture}} {{index .RepoDigests 0}}',
      IMAGE,
    ]).stdout;
    process.stdout.write(
      `${JSON.stringify({
        contract: 'qinglong/postgresql-tls-rotation@v1',
        image,
        servername: SERVERNAME,
        overlap: overlapContract,
        phases: {
          oldOnly,
          wrongServername,
          overlapOnOld,
          oldAfterRotation,
          newOnly,
          overlapOnNew,
          newAfterRollback,
          overlapAfterRollback,
          oldAfterRollback,
        },
        elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
        limitations: [
          'single PostgreSQL container, not an operator or proxy',
          'SIGHUP certificate reload, not primary promotion or STONITH',
          'host-published Docker port, not a Kubernetes Service or Pod partition',
        ],
        passed: true,
      })}\n`,
    );
  } finally {
    if (containerStarted) {
      docker(['rm', '--force', '--volumes', containerName], {
        allowFailure: true,
      });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      contract: 'qinglong/postgresql-tls-rotation@v1',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
