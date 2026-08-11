const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LocalSqliteRunRepository } = require('../dist');

const FORBIDDEN_SECURITY_METHODS = Object.freeze([
  'resolveProjectPolicy',
  'appendProjectRoleBinding',
  'record',
  'resolveLocalSecretAdministrationMutation',
  'appendAuthorizedLocalSecretEnvelope',
  'appendLocalSecretEnvelope',
  'findLocalSecretEnvelopeByMutation',
  'resolveLocalSecretEnvelopes',
]);

const FORBIDDEN_RUNTIME_CAPABILITY_METHODS = Object.freeze([
  'inspectCandidates',
  'listLocalDispatchCandidates',
  'listLocalExecutionControlCandidates',
  'listLocalActiveExecutions',
  'resolveLocalTaskExecutionRevision',
  'resolveLocalExecutionContextRecipe',
  'appendLocalExecutionContextRecipe',
  'appendLocalTaskExecutionRevision',
  'register',
  'markQuarantined',
  'resolve',
  'listCandidates',
]);

test('Run facade excludes Policy, Audit and Secret authorities', () => {
  for (const method of FORBIDDEN_SECURITY_METHODS) {
    assert.equal(
      Object.hasOwn(LocalSqliteRunRepository.prototype, method),
      false,
      `${method} must remain owned by the Security authority`,
    );
  }

  const declaration = fs.readFileSync(
    path.join(__dirname, '../dist/run/runRepository.d.ts'),
    'utf8',
  );
  for (const method of FORBIDDEN_SECURITY_METHODS) {
    assert.doesNotMatch(declaration, new RegExp(`\\b${method}\\b`, 'u'));
  }
  assert.doesNotMatch(
    declaration,
    /local-secret|project-policy|security-audit|SecurityAuthorityStore/u,
  );

  const runtime = fs.readFileSync(
    path.join(__dirname, '../dist/run/runRepository.js'),
    'utf8',
  );
  assert.doesNotMatch(
    runtime,
    /securityAuthorityStore|local-secret|project-policy|security-audit/u,
  );
});

test('Run repository excludes Dispatch, Control, Recovery and Receipt capabilities', () => {
  for (const method of FORBIDDEN_RUNTIME_CAPABILITY_METHODS) {
    assert.equal(
      Object.hasOwn(LocalSqliteRunRepository.prototype, method),
      false,
      `${method} must remain on its least-authority runtime capability`,
    );
  }

  const declaration = fs.readFileSync(
    path.join(__dirname, '../dist/run/runRepository.d.ts'),
    'utf8',
  );
  for (const method of FORBIDDEN_RUNTIME_CAPABILITY_METHODS) {
    assert.doesNotMatch(declaration, new RegExp(`\\b${method}\\b`, 'u'));
  }
  assert.doesNotMatch(
    declaration,
    /LocalDispatchStore|LocalExecutionControlSource|LocalRunStartupRecoverySource|LocalCompletionReceiptJournal/u,
  );
});
