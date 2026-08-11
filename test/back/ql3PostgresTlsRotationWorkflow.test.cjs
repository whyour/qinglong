'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('keeps the PostgreSQL TLS rotation gate in both native HA jobs', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/ql3-ci.yml'),
    'utf8',
  );
  const job = workflow.match(
    /  cluster-postgres-ha:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:|\s*$)/,
  )?.[0];
  assert.ok(job, 'cluster-postgres-ha job is missing');
  assert.match(job, /runner: ubuntu-24\.04\n\s+arch: x64/);
  assert.match(job, /runner: ubuntu-24\.04-arm\n\s+arch: arm64/);
  const tlsGate = job.indexOf('pnpm test:postgres-tls-rotation:ql3');
  const promotionGate = job.indexOf('pnpm test:postgres-ha:ql3');
  const evidenceAudit = job.indexOf('pnpm audit:postgres-ha-evidence:ql3');
  const evidenceUpload = job.indexOf('Upload PostgreSQL HA evidence');
  assert.ok(tlsGate >= 0, 'TLS rotation gate is missing');
  assert.ok(promotionGate > tlsGate, 'TLS rotation must precede promotion');
  assert.ok(
    evidenceAudit > promotionGate,
    'evidence audit must follow promotion',
  );
  assert.ok(
    evidenceUpload > evidenceAudit,
    'evidence upload must follow audit',
  );
  assert.match(
    job,
    /QL3_HA_REPORT: \$\{\{ runner\.temp \}\}\/ql3-postgres-ha\/report\.json/,
  );
  assert.match(job, /retention-days: 14/);
});

test('builds cluster-postgres before the standalone TLS rotation contract', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['test:postgres-tls-rotation:ql3'],
    'pnpm --filter @qinglong/cluster-postgres build && node scripts/ql3-postgres-tls-rotation-contract.cjs',
  );

  const source = fs.readFileSync(
    path.join(root, 'scripts/ql3-postgres-tls-rotation-contract.cjs'),
    'utf8',
  );
  for (const required of [
    'qinglong/postgresql-tls-rotation@v1',
    'wrongServername',
    'oldAfterRotation',
    'newAfterRollback',
    'pg_stat_ssl',
    'pg_is_in_recovery()',
    "current_setting('transaction_read_only')",
  ]) {
    assert.ok(source.includes(required), `missing TLS evidence: ${required}`);
  }
});
