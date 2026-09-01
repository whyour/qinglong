const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeLocalReconciliationAutomationApplyCommand,
} = require('../dist/deployment/reconciliation/application/automation/applyContract.js');

test('Automation apply requires the target database below deployment authority', () => {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply',
    options: {
      deploymentRoot: '/authority/deployment',
      applicationRoot: '/authority/application',
      automationRoot: '/authority/automation',
      automationDecisionRoot: '/authority/automation-decision',
      automationApplyRoot: '/authority/automation-apply',
      targetDatabasePath: '/authority/deployment/sqlite/qinglong3.sqlite',
      ownerPepperKeyringDirectory: '/authority/deployment/owner-peppers',
      credentialFilePath: '/authority/deployment/owner-credential.json',
      allowRootService:
        typeof process.getuid === 'function' && process.getuid() === 0,
    },
    request: {
      decisionId: '019f8680-143d-7000-8000-000000000471',
      automationId: '019f8680-143d-4000-8000-000000000461',
      expectedDecisionDigest: '1'.repeat(64),
      expectedHeadDigest: '2'.repeat(64),
      mutationId: '019f8680-143d-4000-8000-000000000481',
      requestId: 'bounded-automation-apply',
      appliedAtMs: 1,
    },
  };

  assert.equal(
    normalizeLocalReconciliationAutomationApplyCommand(command).options
      .targetDatabasePath,
    command.options.targetDatabasePath,
  );
  assert.throws(
    () =>
      normalizeLocalReconciliationAutomationApplyCommand({
        ...command,
        options: {
          ...command.options,
          targetDatabasePath: '/authority/outside.sqlite',
        },
      }),
    /must be below deploymentRoot/,
  );
});
