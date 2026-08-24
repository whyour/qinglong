require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');
const {
  registerRunRepositoryContract,
} = require('../../../test/contracts/runRepositoryContract.cjs');
const {
  registerPluginPackageInstallRepositoryContract,
} = require('../../../test/contracts/pluginPackageInstallRepositoryContract.cjs');
const {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  ClusterControlRecoveryFenceLostError,
  ClusterControlRecoverySupervisor,
  EvidenceBasedClusterControlRecoveryProcessor,
  MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
  MAX_RUN_EVENT_PAGE_SIZE,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  RunEventPayloadTooLargeError,
  RunDispatchLeaseFenceRejectedError,
} = require('@qinglong/runtime-core');
const {
  WorkerExecutionAttestationFenceRejectedError,
} = require('@qinglong/runtime-core/worker-attestation');
const {
  assertPostgresSchemaReady,
  createPostgresDatabaseOpener,
  PostgresApiCredentialRepository,
  PostgresClusterControlRecoveryClaimRepository,
  PostgresClusterControlRecoveryResolutionRepository,
  PostgresClusterControlRecoverySource,
  PostgresClusterRunCancellationConvergenceRepository,
  PostgresCancellationDispatchRepository,
  PostgresClusterScheduleRepository,
  PostgresProjectPolicyRepository,
  PostgresRunRepository,
  PostgresRunDispatchLeaseRepository,
  PostgresSecurityAuditRepository,
  PostgresWorkerSessionRepository,
  PostgresRemoteWorkerAttestationEvidenceProvider,
} = require('../dist/entrypoints/runtime');
const {
  CancellationDispatchBindingConflictError,
  CancellationDispatchFenceRejectedError,
  digestCancellationDispatchLeaseToken,
} = require('@qinglong/runtime-core/cancellation-dispatch');
const {
  PostgresTaskDefinitionRepository,
  PostgresTriggerRepository,
} = require('../dist/entrypoints/admin');
const {
  assertPostgresAutomationManagerSchemaReady,
  PostgresTaskDefinitionAdministrationRepository,
  PostgresTriggerAdministrationRepository,
} = require('../dist/entrypoints/automationManager');
const {
  assertPostgresPackageManagerSchemaReady,
  PostgresPluginPackagePublisherTrustAuthorityRepository,
} = require('../dist/entrypoints/packageManager');
const {
  assertPostgresPackageExecutorSchemaReady,
  PostgresPluginPackagePublisherProvenanceRepository,
  PostgresPluginPackageTaskReconciliationRepository,
  PostgresPluginPackagePublisherTrustTransitionProposalRepository,
  PostgresPluginPackagePublisherTrustTransitionRepository,
  PostgresProjectToolDefinitionSnapshotRepository,
} = require('../dist/entrypoints/packageExecutor');
const {
  resolveClusterScheduleDecision,
} = require('@qinglong/runtime-core/cluster-scheduler');
const {
  PostgresClusterLegacyEnvMigrationPlanRepository,
} = require('../dist/reconciliation/clusterLegacyEnvMigrationPlanRepository');
const {
  PostgresClusterLegacyEnvMigrationApplicationRepository,
} = require('../dist/reconciliation/clusterLegacyEnvMigrationApplicationRepository');
const {
  InvalidClusterLegacyEnvMigrationApplicationError,
  createClusterLegacyEnvMigrationTaskMutationSetDigester,
  createClusterLegacyEnvMigrationTriggerMutationSetDigester,
} = require('@qinglong/runtime-core/cluster-legacy-env-migration-application');

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / 60_000 + 1) * 60_000;
}

const {
  assertPostgresWorkerIngressSchemaReady,
  PostgresWorkerCredentialRepository,
  PostgresWorkerExecutionAttestationRepository,
} = require('../dist/entrypoints/workerIngress');
const {
  ProjectRoleBindingVersionConflictError,
} = require('@qinglong/runtime-core/project-policy');
const {
  postgresqlMainMigrationStream,
  readPostgresMigrationHistory,
  runPostgresMigrations,
} = require('../dist/migration/migration');
const {
  PostgresPluginPackageInstallRepository,
} = require('../dist/plugin-package/installation/pluginPackageInstallRepository');
const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  createPluginPackagePublisherTrustTransitionProposal,
  PluginPackagePublisherTrustTransitionConflictError,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');
const {
  createPluginPackagePublisherProvenance,
  PluginPackagePublisherProvenanceConflictError,
} = require('@qinglong/runtime-core/plugin-package-publisher-provenance');
const {
  PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
} = require('@qinglong/runtime-core/plugin-package-admission');
const {
  pluginPackageInstallActionDigest,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallCommit,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createPluginPackageInstallProposal,
  resolvePluginPackageInstallProposal,
} = require('@qinglong/runtime-core/plugin-package-proposal');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  PostgresApprovalRequestRepository,
} = require('../dist/approved-action/approvalRequestRepository');
const {
  PostgresApprovedActionExecutionRepository,
} = require('../dist/approved-action/approvedActionExecutionRepository');
const {
  PostgresPluginPackageInstallProposalRepository,
} = require('../dist/plugin-package/installation/pluginPackageProposalRepository');
const {
  PostgresPluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/installation/pluginPackageMaterializedRevisionRepository');
const {
  PostgresPluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/publication/pluginPackageAutomationPublicationRepository');
const {
  materializedRevisionFixture,
} = require('../../../test/contracts/pluginPackageMaterializedRevisionRepositoryContract.cjs');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
  publisherProvenanceInstallRepository,
  registerPluginPackageTaskReconciliationRepositoryContract,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  pluginPackageAutomationPublicationFixture,
  registerPluginPackageAutomationPublicationRepositoryContract,
} = require('../../../test/contracts/pluginPackageAutomationPublicationRepositoryContract.cjs');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  PostgresPluginPackageWorkflowAdmissionRepository,
} = require('@qinglong/cluster-postgres/plugin-package-workflow-admission');
const {
  PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository,
} = require('@qinglong/cluster-postgres/plugin-package-workflow-task-attempt-admission');
const {
  PostgresTaskStartRepository,
} = require('@qinglong/cluster-postgres/task-start');
const {
  registerProjectToolDefinitionSnapshotRepositoryContract,
} = require('../../../test/contracts/projectToolDefinitionSnapshotRepositoryContract.cjs');
const {
  createStepRunMutation,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  PostgresStepRunRepository,
} = require('@qinglong/cluster-postgres/step-run');
const {
  TOOL_EXECUTION_START_AUDIT_OPERATION,
  createToolExecutionEvidenceBundle,
  toolExecutionAdmissionEvidence,
} = require('@qinglong/runtime-core/tool-execution-evidence');
const {
  PostgresToolExecutionEvidenceRepository,
} = require('@qinglong/cluster-postgres/tool-execution-evidence');
const {
  createPluginPackageResourceGenerationFromReferences,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
const {
  createPluginPackageSecretBindingApprovalPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PostgresPluginPackageSecretBindingApprovalPlanReader,
  PostgresPluginPackageSecretBindingApprovalPlanRepository,
} = require('../dist/plugin-package/secret-binding/pluginPackageSecretBindingApprovalPlanRepository');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionRegistry,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  TrustedToolHandlerBindingRegistry,
  admitTrustedToolExecution,
  createTrustedToolHandlerBinding,
  createTrustedToolInvocationPlan,
  trustedToolContractIdentityDigest,
} = require('@qinglong/runtime-core/trusted-tool-invocation');
const {
  prepareToolInvocation,
} = require('@qinglong/runtime-core/tool-registry');
const {
  createToolExecutionStartCommand,
} = require('@qinglong/runtime-core/tool-execution-start-barrier');
const {
  PostgresToolExecutionStartBarrierRepository,
} = require('@qinglong/cluster-postgres/tool-execution-start-barrier');
const {
  PostgresToolInvocationArtifactRepository,
} = require('@qinglong/cluster-postgres/tool-invocation-artifact');
const {
  ToolExecutionCompletionConflictError,
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
  toolExecutionResultKeyBinding,
} = require('@qinglong/runtime-core/tool-execution-completion');
const {
  TOOL_EXECUTION_FAILURE_FACTS,
  createToolExecutionFailureCompletionCommand,
  createToolExecutionFailureResult,
} = require('@qinglong/runtime-core/tool-execution-failure-completion');
const {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
} = require('@qinglong/runtime-core/trusted-tool-execution');
const {
  PostgresToolExecutionCompletionRepository,
} = require('@qinglong/cluster-postgres/tool-execution-completion');
const {
  PostgresToolExecutionFailureCompletionRepository,
} = require('@qinglong/cluster-postgres/tool-execution-failure-completion');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('@qinglong/runtime-core/tool-result-key-catalog');
const {
  createToolExecutionResultRekeyCommand,
  createToolResultKeyRetirementReceiptCommand,
} = require('@qinglong/runtime-core/tool-result-rekey');
const {
  PostgresToolResultKeyCatalogReader,
  PostgresToolResultKeyCatalogRepository,
} = require('../dist/tool-execution/toolResultKeyCatalogRepository');
const {
  PostgresToolResultRekeyReader,
  PostgresToolResultRekeyRepository,
} = require('../dist/tool-execution/toolResultRekeyRepository');

const APPROVAL_REQUESTER = Object.freeze({
  type: 'user',
  id: 'usr_approval_integration',
});
const APPROVAL_DISPATCHER = Object.freeze({
  type: 'system',
  id: 'approved-dispatcher',
});
const APPROVAL_FENCE = Object.freeze({
  projectVersion: 1,
  bindingVersion: 1,
});
const APPROVAL_ACTION = Object.freeze({
  permission: 'package.manage',
  actionType: 'plugin_package.install',
  actionRef: 'proposal:integration-package-v1',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});

function admissionPackageAction() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'postgres-monitor',
      displayName: 'PostgreSQL Monitor',
      version: '1.2.0',
      description: 'One bounded integration package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['cluster-control'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [{ name: 'TOKEN', required: true }],
        tools: ['secret.use'],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  return {
    input: {
      lockId: 'proposal-postgres-monitor-v1',
      projectId: 'default',
      manifest,
      plan,
      environment,
      source: {
        kind: 'oci',
        locator: `oci://registry.example.test/qinglong/postgres-monitor@sha256:${'a'.repeat(
          64,
        )}`,
        artifactDigest: 'a'.repeat(64),
        artifactBytes: 2048,
        contentDigest: 'b'.repeat(64),
      },
      architecture: 'arm64',
      deploymentProfile: 'cluster-control',
      targetGeneration: 1,
    },
    plan,
  };
}

function approvalAudit(
  eventId,
  operationId,
  subject,
  authenticationId,
  outcome,
  occurredAtMs,
) {
  return {
    eventId,
    requestId: 'request-postgres-integration-1',
    operationId,
    projectId: 'default',
    subject,
    authenticationId,
    outcome,
    reasons: [
      outcome === 'approval_required' ? 'package_review' : 'role_grant',
    ],
    fence: APPROVAL_FENCE,
    occurredAtMs,
  };
}

const TOOL_START_PROJECT_ID = 'tool-start-project';
const TOOL_START_RUN_ID = '32000000-0000-4000-8000-000000000001';
const TOOL_START_SUBJECT = Object.freeze({
  type: 'user',
  id: 'usr-tool-start-integration',
});
const TOOL_START_FENCE = Object.freeze({
  projectVersion: 3,
  bindingVersion: 7,
});
const TOOL_START_AT_MS = 3_400;
const TOOL_RESULT_AT_MS = 3_500;
const TOOL_OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const TOOL_RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);

function toolExecutionResult(barrier, output) {
  const outputDigest = createHash('sha256')
    .update(TOOL_OUTPUT_DIGEST_DOMAIN)
    .update(JSON.stringify(output))
    .digest('hex');
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: barrier.startId,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    output,
    outputDigest,
    completedAtMs: TOOL_RESULT_AT_MS,
  });
  return Object.freeze({
    ...unsigned,
    resultDigest: createHash('sha256')
      .update(TOOL_RESULT_DIGEST_DOMAIN)
      .update(JSON.stringify(unsigned))
      .digest('hex'),
  });
}

function integrationToolSnapshot() {
  const generation = createPluginPackageResourceGenerationFromReferences({
    installationId: 'install-tool-start-integration',
    projectId: TOOL_START_PROJECT_ID,
    packageName: 'integration',
    lockDigest: '8'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: '9'.repeat(64),
    resources: [],
  });
  return createProjectToolDefinitionSnapshot({
    projectId: TOOL_START_PROJECT_ID,
    contributions: [
      {
        generation,
        revisionDigest: 'a'.repeat(64),
        definitions: [
          {
            name: 'integration.compare',
            version: '1.0.0',
            description: 'Compare one bounded integration Run',
            inputSchema: {
              type: 'object',
              properties: {
                runId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['runId'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: {
                summary: { type: 'string', maxLength: 1024 },
              },
              required: ['summary'],
              additionalProperties: false,
            },
            effect: 'read',
            risk: 'low',
            requiredPermissions: ['run.read'],
            timeoutSeconds: 30,
          },
        ],
      },
    ],
  });
}

function integrationToolPrincipal() {
  return {
    subject: TOOL_START_SUBJECT,
    authenticationId: 'auth-tool-start-integration',
    authenticatedAtMs: 2_800,
    expiresAtMs: 10_000,
    assurance: 'multi_factor',
  };
}

function integrationToolAuthorizer() {
  return {
    async authorize() {
      return {
        effect: 'allow',
        reasons: ['role_grant'],
        fence: TOOL_START_FENCE,
      };
    },
  };
}

async function integrationToolStartCommand(readyStepRun) {
  const snapshot = integrationToolSnapshot();
  const binding = createTrustedToolHandlerBinding(snapshot, {
    tool: { name: 'integration.compare', version: '1.0.0' },
    adapter: { id: 'builtin.integration-compare', version: '1.0.0' },
    executionClass: 'builtin_in_process',
    profiles: ['cluster-control'],
    authorities: ['database.read'],
    timeoutSeconds: 20,
    redactionContract: {
      id: 'redaction.integration-compare',
      version: '1.0.0',
    },
    auditContract: {
      id: 'audit.tool-call',
      version: '1.0.0',
    },
  });
  assert.equal(binding.definitionDigest, readyStepRun.definitionDigest);
  const bindings = new TrustedToolHandlerBindingRegistry(snapshot, [binding]);
  const invocation = await prepareToolInvocation(
    projectToolDefinitionRegistry(snapshot),
    {
      projectId: TOOL_START_PROJECT_ID,
      principal: integrationToolPrincipal(),
      nowMs: 2_900,
      tool: { name: 'integration.compare', version: '1.0.0' },
      input: { runId: TOOL_START_RUN_ID },
    },
    integrationToolAuthorizer(),
  );
  const planBundle = createTrustedToolInvocationPlan(bindings, invocation, {
    actionRef: `tool-plan:${TOOL_START_RUN_ID}`,
    inputArtifactId: 'artifact-input-integration-001',
    previewArtifactId: 'artifact-preview-integration-001',
    artifactKeyId: 'tool-key-test',
    artifactKey: Buffer.alloc(32, 7),
    artifactNonce: Buffer.alloc(12, 9),
    profile: 'cluster-control',
    preview: {
      title: 'Compare integration Run',
      summary: 'Reads one bounded Run projection',
      fields: [
        {
          kind: 'identifier',
          label: 'Run',
          value: TOOL_START_RUN_ID,
        },
      ],
      warnings: [],
    },
    sealedAtMs: 3_000,
  });
  const plan = planBundle.plan;
  const evidence = createToolExecutionEvidenceBundle({
    traceId: '3'.repeat(32),
    spanId: '4'.repeat(16),
    projectId: TOOL_START_PROJECT_ID,
    runId: TOOL_START_RUN_ID,
    stepRunId: readyStepRun.id,
    invocationPlanDigest: plan.planDigest,
    bindingDigest: binding.bindingDigest,
    adapterDigest: trustedToolContractIdentityDigest(binding.adapter),
    redactionContractDigest: trustedToolContractIdentityDigest(
      binding.redactionContract,
    ),
    auditContractDigest: trustedToolContractIdentityDigest(
      binding.auditContract,
    ),
    audit: {
      eventId: '32000000-0000-4000-8000-000000000004',
      requestId: 'tool-start-request-integration',
      operationId: TOOL_EXECUTION_START_AUDIT_OPERATION,
      projectId: TOOL_START_PROJECT_ID,
      subject: TOOL_START_SUBJECT,
      authenticationId: 'auth-tool-start-integration',
      outcome: 'allowed',
      reasons: ['tool_execution_start'],
      fence: TOOL_START_FENCE,
      occurredAtMs: TOOL_START_AT_MS,
    },
    createdAtMs: TOOL_START_AT_MS,
  });
  const admission = await admitTrustedToolExecution(bindings, plan, {
    principal: integrationToolPrincipal(),
    profile: 'cluster-control',
    nowMs: TOOL_START_AT_MS,
    authorizer: integrationToolAuthorizer(),
    evidence: {
      stepRun: {
        id: readyStepRun.id,
        version: readyStepRun.version,
        digest: readyStepRun.stepRunDigest,
      },
      ...toolExecutionAdmissionEvidence(evidence),
    },
  });
  const mutation = transitionStepRunMutation(
    readyStepRun,
    {
      expectedVersion: readyStepRun.version,
      expectedDigest: readyStepRun.stepRunDigest,
      mutationId: 'postgres-tool-start-running-002',
      to: 'running',
      atMs: TOOL_START_AT_MS,
    },
    {
      expectedRunVersion: 1,
      expectedRunEventSequence: 1,
      eventId: '32000000-0000-4000-8000-000000000003',
      dedupeKey: 'tool-start:running',
      actor: TOOL_START_SUBJECT,
    },
  );
  return Object.freeze({
    command: createToolExecutionStartCommand({
      startId: 'postgres-tool-start-001',
      admission,
      evidence,
      stepRunMutation: mutation,
    }),
    inputArtifact: planBundle.inputArtifact,
    previewArtifact: planBundle.previewArtifact,
    registry: bindings.definitionRegistry(),
  });
}

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const runtimeConnectionString =
  process.env.QL3_TEST_POSTGRES_RUNTIME_URL ?? migrationConnectionString;
const adminConnectionString =
  process.env.QL3_TEST_POSTGRES_ADMIN_URL ?? migrationConnectionString;
const automationManagerConnectionString =
  process.env.QL3_TEST_POSTGRES_AUTOMATION_MANAGER_URL ??
  migrationConnectionString;
const runManagerConnectionString =
  process.env.QL3_TEST_POSTGRES_RUN_MANAGER_URL ?? migrationConnectionString;
const packageManagerConnectionString =
  process.env.QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL ??
  migrationConnectionString;
const packageExecutorConnectionString =
  process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL ??
  migrationConnectionString;
const workerIngressConnectionString =
  process.env.QL3_TEST_POSTGRES_WORKER_INGRESS_URL ?? migrationConnectionString;

const contractPublisherKeyPair = generateKeyPairSync('ed25519');
const contractPublisherTrustSnapshot =
  createPluginPackagePublisherTrustSnapshot([
    {
      publisher: 'packages.contract.qinglong.dev',
      keyId: 'contract-key-1',
      publicKeyPem: contractPublisherKeyPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      notBeforeMs: 0,
      notAfterMs: 100_000,
    },
  ]);

async function observeContractPublisherTrust(pool) {
  await new PostgresPluginPackagePublisherTrustAuthorityRepository(
    pool,
  ).observeSnapshot({
    authorityId: 'cluster',
    observedBy: 'postgres-contract',
    observedAtMs: 1,
    snapshot: contractPublisherTrustSnapshot,
  });
}

test('Cluster Legacy Env application rejects accessor stream factories before PostgreSQL', async () => {
  let getterCalls = 0;
  let connectCalls = 0;
  const repository = new PostgresClusterLegacyEnvMigrationApplicationRepository(
    {
      async query() {
        throw new Error('query must not be called');
      },
      async connect() {
        connectCalls += 1;
        throw new Error('connect must not be called');
      },
    },
  );
  const streams = {};
  for (const name of ['taskMutations', 'triggerMutations']) {
    Object.defineProperty(streams, name, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => [];
      },
    });
  }
  await assert.rejects(
    repository.apply(
      {
        applicationId: 'accessor-stream-application',
        mutationId: '10000000-0000-4000-8000-000000000001',
        projectId: 'accessor-stream-project',
        planId: 'accessor-stream-plan',
        planDigest: '1'.repeat(64),
        taskMutationSetDigest: '2'.repeat(64),
        triggerMutationSetDigest: '3'.repeat(64),
      },
      streams,
    ),
    InvalidClusterLegacyEnvMigrationApplicationError,
  );
  assert.equal(getterCalls, 0);
  assert.equal(connectCalls, 0);
});

if (!migrationConnectionString) {
  test('PostgreSQL integration requires QL3_TEST_POSTGRES_URL', {
    skip: true,
  });
} else {
  const onPoolError = (error) => {
    throw error;
  };

  async function open(role) {
    const connectionString =
      role === 'migration'
        ? migrationConnectionString
        : role === 'admin'
        ? adminConnectionString
        : role === 'automation-manager'
        ? automationManagerConnectionString
        : role === 'run-manager'
        ? runManagerConnectionString
        : role === 'package-manager'
        ? packageManagerConnectionString
        : role === 'package-executor'
        ? packageExecutorConnectionString
        : role === 'worker-ingress'
        ? workerIngressConnectionString
        : runtimeConnectionString;
    return createPostgresDatabaseOpener({
      role,
      connection: {
        connectionString,
        tls: { mode: 'disable' },
      },
      pool: {
        maxConnections: role === 'migration' ? 1 : 4,
        applicationName: `ql3-contract-${role}`,
      },
      onPoolError,
    })();
  }

  test(
    'active query connection loss reports availability and preserves the rejection',
    {
      skip:
        runtimeConnectionString !== migrationConnectionString
          ? 'requires one role that can observe and terminate its own backend'
          : false,
    },
    async () => {
      const migrationDatabase = await open('migration');
      const observed = [];
      const runtimeDatabase = await createPostgresDatabaseOpener({
        role: 'runtime',
        connection: {
          connectionString: runtimeConnectionString,
          tls: { mode: 'disable' },
        },
        pool: {
          maxConnections: 1,
          applicationName: 'ql3-contract-active-query-failure',
        },
        onPoolError(error) {
          observed.push(error);
        },
      })();
      try {
        const activeQuery = runtimeDatabase.pool.query(
          'SELECT pg_sleep(10) AS slept',
        );
        let backend;
        const deadline = Date.now() + 5_000;
        do {
          backend = await migrationDatabase.pool.query(
            `SELECT pid
             FROM pg_stat_activity
            WHERE application_name = 'ql3-contract-active-query-failure'
              AND state = 'active'
              AND query LIKE 'SELECT pg_sleep(%'
            LIMIT 1`,
          );
          if (backend.rowCount === 1) break;
          if (Date.now() >= deadline) {
            throw new Error('timed out waiting for active PostgreSQL query');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (true);

        const terminated = await migrationDatabase.pool.query(
          'SELECT pg_terminate_backend($1) AS terminated',
          [backend.rows[0].pid],
        );
        assert.equal(terminated.rows[0].terminated, true);
        let queryError;
        await assert.rejects(activeQuery, (error) => {
          queryError = error;
          return error?.code === '57P01';
        });
        assert.equal(observed.includes(queryError), true);
      } finally {
        await runtimeDatabase.close();
        await migrationDatabase.close();
      }
    },
  );

  registerRunRepositoryContract({
    name: 'PostgreSQL pg.Pool binding',
    defaultExecutionOwner: 'runtime',
    contract: {
      DuplicateIdempotencyKeyError,
      DuplicateRunAttemptError,
      DuplicateRunEventError,
      RunEventPayloadTooLargeError,
      MAX_CANCELLATION_RECOVERY_PAGE_SIZE,
      MAX_RUN_EVENT_PAGE_SIZE,
      MAX_RUN_EVENT_PAYLOAD_BYTES,
    },
    async createRepository() {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await migrationDatabase.pool.query(
          'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
        );
      } finally {
        await migrationDatabase.close();
      }

      const runtimeDatabase = await open('runtime');
      return {
        repository: new PostgresRunRepository(runtimeDatabase.pool),
        close: () => runtimeDatabase.close(),
      };
    },
  });

  test('PostgreSQL cancellation dispatch fences replicas with database time and atomic events', async () => {
    const runId = '019f7300-0000-7000-8000-000000000901';
    const attemptId = '019f7300-0000-7000-8000-000000000902';
    const secondAttemptId = '019f7300-0000-7000-8000-000000000903';
    const duplicateEventId = '019f7300-0000-7000-8000-000000000904';
    const retryEventId = '019f7300-0000-7000-8000-000000000905';
    const terminalEventId = '019f7300-0000-7000-8000-000000000906';
    const requestedAtMs = 1_750_000_000_100;
    const migrationDatabase = await open('migration');
    let firstDatabase;
    let secondDatabase;
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      const before = await migrationDatabase.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS "nowMs"`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, created_at_ms, started_at_ms,
           cancel_requested_at_ms, cancel_reason
         ) VALUES (
           $1, 'default', 'cancellation-integration', 'v1', 'manual',
           'api', 'runtime', 'running', 2, 0, $2, $2, $3, 'user'
         )`,
        [runId, requestedAtMs - 100, requestedAtMs],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type, callback_sequence,
           created_at_ms
         ) VALUES ($1, $2, 1, 'running', 'local_process', 0, $3)`,
        [attemptId, runId, requestedAtMs - 50],
      );

      [firstDatabase, secondDatabase] = await Promise.all([
        open('runtime'),
        open('runtime'),
      ]);
      const firstRepository = new PostgresCancellationDispatchRepository(
        firstDatabase.pool,
      );
      const secondRepository = new PostgresCancellationDispatchRepository(
        secondDatabase.pool,
      );
      const candidate = {
        runId,
        attemptId,
        requestedAtMs,
        leaseDurationMs: 10_000,
      };
      const [firstClaim, secondClaim] = await Promise.all([
        firstRepository.claim({
          ...candidate,
          owner: 'primary-a',
          leaseToken: 'lease-a',
        }),
        secondRepository.claim({
          ...candidate,
          owner: 'primary-b',
          leaseToken: 'lease-b',
        }),
      ]);
      const claimed = [firstClaim, secondClaim].find(
        (result) => result.status === 'claimed',
      );
      const competing = [firstClaim, secondClaim].find(
        (result) => result.status !== 'claimed',
      );
      assert.equal(claimed?.status, 'claimed');
      assert.equal(competing?.status, 'leased');
      assert.equal(claimed.dispatch.version, 1);
      assert.equal(claimed.dispatch.dispatchCount, 1);
      assert.equal(
        claimed.dispatch.createdAtMs >= Number(before.rows[0].nowMs),
        true,
      );
      const rawLeaseToken = claimed.leaseToken;
      const stored = await migrationDatabase.pool.query(
        `SELECT lease_token_digest AS "leaseTokenDigest",
                lease_owner AS "leaseOwner", version, dispatch_count
                AS "dispatchCount"
           FROM "ql3"."run_cancellation_dispatches" WHERE run_id = $1`,
        [runId],
      );
      assert.equal(
        stored.rows[0].leaseTokenDigest,
        digestCancellationDispatchLeaseToken(rawLeaseToken),
      );
      assert.notEqual(stored.rows[0].leaseTokenDigest, rawLeaseToken);

      await migrationDatabase.pool.query(
        `UPDATE "ql3"."run_cancellation_dispatches"
            SET lease_expires_at_ms = 0 WHERE run_id = $1`,
        [runId],
      );
      const takeover = await secondRepository.claim({
        ...candidate,
        owner: 'primary-takeover',
        leaseToken: 'lease-takeover',
      });
      assert.equal(takeover.status, 'claimed');
      assert.equal(takeover.dispatch.version, 2);
      assert.equal(takeover.dispatch.dispatchCount, 2);
      await assert.rejects(
        firstRepository.recordResult({
          runId,
          attemptId,
          owner: claimed.dispatch.leaseOwner,
          leaseToken: rawLeaseToken,
          expectedVersion: claimed.dispatch.version,
          result: 'already_exited',
          eventId: terminalEventId,
        }),
        CancellationDispatchFenceRejectedError,
      );

      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_events" (
           id, run_id, sequence, type, dedupe_key, actor_type, payload,
           created_at_ms
         ) VALUES ($1, $2, 99, 'fixture.event', 'fixture-event', 'system',
                   '{}'::jsonb, $3)`,
        [duplicateEventId, runId, requestedAtMs],
      );
      await assert.rejects(
        secondRepository.recordResult({
          runId,
          attemptId,
          owner: 'primary-takeover',
          leaseToken: 'lease-takeover',
          expectedVersion: takeover.dispatch.version,
          result: 'dispatch_error',
          retryDelayMs: 1_000,
          eventId: duplicateEventId,
        }),
      );
      const rolledBack = await migrationDatabase.pool.query(
        `SELECT dispatch.status, dispatch.version, run.version AS "runVersion",
                run.event_sequence AS "eventSequence"
           FROM "ql3"."run_cancellation_dispatches" dispatch
           JOIN "ql3"."runs" run ON run.id = dispatch.run_id
          WHERE dispatch.run_id = $1`,
        [runId],
      );
      assert.deepEqual(rolledBack.rows, [
        { status: 'leased', version: 2, runVersion: 2, eventSequence: 0 },
      ]);

      const retry = await secondRepository.recordResult({
        runId,
        attemptId,
        owner: 'primary-takeover',
        leaseToken: 'lease-takeover',
        expectedVersion: takeover.dispatch.version,
        result: 'dispatch_error',
        retryDelayMs: 60_000,
        eventId: retryEventId,
      });
      assert.equal(retry.dispatch.status, 'retry_wait');
      assert.equal(retry.event.type, 'run.cancel_dispatch_failed');
      assert.equal(
        (
          await firstRepository.claim({
            ...candidate,
            owner: 'primary-a',
            leaseToken: 'lease-a-retry',
          })
        ).status,
        'not_due',
      );
      await migrationDatabase.pool.query(
        `UPDATE "ql3"."run_cancellation_dispatches"
            SET next_attempt_at_ms = 0 WHERE run_id = $1`,
        [runId],
      );
      const finalLease = await firstRepository.claim({
        ...candidate,
        owner: 'primary-final',
        leaseToken: 'lease-final',
      });
      assert.equal(finalLease.status, 'claimed');
      assert.equal(finalLease.dispatch.dispatchCount, 3);

      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type, callback_sequence,
           created_at_ms
         ) VALUES ($1, $2, 2, 'running', 'local_process', 0, $3)`,
        [secondAttemptId, runId, requestedAtMs],
      );
      await assert.rejects(
        secondRepository.claim({
          ...candidate,
          attemptId: secondAttemptId,
          owner: 'primary-conflict',
          leaseToken: 'lease-conflict',
        }),
        CancellationDispatchBindingConflictError,
      );

      const terminal = await firstRepository.recordResult({
        runId,
        attemptId,
        owner: 'primary-final',
        leaseToken: 'lease-final',
        expectedVersion: finalLease.dispatch.version,
        result: 'already_exited',
        eventId: terminalEventId,
      });
      assert.equal(terminal.dispatch.status, 'dispatched');
      assert.equal(terminal.event.sequence, 2);
      assert.deepEqual(terminal.event.payload, {
        attempt_id: attemptId,
        dispatch_count: 3,
        result: 'already_exited',
      });
      const durable = await migrationDatabase.pool.query(
        `SELECT dispatch.status, dispatch.lease_token_digest AS "leaseDigest",
                dispatch.dispatch_count AS "dispatchCount",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence"
           FROM "ql3"."run_cancellation_dispatches" dispatch
           JOIN "ql3"."runs" run ON run.id = dispatch.run_id
          WHERE dispatch.run_id = $1`,
        [runId],
      );
      assert.deepEqual(durable.rows, [
        {
          status: 'dispatched',
          leaseDigest: null,
          dispatchCount: 3,
          runVersion: 4,
          eventSequence: 2,
        },
      ]);
    } finally {
      await Promise.allSettled([
        firstDatabase?.close(),
        secondDatabase?.close(),
      ]);
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL Task Start atomically persists and exactly replays one Run aggregate', async () => {
    const projectId = 'task-start-integration';
    const taskId = 'task-start-command';
    const subjectId = 'usr_task_start_integration';
    const migrationDatabase = await open('migration');
    let runManagerDatabase;
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."projects" WHERE id = $1`,
        [projectId],
      );
      const observed = await migrationDatabase.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS "observedAtMs"`,
      );
      const occurredAtMs = Number(observed.rows[0].observedAtMs) - 1_000;
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, 'Task Start Integration', $1, 'active', 1, $2, $2)`,
        [projectId, occurredAtMs],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES ($1, 'user', $2, 1, 'active', 'operator', $3,
                   'user', $2, $4)`,
        [
          projectId,
          subjectId,
          '019f7300-0000-7000-8000-000000000899',
          occurredAtMs,
        ],
      );
      const definition = (
        await new PostgresTaskDefinitionRepository(
          migrationDatabase.pool,
        ).appendTaskDefinitionRevision({
          projectId,
          taskId,
          expectedRevision: null,
          mutationId: '019f7300-0000-7000-8000-000000000898',
          name: 'Task Start Integration',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: {
                kind: 'argv',
                file: '/bin/echo',
                args: ['task-start'],
              },
            },
          },
          labels: {},
          enabled: true,
          occurredAtMs: occurredAtMs + 1,
        })
      ).definition;

      runManagerDatabase =
        runManagerConnectionString === migrationConnectionString
          ? migrationDatabase
          : await open('run-manager');
      const repository = new PostgresTaskStartRepository(
        runManagerDatabase.pool,
      );
      const command = {
        projectId,
        taskId,
        mutationId: '019f7300-0000-7000-8000-000000000800',
        expectedRevision: definition.revision,
        expectedContentDigest: definition.contentDigest,
        runId: '019f7300-0000-7000-8000-000000000801',
        attemptId: '019f7300-0000-7000-8000-000000000802',
        createdEventId: '019f7300-0000-7000-8000-000000000803',
        queuedEventId: '019f7300-0000-7000-8000-000000000804',
        subject: { type: 'user', id: subjectId },
        policyFence: { projectVersion: 1, bindingVersion: 1 },
      };
      const accepted = await repository.startTask(command);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.runStatus, 'queued');
      assert.equal(accepted.executorType, 'remote_worker');
      assert.equal(accepted.taskContentDigest, definition.contentDigest);
      const replay = await repository.startTask({
        ...command,
        runId: '019f7300-0000-7000-8000-000000000811',
        attemptId: '019f7300-0000-7000-8000-000000000812',
        createdEventId: '019f7300-0000-7000-8000-000000000813',
        queuedEventId: '019f7300-0000-7000-8000-000000000814',
      });
      assert.equal(replay.status, 'existing');
      assert.equal(replay.runId, accepted.runId);
      assert.equal(replay.attemptId, accepted.attemptId);
      const durable = await migrationDatabase.pool.query(
        `SELECT run.status, run.version,
                run.event_sequence AS "eventSequence", run.trigger_type,
                attempt.status AS "attemptStatus",
                count(event.id)::int AS "eventCount"
         FROM "ql3"."runs" AS run
         JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
         JOIN "ql3"."run_events" AS event ON event.run_id = run.id
         WHERE run.id = $1
         GROUP BY run.id, attempt.id`,
        [accepted.runId],
      );
      assert.deepEqual(durable.rows, [
        {
          status: 'queued',
          version: 2,
          eventSequence: 2,
          trigger_type: 'task_start',
          attemptStatus: 'claimed',
          eventCount: 2,
        },
      ]);
    } finally {
      if (runManagerDatabase && runManagerDatabase !== migrationDatabase) {
        await runManagerDatabase.close();
      }
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL StepRun authority creates, transitions and exactly replays', async () => {
    const migrationDatabase = await open('migration');
    const runId = '30000000-0000-4000-8000-000000000001';
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_key_bindings"
         WHERE start_id IN (
           SELECT start_id FROM "ql3"."tool_execution_completions"
           WHERE run_id = $1
         )`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_completions"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."runs" WHERE id = $1`,
        [runId],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, priority, created_at_ms
         ) VALUES (
           $1, 'step-run-project', 'step-run-task', 'step-run-revision',
           'manual', 'manual', 'runtime', 'running', 0, 0, 0, 1
         )`,
        [runId],
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      const repository = new PostgresStepRunRepository(runtimeDatabase.pool);
      const created = createStepRunMutation(
        {
          id: 'postgres-step-run-001',
          runId,
          stepKey: 'workflow.fetch',
          kind: 'tool',
          definitionRef: 'tool:demo.fetch@1.0.0',
          definitionDigest: 'a'.repeat(64),
          required: true,
          initialStatus: 'pending',
          inputRef: 'artifact:postgres-step-run-001:input',
          mutationId: 'postgres-step-create-001',
          createdAtMs: 1_000,
        },
        {
          expectedRunVersion: 0,
          expectedRunEventSequence: 0,
          eventId: '30000000-0000-4000-8000-000000000002',
          dedupeKey: 'step-create:postgres-step-run-001',
          actor: { type: 'agent', id: 'postgres-agent' },
        },
      );
      assert.deepEqual(await repository.apply(created), {
        status: 'applied',
        stepRun: created.stepRun,
        runVersion: 1,
        runEventSequence: 1,
      });
      assert.deepEqual(await repository.apply(created), {
        status: 'existing',
        stepRun: created.stepRun,
        runVersion: 1,
        runEventSequence: 1,
      });

      const ready = transitionStepRunMutation(
        created.stepRun,
        {
          expectedVersion: created.stepRun.version,
          expectedDigest: created.stepRun.stepRunDigest,
          mutationId: 'postgres-step-ready-002',
          to: 'ready',
          atMs: 1_100,
        },
        {
          expectedRunVersion: 1,
          expectedRunEventSequence: 1,
          eventId: '30000000-0000-4000-8000-000000000003',
          dedupeKey: 'step-ready:postgres-step-run-001:2',
          actor: { type: 'agent', id: 'postgres-agent' },
        },
      );
      assert.equal((await repository.apply(ready)).status, 'applied');
      assert.deepEqual(
        await repository.findByRunAndStepKey(runId, 'workflow.fetch'),
        ready.stepRun,
      );
      assert.deepEqual(await repository.apply(created), {
        status: 'existing',
        stepRun: created.stepRun,
        runVersion: 1,
        runEventSequence: 1,
      });
      assert.deepEqual(await repository.listByRun({ runId, limit: 1 }), {
        stepRuns: [ready.stepRun],
        truncated: false,
      });
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           (SELECT version FROM "ql3"."runs" WHERE id = $1) AS run_version,
           (SELECT event_sequence FROM "ql3"."runs" WHERE id = $1)
             AS event_sequence,
           (SELECT COUNT(*) FROM "ql3"."step_runs" WHERE run_id = $1)
             AS step_runs,
           (SELECT COUNT(*) FROM "ql3"."step_run_mutations" WHERE run_id = $1)
             AS mutations`,
        [runId],
      );
      assert.deepEqual(facts.rows[0], {
        run_version: 2,
        event_sequence: 2,
        step_runs: '1',
        mutations: '2',
      });
      await assert.rejects(
        verificationDatabase.pool.query(
          `INSERT INTO "ql3"."run_events" (
             id, run_id, sequence, type, dedupe_key, actor_type,
             step_run_id, payload, created_at_ms
           ) VALUES (
             '30000000-0000-4000-8000-000000000004', $1, 3,
             'step.invalid', 'step-invalid-cross-run', 'system',
             'missing-step-run', '{}'::jsonb, 1200
           )`,
          [runId],
        ),
        (error) =>
          error?.code === '23503' &&
          error?.constraint === 'ql3_run_events_step_run_fk',
      );
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL atomically binds Tool start audit, Trace and ready StepRun', async () => {
    const migrationDatabase = await open('migration');
    const runId = '31000000-0000-4000-8000-000000000001';
    const stepRunId = 'postgres-tool-evidence-step-001';
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_key_bindings"
         WHERE start_id IN (
           SELECT start_id FROM "ql3"."tool_execution_completions"
           WHERE run_id = $1
         )`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_start_artifact_bindings"
         WHERE start_id = 'postgres-tool-start-001'`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."run_events" WHERE run_id = $1`,
        [runId],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."runs" WHERE id = $1`,
        [runId],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."security_audit_events"
         WHERE event_id = '31000000-0000-4000-8000-000000000004'::uuid`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, priority, created_at_ms
         ) VALUES (
           $1, 'tool-evidence-project', 'tool-evidence-task',
           'tool-evidence-revision', 'manual', 'manual', 'runtime',
           'running', 0, 0, 0, 1
         )`,
        [runId],
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    const createdAtMs = 2_100;
    let bundle;
    try {
      const steps = new PostgresStepRunRepository(runtimeDatabase.pool);
      const created = createStepRunMutation(
        {
          id: stepRunId,
          runId,
          stepKey: 'workflow.tool-evidence',
          kind: 'tool',
          definitionRef: 'tool:demo.evidence@1.0.0',
          definitionDigest: 'a'.repeat(64),
          required: true,
          initialStatus: 'pending',
          mutationId: 'postgres-tool-evidence-create-001',
          createdAtMs: 2_000,
        },
        {
          expectedRunVersion: 0,
          expectedRunEventSequence: 0,
          eventId: '31000000-0000-4000-8000-000000000002',
          dedupeKey: 'tool-evidence:create',
          actor: { type: 'agent', id: 'postgres-agent' },
        },
      );
      await steps.apply(created);
      const ready = transitionStepRunMutation(
        created.stepRun,
        {
          expectedVersion: created.stepRun.version,
          expectedDigest: created.stepRun.stepRunDigest,
          mutationId: 'postgres-tool-evidence-ready-002',
          to: 'ready',
          atMs: createdAtMs,
        },
        {
          expectedRunVersion: 1,
          expectedRunEventSequence: 1,
          eventId: '31000000-0000-4000-8000-000000000003',
          dedupeKey: 'tool-evidence:ready',
          actor: { type: 'agent', id: 'postgres-agent' },
        },
      );
      await steps.apply(ready);

      bundle = createToolExecutionEvidenceBundle({
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        projectId: 'tool-evidence-project',
        runId,
        stepRunId,
        invocationPlanDigest: '3'.repeat(64),
        bindingDigest: '4'.repeat(64),
        adapterDigest: '5'.repeat(64),
        redactionContractDigest: '6'.repeat(64),
        auditContractDigest: '7'.repeat(64),
        audit: {
          eventId: '31000000-0000-4000-8000-000000000004',
          requestId: 'tool-evidence-request-1',
          operationId: 'tool.invoke.start',
          projectId: 'tool-evidence-project',
          subject: { type: 'user', id: 'tool-evidence-user' },
          authenticationId: 'tool-evidence-authentication',
          outcome: 'allowed',
          reasons: ['role_grant'],
          fence: { projectVersion: 1, bindingVersion: 1 },
          occurredAtMs: createdAtMs,
        },
        createdAtMs,
      });
      const evidence = new PostgresToolExecutionEvidenceRepository(
        runtimeDatabase.pool,
      );
      assert.deepEqual(await evidence.prepare(bundle), {
        status: 'created',
        bundle,
      });
      assert.deepEqual(await evidence.prepare(bundle), {
        status: 'existing',
        bundle,
      });
      assert.deepEqual(
        await evidence.findByTrace(bundle.trace.traceId, bundle.trace.spanId),
        bundle,
      );
      assert.deepEqual(
        await evidence.findByAuditEventId(bundle.audit.eventId),
        bundle,
      );
      assert.deepEqual(await evidence.listByRun({ runId, limit: 1 }), {
        bundles: [bundle],
        truncated: false,
      });
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           (SELECT COUNT(*) FROM "ql3"."security_audit_events"
             WHERE event_id = $1::uuid) AS audits,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_trace_anchors"
             WHERE run_id = $2) AS traces,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_audit_receipts"
             WHERE run_id = $2) AS receipts`,
        [bundle.audit.eventId, runId],
      );
      assert.deepEqual(facts.rows[0], {
        audits: '1',
        traces: '1',
        receipts: '1',
      });
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL atomically commits admitted Tool start and exactly replays', async () => {
    const stepRunId = 'postgres-tool-start-step-001';
    const migrationDatabase = await open('migration');
    let resultKeyFence;
    let resultKeyCatalog;
    let resultArtifactForRekey;
    let resultBindingForRekey;
    let resultOutputForRekey;
    let resultRegistryForRekey;
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      const resultKeyCatalogCommit =
        await new PostgresToolResultKeyCatalogRepository(
          migrationDatabase.pool,
        ).append(
          createToolResultKeyCatalogBootstrapCommand({
            keyId: 'tool-result-key-integration',
            materialProof: toolResultKeyMaterialProof(
              'tool-result-key-integration',
              Buffer.alloc(32, 5),
            ),
            mutationId: 'tool-result-key-bootstrap-integration',
          }),
        );
      resultKeyFence = toolResultKeyCatalogFence(
        resultKeyCatalogCommit.catalog,
        requireActiveToolResultKey(resultKeyCatalogCommit.catalog),
      );
      resultKeyCatalog = resultKeyCatalogCommit.catalog;
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_key_bindings"
         WHERE start_id IN (
           SELECT start_id FROM "ql3"."tool_execution_completions"
           WHERE run_id = $1
         )`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_failure_completions"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_completions"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_start_barriers"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_audit_receipts"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_trace_anchors"
         WHERE run_id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."security_audit_events"
         WHERE event_id =
           '32000000-0000-4000-8000-000000000004'::uuid`,
      );
      for (const table of ['step_run_mutations', 'run_events', 'step_runs']) {
        await migrationDatabase.pool.query(
          `DELETE FROM "ql3"."${table}" WHERE run_id = $1`,
          [TOOL_START_RUN_ID],
        );
      }
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."runs" WHERE id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES (
           $1, 'Tool Start Integration', 'tool-start-integration',
           'active', 1, 1, 1
         ) ON CONFLICT (id) DO NOTHING`,
        [TOOL_START_PROJECT_ID],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, priority, created_at_ms
         ) VALUES (
           $1, $2, 'tool-start-task', 'tool-start-revision', 'manual',
           'manual', 'runtime', 'running', 0, 0, 0, 1
         )`,
        [TOOL_START_RUN_ID, TOOL_START_PROJECT_ID],
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    let barrier;
    try {
      const snapshot = integrationToolSnapshot();
      const creation = createStepRunMutation(
        {
          id: stepRunId,
          runId: TOOL_START_RUN_ID,
          stepKey: 'workflow.integration-compare',
          kind: 'tool',
          definitionRef: 'tool:integration.compare@1.0.0',
          definitionDigest: snapshot.definitions[0].definitionDigest,
          required: true,
          initialStatus: 'ready',
          inputRef: 'artifact:postgres-tool-start:input',
          mutationId: 'postgres-tool-start-create-001',
          createdAtMs: 3_000,
        },
        {
          expectedRunVersion: 0,
          expectedRunEventSequence: 0,
          eventId: '32000000-0000-4000-8000-000000000002',
          dedupeKey: 'tool-start:create',
          actor: TOOL_START_SUBJECT,
        },
      );
      const steps = new PostgresStepRunRepository(runtimeDatabase.pool);
      assert.equal((await steps.apply(creation)).status, 'applied');

      const startBundle = await integrationToolStartCommand(creation.stepRun);
      const artifacts = new PostgresToolInvocationArtifactRepository(
        runtimeDatabase.pool,
      );
      await artifacts.put(
        startBundle.inputArtifact,
        startBundle.previewArtifact,
      );
      const command = startBundle.command;
      const starts = new PostgresToolExecutionStartBarrierRepository(
        runtimeDatabase.pool,
      );
      const created = await starts.prepare(command);
      assert.equal(created.status, 'created');
      barrier = created.barrier;
      assert.deepEqual(await starts.prepare(command), {
        status: 'existing',
        barrier,
      });
      assert.deepEqual(await starts.findByStartId(barrier.startId), barrier);
      assert.deepEqual(
        await starts.findByStepRun(
          TOOL_START_RUN_ID,
          stepRunId,
          barrier.startedStepRunVersion,
        ),
        barrier,
      );
      const step = await steps.findById(stepRunId);
      assert.equal(step.status, 'running');
      assert.equal(step.version, 2);

      const result = toolExecutionResult(barrier, {
        summary: 'Integration Run is healthy',
      });
      const resultArtifact = createToolExecutionResultArtifact(
        {
          artifactId: 'artifact-result-integration-001',
          projectId: barrier.projectId,
          runId: barrier.runId,
          stepRunId: barrier.stepRunId,
          tool: { name: 'integration.compare', version: '1.0.0' },
          executionResult: result,
          keyId: 'tool-result-key-integration',
          key: Buffer.alloc(32, 5),
        },
        startBundle.registry,
        () => Buffer.alloc(12, 4),
      );
      const completionMutation = transitionStepRunMutation(
        step,
        {
          expectedVersion: step.version,
          expectedDigest: step.stepRunDigest,
          mutationId: 'postgres-tool-start-succeeded-003',
          to: 'succeeded',
          atMs: TOOL_RESULT_AT_MS,
          outputRef: resultArtifact.artifactId,
        },
        {
          expectedRunVersion: 2,
          expectedRunEventSequence: 2,
          eventId: '32000000-0000-4000-8000-000000000005',
          dedupeKey: 'tool-start:succeeded',
          actor: TOOL_START_SUBJECT,
        },
      );
      const completionCommand = createToolExecutionCompletionCommand({
        barrier,
        executionResult: result,
        resultArtifact,
        resultKeyCatalogFence: resultKeyFence,
        stepRunMutation: completionMutation,
      });
      const completions = new PostgresToolExecutionCompletionRepository(
        runtimeDatabase.pool,
      );
      const completed = await completions.commit(completionCommand);
      assert.equal(completed.status, 'created');
      assert.deepEqual(await completions.commit(completionCommand), {
        status: 'existing',
        completion: completed.completion,
      });
      assert.deepEqual(
        await completions.findByStartId(barrier.startId),
        completed.completion,
      );
      assert.deepEqual(
        await completions.findResultArtifact(resultArtifact.artifactId),
        resultArtifact,
      );
      resultArtifactForRekey = resultArtifact;
      resultBindingForRekey = toolExecutionResultKeyBinding(completionCommand);
      resultOutputForRekey = result.output;
      resultRegistryForRekey = startBundle.registry;
      const succeeded = await steps.findById(stepRunId);
      assert.equal(succeeded.status, 'succeeded');
      assert.equal(succeeded.outputRef, resultArtifact.artifactId);
    } finally {
      await runtimeDatabase.close();
    }

    const adminDatabase = await open('admin');
    let rekeyOverlay;
    let retirementReceipt;
    try {
      const catalogRepository = new PostgresToolResultKeyCatalogRepository(
        adminDatabase.pool,
      );
      const rotated = await catalogRepository.append(
        createToolResultKeyRotationCommand(resultKeyCatalog, {
          keyId: 'tool-result-key-integration-next',
          materialProof: toolResultKeyMaterialProof(
            'tool-result-key-integration-next',
            Buffer.alloc(32, 6),
          ),
          mutationId: 'tool-result-key-rotate-integration-next',
        }),
      );
      resultKeyCatalog = rotated.catalog;
      const rekeyRepository = new PostgresToolResultRekeyRepository(
        adminDatabase.pool,
      );
      const rekeyCommand = createToolExecutionResultRekeyCommand({
        artifact: resultArtifactForRekey,
        binding: resultBindingForRekey,
        previousOverlay: null,
        overlayId: 'tool-result-rekey-overlay-integration-001',
        mutationId: 'tool-result-rekey-mutation-integration-001',
        targetCatalogFence: toolResultKeyCatalogFence(
          resultKeyCatalog,
          requireActiveToolResultKey(resultKeyCatalog),
        ),
        targetKey: Buffer.alloc(32, 6),
        output: resultOutputForRekey,
        rekeyedAtMs: TOOL_RESULT_AT_MS + 1,
        registry: resultRegistryForRekey,
        nonceFactory: () => Buffer.alloc(12, 6),
      });
      const appended = await rekeyRepository.append(rekeyCommand);
      assert.equal(appended.status, 'created');
      assert.deepEqual(await rekeyRepository.append(rekeyCommand), {
        status: 'existing',
        overlay: appended.overlay,
      });
      rekeyOverlay = appended.overlay;
      const receiptCommand = createToolResultKeyRetirementReceiptCommand({
        expectedCatalogGeneration: resultKeyCatalog.generation,
        expectedCatalogDigest: resultKeyCatalog.catalogDigest,
        keyId: 'tool-result-key-integration',
        mutationId: 'tool-result-key-retirement-integration-001',
      });
      const receipt = await rekeyRepository.create(receiptCommand);
      assert.equal(receipt.status, 'created');
      assert.equal(receipt.receipt.bindingCount, 1);
      assert.equal(receipt.receipt.overlayHeadCount, 1);
      retirementReceipt = receipt.receipt;
      const retired = await catalogRepository.append(
        createToolResultKeyRetirementCommand(resultKeyCatalog, {
          keyId: 'tool-result-key-integration',
          retirementReceiptDigest: retirementReceipt.receiptDigest,
          mutationId: 'tool-result-key-retire-integration-001',
        }),
      );
      assert.equal(
        retired.catalog.keys.find(
          (entry) => entry.keyId === 'tool-result-key-integration',
        ).state,
        'retired',
      );
    } finally {
      await adminDatabase.close();
    }

    const rekeyRuntimeDatabase = await open('runtime');
    try {
      assert.deepEqual(
        await new PostgresToolResultRekeyReader(
          rekeyRuntimeDatabase.pool,
        ).findHeadByArtifactId(resultArtifactForRekey.artifactId),
        rekeyOverlay,
      );
    } finally {
      await rekeyRuntimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           (SELECT version FROM "ql3"."runs" WHERE id = $1)
             AS run_version,
           (SELECT event_sequence FROM "ql3"."runs" WHERE id = $1)
             AS event_sequence,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_start_barriers"
             WHERE run_id = $1) AS barriers,
           (SELECT COUNT(*)
              FROM "ql3"."tool_execution_start_artifact_bindings"
             WHERE start_id = $4) AS artifact_bindings,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_completions"
             WHERE start_id = $4) AS completions,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_result_rekey_overlays"
             WHERE artifact_id = $5) AS rekey_overlays,
           (SELECT COUNT(*) FROM "ql3"."tool_result_key_retirement_receipts"
             WHERE receipt_digest = $6) AS retirement_receipts,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_trace_anchors"
             WHERE run_id = $1) AS traces,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_audit_receipts"
             WHERE run_id = $1) AS receipts,
           (SELECT COUNT(*) FROM "ql3"."security_audit_events"
             WHERE event_id = $2::uuid) AS audits,
           (SELECT committed_at_ms
              FROM "ql3"."step_run_mutations"
             WHERE mutation_id = $3) AS committed_at_ms`,
        [
          TOOL_START_RUN_ID,
          barrier.auditEventId,
          barrier.stepRunMutationId,
          barrier.startId,
          resultArtifactForRekey.artifactId,
          retirementReceipt.receiptDigest,
        ],
      );
      assert.deepEqual(
        {
          runVersion: facts.rows[0].run_version,
          eventSequence: facts.rows[0].event_sequence,
          barriers: facts.rows[0].barriers,
          artifactBindings: facts.rows[0].artifact_bindings,
          completions: facts.rows[0].completions,
          rekeyOverlays: facts.rows[0].rekey_overlays,
          retirementReceipts: facts.rows[0].retirement_receipts,
          traces: facts.rows[0].traces,
          receipts: facts.rows[0].receipts,
          audits: facts.rows[0].audits,
        },
        {
          runVersion: 3,
          eventSequence: 3,
          barriers: '1',
          artifactBindings: '1',
          completions: '1',
          rekeyOverlays: '1',
          retirementReceipts: '1',
          traces: '1',
          receipts: '1',
          audits: '1',
        },
      );
      assert.equal(
        Number(facts.rows[0].committed_at_ms) >= barrier.startedAtMs,
        true,
      );
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL atomically commits timed_out Tool completion and excludes success', async () => {
    const stepRunId = 'postgres-tool-start-step-001';
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_rekey_heads"`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_rekey_overlays"`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_result_key_retirement_receipts"`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_result_key_bindings"
         WHERE start_id IN (
           SELECT start_id FROM "ql3"."tool_execution_completions"
           WHERE run_id = $1
         )`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."tool_execution_start_artifact_bindings"
         WHERE start_id = $1`,
        ['postgres-tool-start-001'],
      );
      for (const table of [
        'tool_execution_failure_completions',
        'tool_execution_completions',
        'tool_execution_start_barriers',
        'tool_execution_audit_receipts',
        'tool_execution_trace_anchors',
      ]) {
        await migrationDatabase.pool.query(
          `DELETE FROM "ql3"."${table}" WHERE run_id = $1`,
          [TOOL_START_RUN_ID],
        );
      }
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."security_audit_events"
         WHERE event_id =
           '32000000-0000-4000-8000-000000000004'::uuid`,
      );
      for (const table of ['step_run_mutations', 'run_events', 'step_runs']) {
        await migrationDatabase.pool.query(
          `DELETE FROM "ql3"."${table}" WHERE run_id = $1`,
          [TOOL_START_RUN_ID],
        );
      }
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."runs" WHERE id = $1`,
        [TOOL_START_RUN_ID],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES (
           $1, 'Tool Start Integration', 'tool-start-integration',
           'active', 1, 1, 1
         ) ON CONFLICT (id) DO NOTHING`,
        [TOOL_START_PROJECT_ID],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, priority, created_at_ms
         ) VALUES (
           $1, $2, 'tool-start-task', 'tool-start-revision', 'manual',
           'manual', 'runtime', 'running', 0, 0, 0, 1
         )`,
        [TOOL_START_RUN_ID, TOOL_START_PROJECT_ID],
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    let barrier;
    try {
      const snapshot = integrationToolSnapshot();
      const creation = createStepRunMutation(
        {
          id: stepRunId,
          runId: TOOL_START_RUN_ID,
          stepKey: 'workflow.integration-compare',
          kind: 'tool',
          definitionRef: 'tool:integration.compare@1.0.0',
          definitionDigest: snapshot.definitions[0].definitionDigest,
          required: true,
          initialStatus: 'ready',
          inputRef: 'artifact:postgres-tool-start:input',
          mutationId: 'postgres-tool-start-create-001',
          createdAtMs: 3_000,
        },
        {
          expectedRunVersion: 0,
          expectedRunEventSequence: 0,
          eventId: '32000000-0000-4000-8000-000000000002',
          dedupeKey: 'tool-start:create',
          actor: TOOL_START_SUBJECT,
        },
      );
      const steps = new PostgresStepRunRepository(runtimeDatabase.pool);
      assert.equal((await steps.apply(creation)).status, 'applied');
      const startBundle = await integrationToolStartCommand(creation.stepRun);
      await new PostgresToolInvocationArtifactRepository(
        runtimeDatabase.pool,
      ).put(startBundle.inputArtifact, startBundle.previewArtifact);
      const created = await new PostgresToolExecutionStartBarrierRepository(
        runtimeDatabase.pool,
      ).prepare(startBundle.command);
      barrier = created.barrier;
      const running = await steps.findById(stepRunId);

      const failure = createToolExecutionFailureResult(
        barrier,
        'timed_out',
        TOOL_RESULT_AT_MS,
      );
      const failureMutation = transitionStepRunMutation(
        running,
        {
          expectedVersion: running.version,
          expectedDigest: running.stepRunDigest,
          mutationId: 'postgres-tool-start-timed-out-003',
          to: 'timed_out',
          atMs: failure.completedAtMs,
          ...TOOL_EXECUTION_FAILURE_FACTS.timed_out,
        },
        {
          expectedRunVersion: 2,
          expectedRunEventSequence: 2,
          eventId: '32000000-0000-4000-8000-000000000005',
          dedupeKey: 'tool-start:timed-out',
          actor: TOOL_START_SUBJECT,
        },
      );
      const failureCommand = createToolExecutionFailureCompletionCommand({
        barrier,
        failure,
        stepRunMutation: failureMutation,
      });
      const failures = new PostgresToolExecutionFailureCompletionRepository(
        runtimeDatabase.pool,
      );
      const completed = await failures.commit(failureCommand);
      assert.equal(completed.status, 'created');
      assert.deepEqual(await failures.commit(failureCommand), {
        status: 'existing',
        completion: completed.completion,
      });
      assert.deepEqual(
        await failures.findByStartId(barrier.startId),
        completed.completion,
      );

      const resultKeyCatalog = await new PostgresToolResultKeyCatalogReader(
        runtimeDatabase.pool,
      ).findCurrent();
      assert.ok(resultKeyCatalog);
      const activeResultKey = requireActiveToolResultKey(resultKeyCatalog);
      const resultKeyFence = toolResultKeyCatalogFence(
        resultKeyCatalog,
        activeResultKey,
      );
      const activeResultKeyMaterial =
        activeResultKey.keyId === 'tool-result-key-integration-next'
          ? Buffer.alloc(32, 6)
          : Buffer.alloc(32, 5);
      const lateResult = toolExecutionResult(barrier, {
        summary: 'late success must lose',
      });
      const lateArtifact = createToolExecutionResultArtifact(
        {
          artifactId: 'artifact-result-integration-late-001',
          projectId: barrier.projectId,
          runId: barrier.runId,
          stepRunId: barrier.stepRunId,
          tool: { name: 'integration.compare', version: '1.0.0' },
          executionResult: lateResult,
          keyId: activeResultKey.keyId,
          key: activeResultKeyMaterial,
        },
        startBundle.registry,
        () => Buffer.alloc(12, 4),
      );
      const lateSuccessMutation = transitionStepRunMutation(
        running,
        {
          expectedVersion: running.version,
          expectedDigest: running.stepRunDigest,
          mutationId: 'postgres-tool-start-late-success-004',
          to: 'succeeded',
          atMs: lateResult.completedAtMs,
          outputRef: lateArtifact.artifactId,
        },
        {
          expectedRunVersion: 2,
          expectedRunEventSequence: 2,
          eventId: '32000000-0000-4000-8000-000000000006',
          dedupeKey: 'tool-start:late-success',
          actor: TOOL_START_SUBJECT,
        },
      );
      await assert.rejects(
        new PostgresToolExecutionCompletionRepository(
          runtimeDatabase.pool,
        ).commit(
          createToolExecutionCompletionCommand({
            barrier,
            executionResult: lateResult,
            resultArtifact: lateArtifact,
            resultKeyCatalogFence: resultKeyFence,
            stepRunMutation: lateSuccessMutation,
          }),
        ),
        ToolExecutionCompletionConflictError,
      );
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           run.version AS run_version,
           run.event_sequence,
           step.status AS step_status,
           step.output_ref,
           step.result_code,
           step.error_summary,
           (SELECT COUNT(*)
              FROM "ql3"."tool_execution_failure_completions"
             WHERE start_id = $2) AS failure_completions,
           (SELECT COUNT(*) FROM "ql3"."tool_execution_completions"
             WHERE start_id = $2) AS success_completions
         FROM "ql3"."runs" AS run
         JOIN "ql3"."step_runs" AS step ON step.run_id = run.id
         WHERE run.id = $1 AND step.id = $3`,
        [TOOL_START_RUN_ID, barrier.startId, stepRunId],
      );
      assert.deepEqual(facts.rows[0], {
        run_version: 3,
        event_sequence: 3,
        step_status: 'timed_out',
        output_ref: null,
        result_code: 'tool_deadline_exceeded',
        error_summary: 'Trusted Tool execution deadline exceeded',
        failure_completions: '1',
        success_completions: '0',
      });
    } finally {
      await verificationDatabase.close();
    }
  });

  registerPluginPackageInstallRepositoryContract({
    name: 'PostgreSQL Plugin Package install repository',
    async createRepository() {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await observeContractPublisherTrust(migrationDatabase.pool);
      } finally {
        await migrationDatabase.close();
      }
      const executorDatabase = await open('package-executor');
      return {
        repository: publisherProvenanceInstallRepository(
          new PostgresPluginPackageInstallRepository(executorDatabase.pool),
          new PostgresPluginPackagePublisherProvenanceRepository(
            executorDatabase.pool,
          ),
        ),
        close: () => executorDatabase.close(),
      };
    },
  });

  registerPluginPackageAutomationPublicationRepositoryContract({
    name: 'PostgreSQL Plugin Package automation publication repository',
    namespace: 'postgres-automation-publication',
    profile: 'cluster-control',
    async createRepository(_t, fixture) {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
           ON CONFLICT (id) DO NOTHING`,
          [fixture.projectId],
        );
      } finally {
        await migrationDatabase.close();
      }
      const executorDatabase = await open('package-executor');
      return {
        repository: new PostgresPluginPackageAutomationPublicationRepository(
          executorDatabase.pool,
        ),
        materializedRepository:
          new PostgresPluginPackageMaterializedRevisionRepository(
            executorDatabase.pool,
            fixture.registry,
          ),
        close: () => executorDatabase.close(),
      };
    },
  });

  test('PostgreSQL automation recovery source lists only stale materialized active generations', async () => {
    const fixture = pluginPackageAutomationPublicationFixture(
      'postgres-automation-pending',
      { profile: 'cluster-control', name: 'daily' },
    );
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query('TRUNCATE TABLE "ql3"."runs" CASCADE');
      await observeContractPublisherTrust(migrationDatabase.pool);
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [fixture.projectId],
      );
    } finally {
      await migrationDatabase.close();
    }
    const executorDatabase = await open('package-executor');
    try {
      const installRepository = publisherProvenanceInstallRepository(
        new PostgresPluginPackageInstallRepository(executorDatabase.pool),
        new PostgresPluginPackagePublisherProvenanceRepository(
          executorDatabase.pool,
        ),
      );
      const materializedRepository =
        new PostgresPluginPackageMaterializedRevisionRepository(
          executorDatabase.pool,
          fixture.registry,
        );
      const repository =
        new PostgresPluginPackageAutomationPublicationRepository(
          executorDatabase.pool,
        );
      await activateInstall(installRepository, fixture);
      assert.deepEqual(await repository.listPendingPage({ limit: 1 }), {
        candidates: [],
        truncated: false,
      });
      await materializedRepository.publish(fixture.revision);
      assert.deepEqual(await repository.listPendingPage({ limit: 1 }), {
        candidates: [
          {
            projectId: fixture.projectId,
            packageName: fixture.packageName,
          },
        ],
        truncated: false,
      });
      await repository.publish(
        createInitialPluginPackageAutomationPublication(
          fixture.revision,
          fixture.registry,
          1_000,
        ),
      );
      assert.deepEqual(await repository.listPendingPage({ limit: 1 }), {
        candidates: [],
        truncated: false,
      });
    } finally {
      await executorDatabase.close();
    }
  });

  test('PostgreSQL atomically admits, recovers, requeues and cancels one generation-bound Workflow Task', async () => {
    const namespace = `postgres-workflow-${process.pid}`;
    const fixture = pluginPackageTaskReconciliationFixture(namespace, {
      profile: 'cluster-control',
      workflows: [
        {
          schema: 'qinglong/plugin-package-workflow-resource@v1',
          id: 'daily',
          name: 'Daily workflow',
          enabled: true,
          steps: [
            { id: 'collect', task: 'alpha', needs: [] },
            { id: 'summarize', task: 'beta', needs: ['collect'] },
          ],
        },
      ],
    });
    const publication = createInitialPluginPackageAutomationPublication(
      fixture.revision,
      fixture.registry,
      2_000,
    );
    const plan = createPluginPackageWorkflowExecutionPlan({
      planId: `workflow-plan-${process.pid}`,
      runId: `workflow-run-${process.pid}`,
      workflowId: 'daily',
      stepRunIds: {
        collect: `workflow-collect-${process.pid}`,
        summarize: `workflow-summarize-${process.pid}`,
      },
      publication,
      revision: fixture.revision,
      taskSpecSemanticRegistry: fixture.registry,
      plannedAtMs: 3_000,
    });

    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await observeContractPublisherTrust(migrationDatabase.pool);
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [fixture.projectId],
      );
    } finally {
      await migrationDatabase.close();
    }

    const executorDatabase = await open('package-executor');
    try {
      await activateInstall(
        publisherProvenanceInstallRepository(
          new PostgresPluginPackageInstallRepository(executorDatabase.pool),
          new PostgresPluginPackagePublisherProvenanceRepository(
            executorDatabase.pool,
          ),
        ),
        fixture,
      );
      await new PostgresPluginPackageMaterializedRevisionRepository(
        executorDatabase.pool,
        fixture.registry,
      ).publish(fixture.revision);
      await new PostgresPluginPackageTaskReconciliationRepository(
        executorDatabase.pool,
        fixture.registry,
      ).reconcile(fixture.revision, {
        async findActiveResourceGeneration() {
          return fixture.revision.generation;
        },
      });
      await new PostgresPluginPackageAutomationPublicationRepository(
        executorDatabase.pool,
      ).publish(publication);
    } finally {
      await executorDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      const repository = new PostgresPluginPackageWorkflowAdmissionRepository(
        runtimeDatabase.pool,
      );
      const created = await repository.admit(plan);
      assert.equal(created.status, 'created');
      assert.equal(created.receipt.finalRunVersion, 3);
      assert.deepEqual(await repository.admit(plan), {
        status: 'existing',
        receipt: created.receipt,
      });
      assert.deepEqual(
        await repository.findByRunId(plan.runId),
        created.receipt,
      );
      const taskAttempts =
        new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
          runtimeDatabase.pool,
        );
      assert.deepEqual(await taskAttempts.listCandidates({ limit: 8 }), {
        candidates: [
          {
            runId: plan.runId,
            stepRunId: plan.steps[0].stepRunId,
            readyAtMs: plan.plannedAtMs,
            planDigest: plan.planDigest,
          },
        ],
        truncated: false,
      });
      const taskAttempt = await taskAttempts.admit(
        plan.runId,
        plan.steps[0].stepRunId,
      );
      assert.equal(taskAttempt.status, 'created');

      const recoverySource = new PostgresClusterControlRecoverySource(
        runtimeDatabase.pool,
      );
      assert.equal(
        (await recoverySource.listOutstanding(128)).candidates.some(
          ({ id }) => id === taskAttempt.receipt.attemptId,
        ),
        false,
      );
      await runtimeDatabase.pool.query(
        `UPDATE "ql3"."run_attempts"
         SET lease_token = 'expired-workflow-task-lease',
             lease_expires_at_ms = 0
         WHERE id = $1`,
        [taskAttempt.receipt.attemptId],
      );

      const claims = new PostgresClusterControlRecoveryClaimRepository(
        runtimeDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000d1',
      );
      const processor = new EvidenceBasedClusterControlRecoveryProcessor(
        new PostgresClusterControlRecoveryResolutionRepository(
          runtimeDatabase.pool,
        ),
        {
          async inspect() {
            throw new Error(
              'unstarted Workflow Task must not cross the probe boundary',
            );
          },
        },
      );
      const supervisor = new ClusterControlRecoverySupervisor(
        claims,
        processor,
        { ownerId: 'workflow-recovery', limit: 8, leaseMs: 30_000 },
      );
      assert.deepEqual(await supervisor.reconcile(), {
        safe: true,
        remaining: 0,
        failed: 0,
      });

      const recovered = await runtimeDatabase.pool.query(
        `SELECT run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                attempt.status AS "attemptStatus",
                step.status AS "stepStatus",
                step.version AS "stepVersion",
                step.attempt_count AS "stepAttemptCount",
                array_agg(event.type ORDER BY event.sequence)
                  FILTER (WHERE event.sequence >= 4) AS events
         FROM "ql3"."runs" AS run
         JOIN "ql3"."run_attempts" AS attempt
           ON attempt.run_id = run.id
         JOIN "ql3"."step_runs" AS step
           ON step.id = attempt.step_run_id
          AND step.run_id = run.id
         JOIN "ql3"."run_events" AS event
           ON event.run_id = run.id
         WHERE run.id = $1 AND attempt.id = $2
         GROUP BY run.id, attempt.id, step.id`,
        [plan.runId, taskAttempt.receipt.attemptId],
      );
      assert.deepEqual(recovered.rows, [
        {
          runStatus: 'running',
          runVersion: 6,
          eventSequence: 6,
          attemptStatus: 'lost',
          stepStatus: 'ready',
          stepVersion: 2,
          stepAttemptCount: 0,
          events: [
            'workflow.task_attempt_admitted',
            'workflow.task_attempt.lost',
            'step.ready',
          ],
        },
      ]);
      const requeued = await taskAttempts.listCandidates({ limit: 8 });
      assert.deepEqual(
        requeued.candidates.map(({ runId, stepRunId }) => ({
          runId,
          stepRunId,
        })),
        [
          {
            runId: plan.runId,
            stepRunId: plan.steps[0].stepRunId,
          },
        ],
      );
      const secondTaskAttempt = await taskAttempts.admit(
        plan.runId,
        plan.steps[0].stepRunId,
      );
      assert.equal(secondTaskAttempt.status, 'created');
      await runtimeDatabase.pool.query(
        `UPDATE "ql3"."runs"
         SET cancel_requested_at_ms = floor(
               extract(epoch FROM statement_timestamp()) * 1000
             )::bigint,
             cancel_reason = 'user'
         WHERE id = $1 AND status = 'running'`,
        [plan.runId],
      );
      const cancellation =
        new PostgresClusterRunCancellationConvergenceRepository(
          runtimeDatabase.pool,
        );
      assert.deepEqual(await cancellation.convergePage({ limit: 8 }), {
        scanned: 1,
        settledRuns: 1,
        settledAttempts: 1,
        blocked: 0,
        hasMore: false,
      });
      const cancelled = await runtimeDatabase.pool.query(
        `SELECT run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                ARRAY(
                  SELECT DISTINCT attempt.status
                  FROM "ql3"."run_attempts" AS attempt
                  WHERE attempt.run_id = run.id
                  ORDER BY attempt.status
                ) AS "attemptStatuses",
                ARRAY(
                  SELECT DISTINCT step.status
                  FROM "ql3"."step_runs" AS step
                  WHERE step.run_id = run.id
                  ORDER BY step.status
                ) AS "stepStatuses",
                ARRAY(
                  SELECT event.type
                  FROM "ql3"."run_events" AS event
                  WHERE event.run_id = run.id AND event.sequence >= 7
                  ORDER BY event.sequence
                ) AS events
         FROM "ql3"."runs" AS run
         WHERE run.id = $1`,
        [plan.runId],
      );
      assert.deepEqual(cancelled.rows, [
        {
          runStatus: 'cancelled',
          runVersion: 11,
          eventSequence: 11,
          attemptStatuses: ['cancelled', 'lost'],
          stepStatuses: ['cancelled'],
          events: [
            'workflow.task_attempt_admitted',
            'workflow.task_attempt.cancelled',
            'step.cancelled',
            'step.cancelled',
            'workflow.cancelled',
          ],
        },
      ]);
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM "ql3"."runs"
             WHERE id = $1) AS runs,
           (SELECT count(*)::integer FROM "ql3"."step_runs"
             WHERE run_id = $1) AS steps,
          (SELECT count(*)::integer FROM "ql3"."run_events"
             WHERE run_id = $1) AS events,
           (SELECT count(*)::integer FROM "ql3"."step_run_mutations"
             WHERE run_id = $1) AS mutations,
          (SELECT count(*)::integer
              FROM "ql3"."plugin_package_workflow_admissions"
             WHERE run_id = $1) AS admissions,
          (SELECT count(*)::integer
             FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
            WHERE run_id = $1) AS "taskAttemptAdmissions"`,
        [plan.runId],
      );
      assert.deepEqual(facts.rows[0], {
        runs: 1,
        steps: 2,
        events: 11,
        mutations: 5,
        admissions: 1,
        taskAttemptAdmissions: 2,
      });
    } finally {
      await verificationDatabase.close();
    }
  });

  registerPluginPackageTaskReconciliationRepositoryContract({
    name: 'PostgreSQL Plugin Package Task reconciliation repository',
    namespace: 'postgres-task-reconcile',
    profile: 'cluster-control',
    async createRepository(_t, fixture) {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await migrationDatabase.pool.query(
          'TRUNCATE TABLE "ql3"."plugin_package_installs" CASCADE',
        );
        await observeContractPublisherTrust(migrationDatabase.pool);
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
           ON CONFLICT (id) DO NOTHING`,
          [fixture.projectId],
        );
      } finally {
        await migrationDatabase.close();
      }
      const executorDatabase = await open('package-executor');
      const automationManagerDatabase = await open('automation-manager');
      return {
        repository: new PostgresPluginPackageTaskReconciliationRepository(
          executorDatabase.pool,
          fixture.registry,
        ),
        materializedRepository:
          new PostgresPluginPackageMaterializedRevisionRepository(
            executorDatabase.pool,
            fixture.registry,
          ),
        installRepository: publisherProvenanceInstallRepository(
          new PostgresPluginPackageInstallRepository(executorDatabase.pool),
          new PostgresPluginPackagePublisherProvenanceRepository(
            executorDatabase.pool,
          ),
        ),
        taskRepository: new PostgresTaskDefinitionRepository(
          automationManagerDatabase.pool,
          fixture.registry,
        ),
        close: async () => {
          await Promise.all([
            executorDatabase.close(),
            automationManagerDatabase.close(),
          ]);
        },
      };
    },
    async assertGenericWriteRejected(harness, fixture) {
      const task = await harness.taskRepository.findCurrentTaskDefinition(
        fixture.projectId,
        `pkg:${fixture.packageName}:alpha`,
      );
      await assert.rejects(
        harness.taskRepository.appendTaskDefinitionRevision({
          projectId: task.projectId,
          taskId: task.taskId,
          expectedRevision: task.revision,
          mutationId: '019f9000-0000-4000-a000-000000000002',
          name: 'Bypass',
          kind: task.kind,
          spec: task.spec,
          labels: task.labels,
          enabled: task.enabled,
          occurredAtMs: task.updatedAtMs + 1,
        }),
      );
    },
    async assertDurableUpgrade(harness, fixture) {
      const beta = await harness.taskRepository.findCurrentTaskDefinition(
        fixture.projectId,
        `pkg:${fixture.packageName}:beta`,
      );
      assert.equal(beta.revision, 2);
      assert.equal(beta.enabled, false);
    },
  });

  registerProjectToolDefinitionSnapshotRepositoryContract({
    name: 'PostgreSQL Project Tool Definition snapshot repository',
    namespace: 'postgres-tool-snapshot',
    profile: 'cluster-control',
    async createRepository(_t, fixture) {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await observeContractPublisherTrust(migrationDatabase.pool);
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
           ON CONFLICT (id) DO NOTHING`,
          [fixture.projectId],
        );
      } finally {
        await migrationDatabase.close();
      }
      const executorDatabase = await open('package-executor');
      return {
        repository: new PostgresProjectToolDefinitionSnapshotRepository(
          executorDatabase.pool,
        ),
        materializedRepository:
          new PostgresPluginPackageMaterializedRevisionRepository(
            executorDatabase.pool,
            fixture.registry,
          ),
        installRepository: publisherProvenanceInstallRepository(
          new PostgresPluginPackageInstallRepository(executorDatabase.pool),
          new PostgresPluginPackagePublisherProvenanceRepository(
            executorDatabase.pool,
          ),
        ),
        close: () => executorDatabase.close(),
      };
    },
  });

  test('PostgreSQL Approved Action authority commits request, audit and dispatch atomically', async () => {
    const request = createApprovalRequest({
      id: 'approval-postgres-integration-1',
      projectId: 'default',
      action: APPROVAL_ACTION,
      risk: 'high',
      decisionMode: 'human_confirmation',
      requestedBy: APPROVAL_REQUESTER,
      requestedAtMs: 1_000,
      expiresAtMs: 61_000,
      requestFence: APPROVAL_FENCE,
    });
    const createCommand = {
      request,
      audit: approvalAudit(
        '20000000-0000-4000-8000-000000000001',
        'approval.request',
        APPROVAL_REQUESTER,
        'auth-requester-integration',
        'approval_required',
        1_000,
      ),
    };
    const decideCommand = {
      requestId: request.id,
      expectedVersion: 1,
      decisionId: 'decision-postgres-integration-1',
      decision: 'approved',
      reasonCode: 'reviewed',
      principal: {
        subject: APPROVAL_REQUESTER,
        authenticationId: 'auth-step-up-integration',
        authenticatedAtMs: 1_500,
        expiresAtMs: 10_000,
        assurance: 'local_console',
      },
      decidedAtMs: 2_000,
      authorizationFence: APPROVAL_FENCE,
      audit: approvalAudit(
        '20000000-0000-4000-8000-000000000002',
        'approval.decide',
        APPROVAL_REQUESTER,
        'auth-step-up-integration',
        'allowed',
        2_000,
      ),
    };
    const consumeCommand = {
      requestId: request.id,
      expectedVersion: 2,
      consumptionId: 'consume-postgres-integration-1',
      dispatchId: 'dispatch-postgres-integration-1',
      action: APPROVAL_ACTION,
      requestedBy: APPROVAL_REQUESTER,
      consumedBy: APPROVAL_DISPATCHER,
      consumedAtMs: 3_000,
      authorizationFence: APPROVAL_FENCE,
      audit: approvalAudit(
        '20000000-0000-4000-8000-000000000003',
        'approval.consume',
        APPROVAL_DISPATCHER,
        'auth-dispatcher-integration',
        'allowed',
        3_000,
      ),
    };

    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `TRUNCATE TABLE
           "ql3"."approved_action_dispatches",
           "ql3"."approval_requests"
         CASCADE`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."security_audit_events"
         WHERE operation_id LIKE 'approval.%'`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."project_role_bindings"
         WHERE project_id = 'default'
           AND subject_type = 'user'
           AND subject_id = 'usr_approval_integration'`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES (
           'default', 'user', 'usr_approval_integration', 1, 'active',
           'owner', 'grant-approval-integration-1', 'system',
           'integration', 0
         )`,
      );
    } finally {
      await migrationDatabase.close();
    }

    const managerDatabase = await open('package-manager');
    let consumed;
    try {
      const repository = new PostgresApprovalRequestRepository(
        managerDatabase.pool,
      );
      assert.equal((await repository.create(createCommand)).status, 'created');
      assert.equal((await repository.create(createCommand)).status, 'existing');
      assert.equal((await repository.decide(decideCommand)).status, 'decided');
      assert.equal((await repository.decide(decideCommand)).status, 'existing');
    } finally {
      await managerDatabase.close();
    }

    const executorDatabase = await open('package-executor');
    try {
      const repository = new PostgresApprovalRequestRepository(
        executorDatabase.pool,
      );
      consumed = await repository.consume(consumeCommand);
      assert.equal(consumed.status, 'consumed');
      assert.equal(consumed.request.state, 'consumed');
      assert.equal(
        (await repository.consume(consumeCommand)).status,
        'existing',
      );
      assert.deepEqual(
        await repository.findDispatchById(consumeCommand.dispatchId),
        consumed.dispatch,
      );
    } finally {
      await executorDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const auditCount = await verificationDatabase.pool.query(
        `SELECT count(*)::integer AS count
         FROM "ql3"."security_audit_events"
         WHERE operation_id LIKE 'approval.%'`,
      );
      assert.equal(auditCount.rows[0].count, 3);
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL executes approved publisher trust overlap and safe retirement exactly once', async () => {
    const authorityProjectId = 'trust-transition-integration';
    const trustAuthorityId = 'trust-transition-integration';
    const requester = { type: 'user', id: 'usr-trust-owner' };
    const reviewer = { type: 'user', id: 'usr-trust-reviewer' };
    const executor = {
      type: 'system',
      id: 'cluster_package_executor',
    };
    const fence = { projectVersion: 1, bindingVersion: 1 };
    const oldPair = generateKeyPairSync('ed25519');
    const newPair = generateKeyPairSync('ed25519');
    const oldDefinition = {
      publisher: 'publisher-transition.example',
      keyId: 'key-old',
      publicKeyPem: oldPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      notBeforeMs: 1,
      notAfterMs: 100_000,
    };
    const newDefinition = {
      publisher: 'publisher-transition.example',
      keyId: 'key-new',
      publicKeyPem: newPair.publicKey.export({
        type: 'spki',
        format: 'pem',
      }),
      notBeforeMs: 1,
      notAfterMs: 100_000,
    };
    const initialSnapshot = createPluginPackagePublisherTrustSnapshot([
      oldDefinition,
    ]);
    const materialSnapshot = createPluginPackagePublisherTrustSnapshot([
      oldDefinition,
      newDefinition,
    ]);

    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [authorityProjectId],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES
           ($1, 'user', $2, 1, 'active', 'owner',
            'grant-trust-owner-v1', 'system', 'integration', 1),
           ($1, 'user', $3, 1, 'active', 'admin',
            'grant-trust-reviewer-v1', 'system', 'integration', 1)
         ON CONFLICT (project_id, subject_type, subject_id, version)
         DO NOTHING`,
        [authorityProjectId, requester.id, reviewer.id],
      );
    } finally {
      await migrationDatabase.close();
    }

    function transitionAudit({
      eventId,
      requestId,
      operationId,
      subject,
      authenticationId,
      outcome,
      reasons,
      occurredAtMs,
    }) {
      return {
        eventId,
        requestId,
        operationId,
        projectId: authorityProjectId,
        subject,
        authenticationId,
        outcome,
        reasons,
        fence,
        occurredAtMs,
      };
    }

    async function approveTransition({
      manager,
      packageExecutor,
      proposal,
      approvalRequestId,
      dispatchId,
      ordinal,
    }) {
      const action = {
        permission: proposal.permission,
        actionType: proposal.actionType,
        actionRef: proposal.actionRef,
        actionDigest: proposal.actionDigest,
        previewDigest: proposal.previewDigest,
      };
      const pending = createApprovalRequest({
        id: approvalRequestId,
        projectId: authorityProjectId,
        action,
        risk: 'critical',
        decisionMode: 'separation_of_duty',
        requestedBy: requester,
        requestedAtMs: proposal.createdAtMs,
        expiresAtMs: proposal.createdAtMs + 10_000,
        requestFence: fence,
      });
      const approvals = new PostgresApprovalRequestRepository(manager.pool);
      assert.equal(
        (
          await approvals.create({
            request: pending,
            audit: transitionAudit({
              eventId: `41000000-0000-4000-8000-0000000000${ordinal}1`,
              requestId: approvalRequestId,
              operationId: 'approval.request',
              subject: requester,
              authenticationId: `auth-trust-owner-${ordinal}`,
              outcome: 'approval_required',
              reasons: ['publisher_trust_transition_review'],
              occurredAtMs: proposal.createdAtMs,
            }),
          })
        ).status,
        'created',
      );
      const decided = await approvals.decide({
        requestId: approvalRequestId,
        expectedVersion: 1,
        decisionId: `decision-trust-transition-${ordinal}`,
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: {
          subject: reviewer,
          authenticationId: `auth-trust-reviewer-${ordinal}`,
          authenticatedAtMs: proposal.createdAtMs,
          expiresAtMs: proposal.createdAtMs + 9_000,
          assurance: 'multi_factor',
        },
        decidedAtMs: proposal.createdAtMs + 10,
        authorizationFence: fence,
        audit: transitionAudit({
          eventId: `41000000-0000-4000-8000-0000000000${ordinal}2`,
          requestId: approvalRequestId,
          operationId: 'approval.decide',
          subject: reviewer,
          authenticationId: `auth-trust-reviewer-${ordinal}`,
          outcome: 'allowed',
          reasons: ['publisher_trust_transition_approved'],
          occurredAtMs: proposal.createdAtMs + 10,
        }),
      });
      assert.equal(decided.status, 'decided');
      const consumed = await new PostgresApprovalRequestRepository(
        packageExecutor.pool,
      ).consume({
        requestId: approvalRequestId,
        expectedVersion: 2,
        consumptionId: `consume-trust-transition-${ordinal}`,
        dispatchId,
        action,
        requestedBy: requester,
        consumedBy: executor,
        consumedAtMs: proposal.createdAtMs + 20,
        authorizationFence: fence,
        audit: transitionAudit({
          eventId: `41000000-0000-4000-8000-0000000000${ordinal}3`,
          requestId: approvalRequestId,
          operationId: 'approval.consume',
          subject: executor,
          authenticationId: 'cluster-package-executor',
          outcome: 'allowed',
          reasons: ['publisher_trust_transition_execution'],
          occurredAtMs: proposal.createdAtMs + 20,
        }),
      });
      assert.equal(consumed.status, 'consumed');
      return consumed.dispatch;
    }

    const managerDatabase = await open('package-manager');
    const executorDatabase = await open('package-executor');
    try {
      const authority =
        new PostgresPluginPackagePublisherTrustAuthorityRepository(
          managerDatabase.pool,
        );
      assert.equal(
        (
          await authority.observeSnapshot({
            authorityId: trustAuthorityId,
            observedBy: 'postgres-transition-integration',
            observedAtMs: 100,
            snapshot: initialSnapshot,
          })
        ).status,
        'created',
      );
      const proposals =
        new PostgresPluginPackagePublisherTrustTransitionProposalRepository(
          managerDatabase.pool,
        );
      const transitions =
        new PostgresPluginPackagePublisherTrustTransitionRepository(
          executorDatabase.pool,
        );

      const overlap = createPluginPackagePublisherTrustTransitionProposal({
        actionRef: 'publisher-overlap:publisher-transition.example:key-new',
        authorityProjectId,
        trustAuthorityId,
        trustGeneration: 1,
        mode: 'overlap_add',
        trustSnapshot: initialSnapshot,
        materialSnapshot,
        publisher: oldDefinition.publisher,
        keyId: newDefinition.keyId,
        proposedBy: requester,
        proposerAssurance: 'multi_factor',
        proposalFence: fence,
        createdAtMs: 200,
      });
      const overlapAudit = transitionAudit({
        eventId: '42000000-0000-4000-8000-000000000001',
        requestId: overlap.proposal.actionRef,
        operationId: 'plugin_package.publisher_trust_transition.propose',
        subject: requester,
        authenticationId: 'auth-trust-owner-overlap',
        outcome: 'allowed',
        reasons: ['publisher_trust_transition_proposal'],
        occurredAtMs: overlap.proposal.createdAtMs,
      });
      assert.equal(
        (
          await proposals.createProposal({
            proposal: overlap.proposal,
            candidateSnapshot: overlap.candidateSnapshot,
            audit: overlapAudit,
          })
        ).status,
        'created',
      );
      const overlapDispatch = await approveTransition({
        manager: managerDatabase,
        packageExecutor: executorDatabase,
        proposal: overlap.proposal,
        approvalRequestId: 'approval-trust-overlap-integration',
        dispatchId: 'dispatch-trust-overlap-integration',
        ordinal: 1,
      });
      const overlapResult = await transitions.applyApprovedTransition({
        dispatch: overlapDispatch,
        executedAtMs: 230,
      });
      assert.equal(overlapResult.status, 'created');
      assert.equal(overlapResult.head.generation, 2);
      assert.equal(overlapResult.receipt.mode, 'overlap_add');

      const retirement = createPluginPackagePublisherTrustTransitionProposal({
        actionRef: 'publisher-retire:publisher-transition.example:key-old',
        authorityProjectId,
        trustAuthorityId,
        trustGeneration: 2,
        mode: 'safe_retire',
        trustSnapshot: overlap.candidateSnapshot,
        publisher: oldDefinition.publisher,
        keyId: oldDefinition.keyId,
        proposedBy: requester,
        proposerAssurance: 'multi_factor',
        proposalFence: fence,
        createdAtMs: 300,
      });
      const retirementAudit = transitionAudit({
        eventId: '42000000-0000-4000-8000-000000000002',
        requestId: retirement.proposal.actionRef,
        operationId: 'plugin_package.publisher_trust_transition.propose',
        subject: requester,
        authenticationId: 'auth-trust-owner-retire',
        outcome: 'allowed',
        reasons: ['publisher_trust_transition_proposal'],
        occurredAtMs: retirement.proposal.createdAtMs,
      });
      assert.equal(
        (
          await proposals.createProposal({
            proposal: retirement.proposal,
            candidateSnapshot: retirement.candidateSnapshot,
            audit: retirementAudit,
          })
        ).status,
        'created',
      );
      const retirementDispatch = await approveTransition({
        manager: managerDatabase,
        packageExecutor: executorDatabase,
        proposal: retirement.proposal,
        approvalRequestId: 'approval-trust-retire-integration',
        dispatchId: 'dispatch-trust-retire-integration',
        ordinal: 2,
      });
      const retirementResult = await transitions.applyApprovedTransition({
        dispatch: retirementDispatch,
        executedAtMs: 330,
      });
      assert.equal(retirementResult.status, 'created');
      assert.equal(retirementResult.head.generation, 3);
      assert.equal(retirementResult.receipt.mode, 'safe_retire');
      assert.equal(retirementResult.receipt.retirementMatchingInstallations, 0);
      const replay = await transitions.applyApprovedTransition({
        dispatch: retirementDispatch,
        executedAtMs: 330,
      });
      assert.equal(replay.status, 'existing');
      assert.deepEqual(replay.receipt, retirementResult.receipt);

      const facts = await executorDatabase.pool.query(
        `SELECT head.generation,
                head.effective_trust_digest AS "effectiveTrustDigest",
                (
                  SELECT count(*)::integer
                  FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
                  WHERE authority_id = $1
                ) AS "receiptCount"
         FROM "ql3"."plugin_package_publisher_trust_heads" AS head
         WHERE head.authority_id = $1`,
        [trustAuthorityId],
      );
      assert.deepEqual(facts.rows, [
        {
          generation: 3,
          effectiveTrustDigest: retirement.candidateSnapshot.snapshotDigest,
          receiptCount: 2,
        },
      ]);
    } finally {
      await Promise.all([managerDatabase.close(), executorDatabase.close()]);
    }
  });

  test('PostgreSQL signer fence gives stage and safe retirement exactly one winner', async () => {
    const migrationDatabase = await open('migration');
    const managerDatabase = await open('package-manager');
    const executorDatabase = await open('package-executor');
    const fence = { projectVersion: 1, bindingVersion: 1 };
    const executorSubject = {
      type: 'system',
      id: 'cluster_package_executor',
    };

    function raceAudit({
      eventId,
      requestId,
      operationId,
      projectId,
      subject,
      authenticationId,
      outcome,
      reasons,
      occurredAtMs,
    }) {
      return {
        eventId,
        requestId,
        operationId,
        projectId,
        subject,
        authenticationId,
        outcome,
        reasons,
        fence,
        occurredAtMs,
      };
    }

    async function prepareRace(ordinal, expectedWinner) {
      const authorityProjectId = `trust-race-authority-${ordinal}`;
      const trustAuthorityId = `trust-race-${ordinal}`;
      const requester = {
        type: 'user',
        id: `usr-trust-race-owner-${ordinal}`,
      };
      const reviewer = {
        type: 'user',
        id: `usr-trust-race-reviewer-${ordinal}`,
      };
      const publisher = `publisher-race-${ordinal}.example`;
      const oldKeyId = 'key-old';
      const successorKeyId = 'key-new';
      const oldPair = generateKeyPairSync('ed25519');
      const successorPair = generateKeyPairSync('ed25519');
      const oldDefinition = {
        publisher,
        keyId: oldKeyId,
        publicKeyPem: oldPair.publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
        notBeforeMs: 0,
        notAfterMs: 100_000,
      };
      const successorDefinition = {
        publisher,
        keyId: successorKeyId,
        publicKeyPem: successorPair.publicKey.export({
          type: 'spki',
          format: 'pem',
        }),
        notBeforeMs: 0,
        notAfterMs: 100_000,
      };
      const snapshot = createPluginPackagePublisherTrustSnapshot([
        oldDefinition,
        successorDefinition,
      ]);
      const fixture = pluginPackageTaskReconciliationFixture(
        `trust-race-${expectedWinner}-${ordinal}`,
        { profile: 'cluster-control' },
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES
           ($1, $1, $1, 'active', 1, 1, 1),
           ($2, $2, $2, 'active', 1, 1, 1)`,
        [authorityProjectId, fixture.projectId],
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES
           ($1, 'user', $2, 1, 'active', 'owner', $4,
            'system', 'integration', 1),
           ($1, 'user', $3, 1, 'active', 'admin', $5,
            'system', 'integration', 1)`,
        [
          authorityProjectId,
          requester.id,
          reviewer.id,
          `grant-trust-race-owner-${ordinal}`,
          `grant-trust-race-reviewer-${ordinal}`,
        ],
      );
      assert.equal(
        (
          await new PostgresPluginPackagePublisherTrustAuthorityRepository(
            managerDatabase.pool,
          ).observeSnapshot({
            authorityId: trustAuthorityId,
            observedBy: `trust-race-observer-${ordinal}`,
            observedAtMs: 1_000,
            snapshot,
          })
        ).status,
        'created',
      );
      const retirement = createPluginPackagePublisherTrustTransitionProposal({
        actionRef: `publisher-retire:${publisher}:${oldKeyId}`,
        authorityProjectId,
        trustAuthorityId,
        trustGeneration: 1,
        mode: 'safe_retire',
        trustSnapshot: snapshot,
        publisher,
        keyId: oldKeyId,
        proposedBy: requester,
        proposerAssurance: 'multi_factor',
        proposalFence: fence,
        createdAtMs: 2_000 + ordinal * 100,
      });
      assert.equal(
        (
          await new PostgresPluginPackagePublisherTrustTransitionProposalRepository(
            managerDatabase.pool,
          ).createProposal({
            proposal: retirement.proposal,
            candidateSnapshot: retirement.candidateSnapshot,
            audit: raceAudit({
              eventId: `43000000-0000-4000-8000-0000000000${ordinal}0`,
              requestId: retirement.proposal.actionRef,
              operationId: 'plugin_package.publisher_trust_transition.propose',
              projectId: authorityProjectId,
              subject: requester,
              authenticationId: `auth-race-owner-${ordinal}`,
              outcome: 'allowed',
              reasons: ['publisher_trust_transition_proposal'],
              occurredAtMs: retirement.proposal.createdAtMs,
            }),
          })
        ).status,
        'created',
      );
      const action = {
        permission: retirement.proposal.permission,
        actionType: retirement.proposal.actionType,
        actionRef: retirement.proposal.actionRef,
        actionDigest: retirement.proposal.actionDigest,
        previewDigest: retirement.proposal.previewDigest,
      };
      const approvalRequestId = `approval-trust-race-${ordinal}`;
      const approvals = new PostgresApprovalRequestRepository(
        managerDatabase.pool,
      );
      assert.equal(
        (
          await approvals.create({
            request: createApprovalRequest({
              id: approvalRequestId,
              projectId: authorityProjectId,
              action,
              risk: 'critical',
              decisionMode: 'separation_of_duty',
              requestedBy: requester,
              requestedAtMs: retirement.proposal.createdAtMs,
              expiresAtMs: retirement.proposal.createdAtMs + 10_000,
              requestFence: fence,
            }),
            audit: raceAudit({
              eventId: `43000000-0000-4000-8000-0000000000${ordinal}1`,
              requestId: approvalRequestId,
              operationId: 'approval.request',
              projectId: authorityProjectId,
              subject: requester,
              authenticationId: `auth-race-owner-${ordinal}`,
              outcome: 'approval_required',
              reasons: ['publisher_trust_transition_review'],
              occurredAtMs: retirement.proposal.createdAtMs,
            }),
          })
        ).status,
        'created',
      );
      const decided = await approvals.decide({
        requestId: approvalRequestId,
        expectedVersion: 1,
        decisionId: `decision-trust-race-${ordinal}`,
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: {
          subject: reviewer,
          authenticationId: `auth-race-reviewer-${ordinal}`,
          authenticatedAtMs: retirement.proposal.createdAtMs,
          expiresAtMs: retirement.proposal.createdAtMs + 9_000,
          assurance: 'multi_factor',
        },
        decidedAtMs: retirement.proposal.createdAtMs + 10,
        authorizationFence: fence,
        audit: raceAudit({
          eventId: `43000000-0000-4000-8000-0000000000${ordinal}2`,
          requestId: approvalRequestId,
          operationId: 'approval.decide',
          projectId: authorityProjectId,
          subject: reviewer,
          authenticationId: `auth-race-reviewer-${ordinal}`,
          outcome: 'allowed',
          reasons: ['publisher_trust_transition_approved'],
          occurredAtMs: retirement.proposal.createdAtMs + 10,
        }),
      });
      assert.equal(decided.status, 'decided');
      const consumed = await new PostgresApprovalRequestRepository(
        executorDatabase.pool,
      ).consume({
        requestId: approvalRequestId,
        expectedVersion: 2,
        consumptionId: `consume-trust-race-${ordinal}`,
        dispatchId: `dispatch-trust-race-${ordinal}`,
        action,
        requestedBy: requester,
        consumedBy: executorSubject,
        consumedAtMs: retirement.proposal.createdAtMs + 20,
        authorizationFence: fence,
        audit: raceAudit({
          eventId: `43000000-0000-4000-8000-0000000000${ordinal}3`,
          requestId: approvalRequestId,
          operationId: 'approval.consume',
          projectId: authorityProjectId,
          subject: executorSubject,
          authenticationId: 'cluster-package-executor',
          outcome: 'allowed',
          reasons: ['publisher_trust_transition_execution'],
          occurredAtMs: retirement.proposal.createdAtMs + 20,
        }),
      });
      assert.equal(consumed.status, 'consumed');

      const installs = new PostgresPluginPackageInstallRepository(
        executorDatabase.pool,
      );
      await installs.create(fixture.install.create);
      const stageCommand = fixture.install.commits.find(
        ({ record }) => record.state === 'staged',
      );
      assert.ok(stageCommand);
      assert.ok(stageCommand.record.stageReceipt);
      const provenance = createPluginPackagePublisherProvenance({
        projectId: stageCommand.record.projectId,
        packageName: stageCommand.record.packageName,
        installationId: stageCommand.record.installationId,
        lockDigest: stageCommand.record.lockDigest,
        artifactDigest: stageCommand.record.stageReceipt.artifactDigest,
        manifestDigest: stageCommand.record.stageReceipt.manifestDigest,
        contentDigest: stageCommand.record.stageReceipt.contentDigest,
        stageEvidenceDigest: stageCommand.record.stageReceipt.evidenceDigest,
        signature: {
          publisher,
          keyId: oldKeyId,
          signatureDigest: createHash('sha256')
            .update(`trust-race-signature:${ordinal}`)
            .digest('hex'),
          keyNotBeforeMs: oldDefinition.notBeforeMs,
          keyNotAfterMs: oldDefinition.notAfterMs,
          verifiedAtMs: stageCommand.record.updatedAtMs,
        },
      });
      return {
        publisher,
        oldKeyId,
        trustAuthorityId,
        stageCommand,
        provenance,
        dispatch: consumed.dispatch,
        executedAtMs: retirement.proposal.createdAtMs + 30,
      };
    }

    async function waitForAdvisoryWaiters(expected) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const result = await migrationDatabase.pool.query(
          `SELECT count(*)::integer AS count
           FROM pg_locks AS lock
           JOIN pg_stat_activity AS activity
             ON activity.pid = lock.pid
           WHERE activity.usename = 'ql3_package_executor'
             AND lock.locktype = 'advisory'
             AND lock.granted = false`,
        );
        if (result.rows[0]?.count >= expected) {
          return result.rows[0].count;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `timed out waiting for ${expected} publisher signer waiters`,
      );
    }

    async function runRace(value, first) {
      const holder = await executorDatabase.pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`,
          [JSON.stringify([value.publisher, value.oldKeyId]), 774635229],
        );
        const provenanceRepository =
          new PostgresPluginPackagePublisherProvenanceRepository(
            executorDatabase.pool,
          );
        const transitionRepository =
          new PostgresPluginPackagePublisherTrustTransitionRepository(
            executorDatabase.pool,
          );
        const stage = () =>
          provenanceRepository.commitStage(
            value.stageCommand,
            value.provenance,
            value.trustAuthorityId,
          );
        const retire = () =>
          transitionRepository.applyApprovedTransition({
            dispatch: value.dispatch,
            executedAtMs: value.executedAtMs,
          });
        const settle = (operation) =>
          operation().then(
            (result) => ({ status: 'fulfilled', result }),
            (error) => ({ status: 'rejected', error }),
          );
        const firstPromise = settle(first === 'stage' ? stage : retire);
        await waitForAdvisoryWaiters(1);
        const secondPromise = settle(first === 'stage' ? retire : stage);
        await waitForAdvisoryWaiters(2);
        await holder.query('COMMIT');
        released = true;
        const [firstResult, secondResult] = await Promise.all([
          firstPromise,
          secondPromise,
        ]);
        return first === 'stage'
          ? { stage: firstResult, retire: secondResult }
          : { retire: firstResult, stage: secondResult };
      } finally {
        if (!released) {
          await holder.query('ROLLBACK').catch(() => undefined);
        }
        holder.release();
      }
    }

    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      const stageFirst = await prepareRace(1, 'stage');
      const stageWins = await runRace(stageFirst, 'stage');
      assert.equal(stageWins.stage.status, 'fulfilled');
      assert.equal(stageWins.stage.result.status, 'committed');
      assert.equal(stageWins.retire.status, 'rejected');
      assert.ok(
        stageWins.retire.error instanceof
          PluginPackagePublisherTrustTransitionConflictError,
      );

      const retireFirst = await prepareRace(2, 'retire');
      const retireWins = await runRace(retireFirst, 'retire');
      assert.equal(retireWins.retire.status, 'fulfilled');
      assert.equal(retireWins.retire.result.status, 'created');
      assert.equal(retireWins.stage.status, 'rejected');
      assert.ok(
        retireWins.stage.error instanceof
          PluginPackagePublisherProvenanceConflictError,
      );

      const facts = await migrationDatabase.pool.query(
        `SELECT
           (
             SELECT count(*)::integer
             FROM "ql3"."plugin_package_publisher_provenance"
             WHERE publisher = $1 AND key_id = 'key-old'
           ) AS "stageWinnerProvenance",
           (
             SELECT count(*)::integer
             FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
             WHERE authority_id = $2
           ) AS "stageWinnerReceipts",
           (
             SELECT generation::integer
             FROM "ql3"."plugin_package_publisher_trust_heads"
             WHERE authority_id = $3
           ) AS "retireWinnerGeneration",
           (
             SELECT count(*)::integer
             FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
             WHERE authority_id = $3
           ) AS "retireWinnerReceipts",
           (
             SELECT count(*)::integer
             FROM "ql3"."plugin_package_publisher_provenance"
             WHERE publisher = $4 AND key_id = 'key-old'
           ) AS "retireWinnerProvenance"`,
        [
          stageFirst.publisher,
          stageFirst.trustAuthorityId,
          retireFirst.trustAuthorityId,
          retireFirst.publisher,
        ],
      );
      assert.deepEqual(facts.rows, [
        {
          stageWinnerProvenance: 1,
          stageWinnerReceipts: 0,
          retireWinnerGeneration: 2,
          retireWinnerReceipts: 1,
          retireWinnerProvenance: 0,
        },
      ]);
    } finally {
      await Promise.all([
        managerDatabase.close(),
        executorDatabase.close(),
        migrationDatabase.close(),
      ]);
    }
  });

  test('PostgreSQL Package admission atomically binds dispatch, queued install, receipt and audit', async () => {
    const admittedAtMs = Date.now();
    const proposedAtMs = admittedAtMs - 40;
    const requestedAtMs = admittedAtMs - 30;
    const decidedAtMs = admittedAtMs - 20;
    const consumedAtMs = admittedAtMs - 10;
    const claimedAtMs = admittedAtMs - 5;
    const expiresAtMs = admittedAtMs + 60_000;
    const requester = {
      type: 'user',
      id: 'usr_package_admission_integration',
    };
    const dispatcher = {
      type: 'system',
      id: 'package-admission-dispatcher',
    };
    const action = admissionPackageAction();
    const binding = {
      permission: 'package.manage',
      actionType: PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
      actionRef: 'proposal:postgres-monitor-v1',
      actionDigest: pluginPackageInstallActionDigest(action.input),
      previewDigest: pluginPackageInstallPlanDigest(action.plan),
    };
    const request = createApprovalRequest({
      id: 'approval-package-admission-integration-1',
      projectId: 'default',
      action: binding,
      risk: 'high',
      decisionMode: 'separation_of_duty',
      requestedBy: requester,
      requestedAtMs,
      expiresAtMs,
      requestFence: APPROVAL_FENCE,
    });
    const proposal = createPluginPackageInstallProposal({
      actionRef: binding.actionRef,
      actionInput: action.input,
      proposedBy: requester,
      proposalFence: APPROVAL_FENCE,
      createdAtMs: proposedAtMs,
    });
    const reviewer = {
      type: 'user',
      id: 'usr_package_admission_reviewer',
    };
    const audit = (
      eventId,
      requestId,
      operationId,
      subject,
      authenticationId,
      outcome,
      reasons,
      occurredAtMs,
    ) => ({
      eventId,
      requestId,
      operationId,
      projectId: 'default',
      subject,
      authenticationId,
      outcome,
      reasons,
      fence: APPROVAL_FENCE,
      occurredAtMs,
    });

    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `TRUNCATE TABLE
           "ql3"."plugin_package_admission_receipts",
           "ql3"."plugin_package_install_mutations",
           "ql3"."plugin_package_install_heads",
           "ql3"."plugin_package_installs",
           "ql3"."plugin_package_install_proposals",
           "ql3"."approved_action_dispatches",
           "ql3"."approval_requests"
         CASCADE`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."security_audit_events"
         WHERE event_id IN (
           '20000000-0000-4000-8000-000000000011',
           '20000000-0000-4000-8000-000000000012',
           '20000000-0000-4000-8000-000000000013',
           '20000000-0000-4000-8000-000000000014',
           '20000000-0000-4000-8000-000000000015'
         )`,
      );
      await migrationDatabase.pool.query(
        `DELETE FROM "ql3"."project_role_bindings"
         WHERE project_id = 'default'
           AND subject_type = 'user'
           AND subject_id IN (
             'usr_package_admission_integration',
             'usr_package_admission_reviewer'
           )`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."project_role_bindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES
           (
             'default', 'user', 'usr_package_admission_integration', 1,
             'active', 'owner', 'grant-package-admission-requester',
             'system', 'integration', 0
           ),
           (
             'default', 'user', 'usr_package_admission_reviewer', 1,
             'active', 'admin', 'grant-package-admission-reviewer',
             'system', 'integration', 0
           )`,
      );
    } finally {
      await migrationDatabase.close();
    }

    const managerDatabase = await open('package-manager');
    let consumed;
    try {
      await new PostgresPluginPackageInstallProposalRepository(
        managerDatabase.pool,
      ).createProposal({
        proposal,
        audit: audit(
          '20000000-0000-4000-8000-000000000015',
          binding.actionRef,
          'plugin_package.propose',
          requester,
          'auth-package-requester',
          'allowed',
          ['package_proposal'],
          proposedAtMs,
        ),
      });
      const approvals = new PostgresApprovalRequestRepository(
        managerDatabase.pool,
      );
      await approvals.create({
        request,
        audit: audit(
          '20000000-0000-4000-8000-000000000011',
          'http-package-admission-1',
          'approval.request',
          requester,
          'auth-package-requester',
          'approval_required',
          ['package_review'],
          requestedAtMs,
        ),
      });
      await approvals.decide({
        requestId: request.id,
        expectedVersion: 1,
        decisionId: 'decision-package-admission-integration-1',
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: {
          subject: reviewer,
          authenticationId: 'auth-package-reviewer',
          authenticatedAtMs: requestedAtMs,
          expiresAtMs,
          assurance: 'multi_factor',
        },
        decidedAtMs,
        authorizationFence: APPROVAL_FENCE,
        audit: audit(
          '20000000-0000-4000-8000-000000000012',
          'http-package-admission-1',
          'approval.decide',
          reviewer,
          'auth-package-reviewer',
          'allowed',
          ['role_grant'],
          decidedAtMs,
        ),
      });
    } finally {
      await managerDatabase.close();
    }

    const executorDatabase = await open('package-executor');
    try {
      const approvals = new PostgresApprovalRequestRepository(
        executorDatabase.pool,
      );
      consumed = await approvals.consume({
        requestId: request.id,
        expectedVersion: 2,
        consumptionId: 'consume-package-admission-integration-1',
        dispatchId: 'dispatch-package-admission-integration-1',
        action: binding,
        requestedBy: requester,
        consumedBy: dispatcher,
        consumedAtMs,
        authorizationFence: APPROVAL_FENCE,
        audit: audit(
          '20000000-0000-4000-8000-000000000013',
          'dispatch-package-admission-1',
          'approval.consume',
          dispatcher,
          'auth-package-dispatcher',
          'allowed',
          ['role_grant'],
          consumedAtMs,
        ),
      });
      const executions = new PostgresApprovedActionExecutionRepository(
        executorDatabase.pool,
      );
      const pendingSecretActions = await executions.listReconciliableExecutions(
        {
          nowMs: claimedAtMs,
          limit: 1,
          actionTypes: [consumed.dispatch.action.actionType],
        },
      );
      assert.equal(pendingSecretActions.truncated, false);
      assert.equal(pendingSecretActions.executions.length, 1);
      assert.equal(
        pendingSecretActions.executions[0].dispatch.id,
        consumed.dispatch.id,
      );
      assert.equal(
        pendingSecretActions.executions[0].execution.status,
        'pending',
      );
      const claimed = await executions.claimExecution({
        dispatchId: consumed.dispatch.id,
        owner: 'package_admission_dispatcher',
        leaseToken: 'lease-package-admission-integration-1',
        nowMs: claimedAtMs,
        leaseDurationMs: 60_000,
      });
      assert.equal(claimed.status, 'claimed');
      const started = await executions.startExecution({
        dispatchId: consumed.dispatch.id,
        approvalRequestId: consumed.dispatch.approvalRequestId,
        actionDigest: consumed.dispatch.action.actionDigest,
        owner: 'package_admission_dispatcher',
        leaseToken: 'lease-package-admission-integration-1',
        expectedVersion: claimed.snapshot.execution.version,
        startedAtMs: admittedAtMs,
      });
      const executingSecretActions =
        await executions.listReconciliableExecutions({
          nowMs: admittedAtMs,
          limit: 1,
          actionTypes: [consumed.dispatch.action.actionType],
        });
      assert.equal(executingSecretActions.truncated, false);
      assert.equal(executingSecretActions.executions.length, 1);
      assert.equal(
        executingSecretActions.executions[0].dispatch.id,
        consumed.dispatch.id,
      );
      assert.equal(
        executingSecretActions.executions[0].execution.status,
        'executing',
      );
      const lock = resolvePluginPackageInstallProposal(
        proposal,
        consumed.dispatch,
        admittedAtMs,
      );
      const admission = {
        lock,
        proposalDigest: proposal.proposalDigest,
        execution: started.execution,
        installationId: 'install-package-admission-integration-1',
        mutationId: 'admit-package-admission-integration-1',
        admittedAtMs,
        audit: audit(
          '20000000-0000-4000-8000-000000000014',
          consumed.dispatch.id,
          'plugin_package.admit',
          dispatcher,
          'auth-package-dispatcher',
          'allowed',
          ['approved_action'],
          admittedAtMs,
        ),
      };
      const repository = new PostgresPluginPackageInstallRepository(
        executorDatabase.pool,
      );
      const admitted = await repository.admit(admission);
      assert.equal(admitted.status, 'admitted');
      assert.equal(admitted.record.state, 'queued');
      assert.equal((await repository.admit(admission)).status, 'existing');
      assert.deepEqual(
        await repository.findAdmissionReceipt(consumed.dispatch.id),
        admitted.receipt,
      );

      const staged = transitionPluginPackageInstall(lock, admitted.record, {
        type: 'stage_completed',
        mutationId: 'stage-package-secret-binding-integration-1',
        occurredAtMs: admittedAtMs + 1,
        stageRef: `stage:${lock.lockDigest}`,
        artifactDigest: lock.source.artifactDigest,
        manifestDigest: lock.manifestDigest,
        contentDigest: lock.source.contentDigest,
        evidenceDigest: 'd'.repeat(64),
      });
      const stageProvenance = createPluginPackagePublisherProvenance({
        projectId: staged.projectId,
        packageName: staged.packageName,
        installationId: staged.installationId,
        lockDigest: staged.lockDigest,
        artifactDigest: staged.stageReceipt.artifactDigest,
        manifestDigest: staged.stageReceipt.manifestDigest,
        contentDigest: staged.stageReceipt.contentDigest,
        stageEvidenceDigest: staged.stageReceipt.evidenceDigest,
        signature: {
          publisher: 'integration.qinglong.dev',
          keyId: 'integration-key-1',
          signatureDigest: 'e'.repeat(64),
          keyNotBeforeMs: 0,
          keyNotAfterMs: admittedAtMs + 60_000,
          verifiedAtMs: admittedAtMs,
        },
      });
      await executorDatabase.pool.query(
        `INSERT INTO "ql3"."plugin_package_publisher_provenance" (
           installation_id, project_id, package_name, lock_digest,
           artifact_digest, manifest_digest, content_digest,
           stage_evidence_digest, publisher, key_id, signature_digest,
           key_not_before_ms, key_not_after_ms, verified_at_ms,
           provenance_digest, provenance_json
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16::jsonb
         )`,
        [
          stageProvenance.installationId,
          stageProvenance.projectId,
          stageProvenance.packageName,
          stageProvenance.lockDigest,
          stageProvenance.artifactDigest,
          stageProvenance.manifestDigest,
          stageProvenance.contentDigest,
          stageProvenance.stageEvidenceDigest,
          stageProvenance.publisher,
          stageProvenance.keyId,
          stageProvenance.signatureDigest,
          stageProvenance.keyNotBeforeMs,
          stageProvenance.keyNotAfterMs,
          stageProvenance.verifiedAtMs,
          stageProvenance.provenanceDigest,
          JSON.stringify(stageProvenance),
        ],
      );
      await repository.commit(
        pluginPackageInstallCommit(admitted.record, staged),
      );
      const activating = transitionPluginPackageInstall(lock, staged, {
        type: 'activation_started',
        mutationId: 'activate-package-secret-binding-integration-1',
        occurredAtMs: admittedAtMs + 2,
      });
      await repository.commit(pluginPackageInstallCommit(staged, activating));
      const active = transitionPluginPackageInstall(lock, activating, {
        type: 'activation_committed',
        mutationId: 'commit-package-secret-binding-integration-1',
        occurredAtMs: admittedAtMs + 3,
        activationRef: `active:${lock.lockDigest}`,
        intentDigest: pluginPackageActivationIntentDigest(lock, activating),
        generation: lock.targetGeneration,
        contentDigest: lock.source.contentDigest,
      });
      await repository.commit(pluginPackageInstallCommit(activating, active));
    } finally {
      await executorDatabase.close();
    }

    const bindingManagerDatabase = await open('package-manager');
    let approvalPlan;
    try {
      const plans =
        new PostgresPluginPackageSecretBindingApprovalPlanRepository(
          bindingManagerDatabase.pool,
        );
      const snapshot = await plans.loadPlanningSnapshot(
        'default',
        'postgres-monitor',
      );
      assert.ok(snapshot);
      const generation = createPluginPackageResourceGenerationFromReferences({
        installationId: snapshot.record.installationId,
        projectId: snapshot.record.projectId,
        packageName: snapshot.record.packageName,
        lockDigest: snapshot.record.lockDigest,
        generation: snapshot.record.targetGeneration,
        previousActiveLockDigest: snapshot.record.previousActiveLockDigest,
        contentDigest: snapshot.lock.source.contentDigest,
        resources: [],
      });
      const bindingPlan = createPluginPackageSecretBindingPlan({
        generation,
        manifest: snapshot.proposal.actionInput.manifest,
        assignments: [
          {
            name: 'TOKEN',
            secretRef: createSecretRef({
              projectId: 'default',
              name: 'postgres-monitor-token',
              version: 1,
            }),
          },
        ],
        plannedAtMs: snapshot.observedAtMs,
      });
      approvalPlan = createPluginPackageSecretBindingApprovalPlan({
        actionRef: 'secret-binding:postgres-monitor-v1',
        bindingPlan,
        requestedBy: requester,
        expiresAtMs: snapshot.observedAtMs + 60_000,
      });
      assert.equal((await plans.create(approvalPlan)).status, 'created');
      assert.equal((await plans.create(approvalPlan)).status, 'existing');
      await assert.rejects(
        bindingManagerDatabase.pool.query(
          `INSERT INTO "ql3"."plugin_package_secret_binding_approval_plans" (
             action_ref
           ) VALUES ('forbidden-direct-manager-insert')`,
        ),
        (error) => error?.code === '42501',
      );
    } finally {
      await bindingManagerDatabase.close();
    }

    const bindingExecutorDatabase = await open('package-executor');
    try {
      assert.deepEqual(
        await new PostgresPluginPackageSecretBindingApprovalPlanReader(
          bindingExecutorDatabase.pool,
        ).findByActionRef(approvalPlan.actionRef),
        approvalPlan,
      );
      await assert.rejects(
        bindingExecutorDatabase.pool.query(
          `SELECT "ql3"."create_plugin_package_secret_binding_approval_plan"(
             $1::jsonb
           )`,
          [JSON.stringify(approvalPlan)],
        ),
        (error) => error?.code === '42501',
      );
    } finally {
      await bindingExecutorDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      await assert.rejects(
        runtimeDatabase.pool.query(
          `SELECT *
             FROM "ql3"."plugin_package_secret_binding_planning_snapshot"(
               'default', 'postgres-monitor'
             )`,
        ),
        (error) => error?.code === '42501',
      );
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const facts = await verificationDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_installs") AS installs,
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_install_mutations") AS mutations,
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_admission_receipts") AS receipts,
           (SELECT count(*)::integer
              FROM "ql3"."security_audit_events"
             WHERE operation_id = 'plugin_package.admit') AS audits,
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_secret_binding_approval_plans")
             AS "approvalPlans"`,
      );
      assert.deepEqual(facts.rows[0], {
        installs: 1,
        mutations: 4,
        receipts: 1,
        audits: 1,
        approvalPlans: 1,
      });
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL Project Policy repository fences concurrent RoleBinding append', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."project_role_bindings"',
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      const repository = new PostgresProjectPolicyRepository(
        runtimeDatabase.pool,
      );
      const command = (mutationId, role) => ({
        expectedCurrentVersion: 0,
        binding: {
          projectId: 'default',
          subject: { type: 'user', id: 'usr_concurrent' },
          version: 1,
          state: 'active',
          role,
          mutationId,
          changedBy: { type: 'system', id: 'integration' },
          createdAtMs: 1,
        },
      });
      const commands = [
        command('grant-owner', 'owner'),
        command('grant-viewer', 'viewer'),
      ];
      const results = await Promise.allSettled(
        commands.map((candidate) => repository.append(candidate)),
      );
      const fulfilled = results
        .map((result, index) => ({ result, command: commands[index] }))
        .find(({ result }) => result.status === 'fulfilled');
      const rejected = results.find((result) => result.status === 'rejected');
      assert.ok(fulfilled);
      assert.equal(
        rejected?.status === 'rejected' &&
          rejected.reason instanceof ProjectRoleBindingVersionConflictError,
        true,
      );
      assert.equal(
        (await repository.append(fulfilled.command)).status,
        'existing',
      );
      const snapshot = await repository.resolve('default', {
        type: 'user',
        id: 'usr_concurrent',
      });
      assert.equal(snapshot.project.version, 1);
      assert.equal(
        snapshot.binding.mutationId,
        fulfilled.command.binding.mutationId,
      );
      assert.equal(snapshot.binding.version, 1);
    } finally {
      await runtimeDatabase.close();
    }
  });

  test('PostgreSQL recovery source separates stale ownership from normal active work', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, created_at_ms
         ) VALUES
           ('run-created', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'created', 1),
           ('run-valid', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'running', 2),
           ('run-stale', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'running', 3),
           ('run-queued', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'queued', 5),
           ('run-queued-pristine', 'default', 'task', 'v1', 'cron', 'scheduled_system', 'runtime', 'queued', 6),
           ('run-queued-drift', 'default', 'task', 'v1', 'cron', 'scheduled_system', 'runtime', 'queued', 7),
           ('run-waiting', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'waiting_approval', 6)`,
      );
      await migrationDatabase.pool.query(
        `UPDATE "ql3"."runs"
         SET queued_at_ms = created_at_ms
         WHERE id IN ('run-queued-pristine', 'run-queued-drift')`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           lease_expires_at_ms, callback_sequence, created_at_ms
         ) VALUES
           (
             'attempt-valid', 'run-valid', 1, 'running', 'worker',
             floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint + 60000, 0,
             2
           ),
           (
             'attempt-stale', 'run-stale', 1, 'running', 'worker',
             floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - 1, 0,
             4
           ),
           (
             'attempt-queued-pristine', 'run-queued-pristine', 1, 'claimed',
             'remote_worker', NULL, 0, 6
           ),
           (
             'attempt-queued-drift', 'run-queued-drift', 1, 'claimed',
             'remote_worker', NULL, 1, 7
           )`,
      );

      const source = new PostgresClusterControlRecoverySource(
        migrationDatabase.pool,
      );
      const page = await source.listOutstanding(10);
      assert.equal(Number.isSafeInteger(page.observedAtMs), true);
      assert.deepEqual(
        { candidates: page.candidates, hasMore: page.hasMore },
        {
          candidates: [
            {
              kind: 'run',
              id: 'run-created',
              runId: 'run-created',
              status: 'created',
              createdAtMs: 1,
            },
            {
              kind: 'run',
              id: 'run-stale',
              runId: 'run-stale',
              status: 'running',
              createdAtMs: 3,
            },
            {
              kind: 'attempt',
              id: 'attempt-stale',
              runId: 'run-stale',
              status: 'running',
              createdAtMs: 4,
            },
            {
              kind: 'attempt',
              id: 'attempt-queued-drift',
              runId: 'run-queued-drift',
              status: 'claimed',
              createdAtMs: 7,
            },
          ],
          hasMore: false,
        },
      );
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL recovery claims fence concurrent replicas, takeover and settlement', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, created_at_ms
         ) VALUES (
           'run-claim', 'default', 'task', 'v1', 'manual',
           'api', 'runtime', 'queued', 1
         )`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           lease_expires_at_ms, created_at_ms
         ) VALUES (
           'attempt-claim', 'run-claim', 1, 'running', 'worker',
           floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - 1,
           4102444800000
         )`,
      );

      const replicaA = new PostgresClusterControlRecoveryClaimRepository(
        migrationDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000a1',
      );
      const replicaB = new PostgresClusterControlRecoveryClaimRepository(
        migrationDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000b1',
      );
      const [pageA, pageB] = await Promise.all([
        replicaA.claim({ ownerId: 'replica-a', limit: 1, leaseMs: 30_000 }),
        replicaB.claim({ ownerId: 'replica-b', limit: 1, leaseMs: 30_000 }),
      ]);
      const first = [...pageA.claims, ...pageB.claims];
      assert.equal(first.length, 1);
      assert.equal(first[0].candidate.id, 'attempt-claim');
      assert.equal(pageA.discovered, 1);
      assert.equal(pageB.discovered, 1);

      const activeFollower = await replicaB.claim({
        ownerId: 'replica-b',
        limit: 1,
        leaseMs: 30_000,
      });
      assert.equal(activeFollower.claims.length, 0);

      await migrationDatabase.pool.query(
        `UPDATE "ql3"."run_recovery_controls"
         SET claim_expires_at_ms = 0
         WHERE target_kind = 'attempt' AND target_id = 'attempt-claim'`,
      );
      const takeover = await replicaB.claim({
        ownerId: 'replica-b',
        limit: 1,
        leaseMs: 30_000,
      });
      assert.equal(takeover.claims.length, 1);
      assert.equal(takeover.claims[0].version, first[0].version + 1);
      const firstRepository =
        first[0].ownerId === 'replica-a' ? replicaA : replicaB;
      assert.equal(
        await firstRepository.settle(first[0], { status: 'resolved' }),
        'fenced',
      );
      assert.equal(
        await replicaB.settle(takeover.claims[0], { status: 'resolved' }),
        'settled',
      );

      const reclaimed = await replicaA.claim({
        ownerId: 'replica-a',
        limit: 1,
        leaseMs: 30_000,
      });
      assert.equal(reclaimed.claims.length, 1);
      assert.equal(
        await replicaA.settle(reclaimed.claims[0], {
          status: 'retry',
          delayMs: 60_000,
        }),
        'settled',
      );
      assert.equal(
        (
          await replicaB.claim({
            ownerId: 'replica-b',
            limit: 1,
            leaseMs: 30_000,
          })
        ).claims.length,
        0,
      );
      await migrationDatabase.pool.query(
        `UPDATE "ql3"."run_recovery_controls"
         SET next_claim_at_ms = 0
         WHERE target_kind = 'attempt' AND target_id = 'attempt-claim'`,
      );
      const manual = await replicaB.claim({
        ownerId: 'replica-b',
        limit: 1,
        leaseMs: 30_000,
      });
      assert.equal(manual.claims.length, 1);
      assert.equal(
        await replicaB.settle(manual.claims[0], { status: 'manual' }),
        'settled',
      );
      assert.equal(
        (
          await replicaA.claim({
            ownerId: 'replica-a',
            limit: 1,
            leaseMs: 30_000,
          })
        ).claims.length,
        0,
      );
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL recovery processor atomically loses an unstarted aggregate without probing or replay', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, created_at_ms
         ) VALUES (
           'run-unstarted', 'default', 'task', 'v1', 'manual',
           'manual', 'runtime', 'dispatching', 1, 0, 1
         )`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type,
           lease_token, lease_expires_at_ms, created_at_ms
         ) VALUES (
           'attempt-unstarted', 'run-unstarted', 1, 'claimed', 'worker',
           'execution-lease',
           floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - 1,
           2
         )`,
      );

      const claims = new PostgresClusterControlRecoveryClaimRepository(
        migrationDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000c1',
      );
      const transitions =
        new PostgresClusterControlRecoveryResolutionRepository(
          migrationDatabase.pool,
        );
      const processor = new EvidenceBasedClusterControlRecoveryProcessor(
        transitions,
        {
          async inspect() {
            throw new Error(
              'claimed Attempt must not cross the probe boundary',
            );
          },
        },
      );
      const supervisor = new ClusterControlRecoverySupervisor(
        claims,
        processor,
        { ownerId: 'replica-c', limit: 8, leaseMs: 30_000 },
      );

      assert.deepEqual(await supervisor.reconcile(), {
        safe: true,
        remaining: 0,
        failed: 0,
      });
      const facts = await migrationDatabase.pool.query(
        `SELECT
           run.status AS "runStatus",
           run.version AS "runVersion",
           run.event_sequence AS "eventSequence",
           attempt.status AS "attemptStatus",
           attempt.lease_token AS "leaseToken",
           array_agg(event.type ORDER BY event.sequence) AS events
         FROM "ql3"."runs" AS run
         INNER JOIN "ql3"."run_attempts" AS attempt
           ON attempt.run_id = run.id
         INNER JOIN "ql3"."run_events" AS event
           ON event.run_id = run.id
         WHERE run.id = 'run-unstarted'
         GROUP BY run.id, attempt.id`,
      );
      assert.deepEqual(facts.rows, [
        {
          runStatus: 'lost',
          runVersion: 3,
          eventSequence: 2,
          attemptStatus: 'lost',
          leaseToken: 'execution-lease',
          events: ['attempt.lost', 'run.lost'],
        },
      ]);
      assert.equal(
        (
          await new PostgresClusterControlRecoverySource(
            migrationDatabase.pool,
          ).listOutstanding(1)
        ).candidates.length,
        0,
      );
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL recovery transition rejects an old probe owner after claim takeover', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_retry_policies", "ql3"."run_attempts", "ql3"."runs" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, version,
           event_sequence, created_at_ms, started_at_ms
         ) VALUES (
           'run-probe-fence', 'default', 'task', 'v1', 'manual',
           'manual', 'runtime', 'running', 1, 0, 1, 2
         )`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type, worker_id,
           executor_handle, lease_token, lease_expires_at_ms,
           created_at_ms, started_at_ms
         ) VALUES (
           'attempt-probe-fence', 'run-probe-fence', 1, 'running',
           'worker', 'worker-old', 'handle-old', 'lease-old',
           floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint - 1,
           2, 3
         )`,
      );

      const replicaA = new PostgresClusterControlRecoveryClaimRepository(
        migrationDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000a2',
      );
      const replicaB = new PostgresClusterControlRecoveryClaimRepository(
        migrationDatabase.pool,
        () => '00000000-0000-4000-8000-0000000000b2',
      );
      const firstPage = await replicaA.claim({
        ownerId: 'replica-a',
        limit: 8,
        leaseMs: 30_000,
      });
      const oldAttemptClaim = firstPage.claims.find(
        ({ candidate }) => candidate.kind === 'attempt',
      );
      assert.ok(oldAttemptClaim);

      const processor = new EvidenceBasedClusterControlRecoveryProcessor(
        new PostgresClusterControlRecoveryResolutionRepository(
          migrationDatabase.pool,
        ),
        {
          async inspect(_claim, target) {
            assert.equal(target.executorHandle, 'handle-old');
            await migrationDatabase.pool.query(
              `UPDATE "ql3"."run_recovery_controls"
               SET claim_expires_at_ms = 0
               WHERE target_kind = 'attempt'
                 AND target_id = 'attempt-probe-fence'`,
            );
            const takeover = await replicaB.claim({
              ownerId: 'replica-b',
              limit: 8,
              leaseMs: 30_000,
            });
            assert.equal(
              takeover.claims.some(
                ({ candidate }) => candidate.id === 'attempt-probe-fence',
              ),
              true,
            );
            return { status: 'not_running' };
          },
        },
      );

      await assert.rejects(
        processor.process(oldAttemptClaim),
        ClusterControlRecoveryFenceLostError,
      );
      const unchanged = await migrationDatabase.pool.query(
        `SELECT run.status AS "runStatus", attempt.status AS "attemptStatus"
         FROM "ql3"."runs" AS run
         INNER JOIN "ql3"."run_attempts" AS attempt
           ON attempt.run_id = run.id
         WHERE run.id = 'run-probe-fence'`,
      );
      assert.deepEqual(unchanged.rows, [
        { runStatus: 'running', attemptStatus: 'running' },
      ]);
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL Project Policy constraints reject ambiguous authority facts', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await assert.rejects(
        migrationDatabase.pool.query(
          `INSERT INTO "ql3"."project_role_bindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES (
             'default', 'user', 'usr_invalid_role', 1, 'revoked', 'owner',
             'invalid-role-state', 'system', 'integration', 1
           )`,
        ),
        (error) =>
          error?.code === '23514' &&
          error?.constraint === 'ql3_project_role_bindings_role_state_check',
      );
      await assert.rejects(
        migrationDatabase.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ('invalid-time', 'Invalid', 'invalid-time', 'active', 1, 2, 1)`,
        ),
        (error) =>
          error?.code === '23514' &&
          error?.constraint === 'ql3_projects_updated_at_check',
      );
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL resolves the latest API credential and durably appends its security audit', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."security_audit_events", "ql3"."api_credentials", "ql3"."identity_subjects" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."identity_subjects" (
           subject_type, subject_id, status, version, created_at_ms, updated_at_ms
         ) VALUES ('api_app', 'app_integration', 'active', 1, 100, 100)`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."api_credentials" (
           credential_id, version, state, subject_type, subject_id,
           pepper_key_id, secret_digest, created_at_ms, not_before_at_ms,
           expires_at_ms
         ) VALUES
           ('credential_integration', 1, 'revoked', 'api_app', 'app_integration',
            'legacy-v1', $1, 100, 100, 1000),
           ('credential_integration', 2, 'active', 'api_app', 'app_integration',
            'legacy-v1', $2, 200, 200, 2000)`,
        ['a'.repeat(64), 'b'.repeat(64)],
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      const credentials = new PostgresApiCredentialRepository(
        runtimeDatabase.pool,
      );
      assert.deepEqual(await credentials.resolve('credential_integration'), {
        credentialId: 'credential_integration',
        version: 2,
        state: 'active',
        pepperKeyId: 'legacy-v1',
        subject: { type: 'api_app', id: 'app_integration' },
        subjectStatus: 'active',
        secretDigest: 'b'.repeat(64),
        createdAtMs: 200,
        notBeforeAtMs: 200,
        expiresAtMs: 2000,
      });

      const audit = new PostgresSecurityAuditRepository(runtimeDatabase.pool);
      await audit.record({
        eventId: '123e4567-e89b-42d3-a456-426614174101',
        requestId: 'request-integration',
        operationId: 'run.create',
        projectId: 'default',
        subject: { type: 'api_app', id: 'app_integration' },
        authenticationId: 'api_credential:credential_integration:2',
        outcome: 'allowed',
        reasons: ['role_grant'],
        fence: { projectVersion: 1, bindingVersion: 1 },
        occurredAtMs: 300,
      });
    } finally {
      await runtimeDatabase.close();
    }

    const verificationDatabase = await open('migration');
    try {
      const result = await verificationDatabase.pool.query(
        `SELECT outcome, subject_type AS "subjectType", reasons
         FROM "ql3"."security_audit_events"
         WHERE event_id = '123e4567-e89b-42d3-a456-426614174101'`,
      );
      assert.deepEqual(result.rows, [
        {
          outcome: 'allowed',
          subjectType: 'api_app',
          reasons: ['role_grant'],
        },
      ]);
    } finally {
      await verificationDatabase.close();
    }
  });

  test('PostgreSQL rejects credential and audit facts that blur trust boundaries', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."identity_subjects" (
           subject_type, subject_id, status, version, created_at_ms, updated_at_ms
         ) VALUES ('system', 'control_plane', 'active', 1, 100, 100)
         ON CONFLICT (subject_type, subject_id) DO NOTHING`,
      );
      await assert.rejects(
        migrationDatabase.pool.query(
          `INSERT INTO "ql3"."api_credentials" (
             credential_id, version, state, subject_type, subject_id,
             pepper_key_id, secret_digest, created_at_ms, not_before_at_ms,
             expires_at_ms
           ) VALUES (
             'system_must_not_bear', 1, 'active', 'system', 'control_plane',
             'legacy-v1', $1, 100, 100, 1000
           )`,
          ['c'.repeat(64)],
        ),
        (error) =>
          error?.code === '23514' &&
          error?.constraint === 'ql3_api_credentials_subject_type_check',
      );
      await assert.rejects(
        migrationDatabase.pool.query(
          `INSERT INTO "ql3"."security_audit_events" (
             event_id, request_id, operation_id, subject_type, subject_id,
             authentication_id, outcome, reasons, occurred_at_ms
           ) VALUES (
             '123e4567-e89b-42d3-a456-426614174102', 'rejected-request',
             'run.create', 'user', 'usr_should_be_absent', NULL,
             'authentication_rejected', '["authentication_failed"]'::jsonb, 100
           )`,
        ),
        (error) =>
          error?.code === '23514' &&
          error?.constraint === 'ql3_security_audit_events_identity_check',
      );
    } finally {
      await migrationDatabase.close();
    }
  });

  test('PostgreSQL row leases admit one long-identity Trigger occurrence atomically', async () => {
    const database = await open('migration');
    let schedulerDatabase;
    try {
      await runPostgresMigrations({ pool: database.pool });
      await database.pool.query(
        'TRUNCATE TABLE "ql3"."trigger_schedules", "ql3"."triggers", "ql3"."task_execution_revisions", "ql3"."task_definitions" CASCADE',
      );
      const definitionClock = await database.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                  AS "observedAtMs"`,
      );
      const definitionOccurredAtMs =
        Number(definitionClock.rows[0].observedAtMs) - 1_000;
      const taskId = `task-${'t'.repeat(48)}`;
      const triggerId = `trigger-${'g'.repeat(48)}`;
      const task = (
        await new PostgresTaskDefinitionRepository(
          database.pool,
        ).appendTaskDefinitionRevision({
          projectId: 'default',
          taskId,
          expectedRevision: null,
          mutationId: '019f7900-0000-7000-8000-000000000001',
          name: 'Cluster schedule integration',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: {
                kind: 'argv',
                file: '/bin/echo',
                args: ['cluster-schedule'],
              },
            },
          },
          labels: {},
          enabled: true,
          occurredAtMs: definitionOccurredAtMs,
        })
      ).definition;
      const trigger = (
        await new PostgresTriggerRepository(
          database.pool,
        ).appendTriggerRevision({
          projectId: 'default',
          triggerId,
          expectedRevision: null,
          mutationId: '019f7900-0000-7000-8000-000000000002',
          taskId: task.taskId,
          taskRevision: task.revision,
          taskContentDigest: task.contentDigest,
          spec: {
            schema: 'qinglong/cron@v1',
            config: {
              expression: '* * * * *',
              timezone: 'UTC',
              misfirePolicy: 'skip',
            },
          },
          enabled: true,
          occurredAtMs: definitionOccurredAtMs + 1,
        })
      ).trigger;
      assert.ok(trigger.triggerId.length > 36);

      schedulerDatabase =
        runtimeConnectionString === migrationConnectionString
          ? database
          : await open('runtime');
      const schedules = new PostgresClusterScheduleRepository(
        schedulerDatabase.pool,
      );
      const initializeClaim = await schedules.claimNextClusterSchedule({
        ownerId: 'scheduler-a',
        claimToken: '019f7900-0000-7000-8000-000000000003',
        leaseMs: 30_000,
      });
      assert.ok(initializeClaim);
      const initialize = resolveClusterScheduleDecision(
        initializeClaim,
        5_000,
        nextMinute,
      );
      const initializationIds = {
        runId: '019f7900-0000-7000-8000-000000000101',
        attemptId: '019f7900-0000-7000-8000-000000000102',
        createdEventId: '019f7900-0000-7000-8000-000000000103',
        queuedEventId: '019f7900-0000-7000-8000-000000000104',
      };
      const initialization = await schedules.commitClusterScheduleDecision({
        claim: initializeClaim,
        decision: initialize,
        ...(initialize.disposition === 'admit' ? initializationIds : {}),
      });
      assert.deepEqual(
        initialization,
        initialize.disposition === 'admit'
          ? {
              status: 'admitted',
              disposition: 'admit',
              runId: initializationIds.runId,
              attemptId: initializationIds.attemptId,
            }
          : { status: 'advanced', disposition: initialize.disposition },
      );

      const forcedDueResult = await database.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                  AS "observedAtMs"`,
      );
      const forcedDueAtMs = Number(forcedDueResult.rows[0].observedAtMs);
      await database.pool.query(
        `UPDATE "ql3"."trigger_schedules"
         SET next_fire_at_ms = $1,
             state_version = state_version + 1,
             updated_at_ms = $1
         WHERE project_id = $2 AND trigger_id = $3`,
        [forcedDueAtMs, 'default', triggerId],
      );

      const dueClaim = await schedules.claimNextClusterSchedule({
        ownerId: 'scheduler-a',
        claimToken: '019f7900-0000-7000-8000-000000000004',
        leaseMs: 30_000,
      });
      assert.ok(dueClaim);
      const decision = resolveClusterScheduleDecision(
        dueClaim,
        5_000,
        nextMinute,
      );
      assert.equal(decision.disposition, 'admit');
      const ids = {
        runId: '019f7900-0000-7000-8000-000000000005',
        attemptId: '019f7900-0000-7000-8000-000000000006',
        createdEventId: '019f7900-0000-7000-8000-000000000007',
        queuedEventId: '019f7900-0000-7000-8000-000000000008',
      };
      assert.deepEqual(
        await schedules.commitClusterScheduleDecision({
          claim: dueClaim,
          decision,
          ...ids,
        }),
        {
          status: 'admitted',
          disposition: 'admit',
          runId: ids.runId,
          attemptId: ids.attemptId,
        },
      );
      const aggregate = await database.pool.query(
        `SELECT run.trigger_id AS "triggerId", run.status,
                run.scheduled_for_ms AS "scheduledForMs",
                attempt.status AS "attemptStatus",
                attempt.executor_type AS "executorType",
                schedule.last_scheduled_at_ms AS "lastScheduledAtMs",
                schedule.claim_token AS "claimToken",
                count(event.id)::integer AS "eventCount"
         FROM "ql3"."runs" AS run
         JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
         JOIN "ql3"."run_events" AS event ON event.run_id = run.id
         JOIN "ql3"."trigger_schedules" AS schedule
           ON schedule.project_id = run.project_id
          AND schedule.trigger_id = run.trigger_id
         WHERE run.id = $1
         GROUP BY run.trigger_id, run.status, run.scheduled_for_ms,
                  attempt.status, attempt.executor_type,
                  schedule.last_scheduled_at_ms, schedule.claim_token`,
        [ids.runId],
      );
      assert.deepEqual(aggregate.rows, [
        {
          triggerId,
          status: 'queued',
          scheduledForMs: String(forcedDueAtMs),
          attemptStatus: 'claimed',
          executorType: 'remote_worker',
          lastScheduledAtMs: String(forcedDueAtMs),
          claimToken: null,
          eventCount: 2,
        },
      ]);
      await database.pool.query(
        `UPDATE "ql3"."trigger_schedules"
         SET next_fire_at_ms = $1
         WHERE project_id = $2 AND trigger_id = $3`,
        [forcedDueAtMs + 3_600_000, 'default', triggerId],
      );

      const takeoverTriggerId = `trigger-takeover-${'x'.repeat(32)}`;
      await new PostgresTriggerRepository(database.pool).appendTriggerRevision({
        projectId: 'default',
        triggerId: takeoverTriggerId,
        expectedRevision: null,
        mutationId: '019f7900-0000-7000-8000-000000000009',
        taskId: task.taskId,
        taskRevision: task.revision,
        taskContentDigest: task.contentDigest,
        spec: trigger.spec,
        enabled: true,
        occurredAtMs: forcedDueAtMs,
      });
      const competitors = await Promise.all([
        schedules.claimNextClusterSchedule({
          ownerId: 'scheduler-a',
          claimToken: '019f7900-0000-7000-8000-000000000010',
          leaseMs: 30_000,
        }),
        schedules.claimNextClusterSchedule({
          ownerId: 'scheduler-b',
          claimToken: '019f7900-0000-7000-8000-000000000011',
          leaseMs: 30_000,
        }),
      ]);
      assert.equal(competitors.filter(Boolean).length, 1);
      await database.pool.query(
        `UPDATE "ql3"."trigger_schedules"
         SET updated_at_ms = updated_at_ms - 2,
             claim_expires_at_ms = updated_at_ms - 1
         WHERE project_id = $1 AND trigger_id = $2`,
        ['default', takeoverTriggerId],
      );
      const takeover = await schedules.claimNextClusterSchedule({
        ownerId: 'scheduler-c',
        claimToken: '019f7900-0000-7000-8000-000000000012',
        leaseMs: 30_000,
      });
      assert.equal(takeover.triggerId, takeoverTriggerId);
      assert.equal(takeover.claimOwner, 'scheduler-c');
      assert.ok(takeover.claimVersion > competitors.find(Boolean).claimVersion);
      const takeoverDecision = resolveClusterScheduleDecision(
        takeover,
        5_000,
        nextMinute,
      );
      assert.deepEqual(
        await schedules.commitClusterScheduleDecision({
          claim: takeover,
          decision: takeoverDecision,
        }),
        { status: 'advanced', disposition: 'initialize' },
      );
    } finally {
      if (schedulerDatabase && schedulerDatabase !== database) {
        await schedulerDatabase.close();
      }
      await database.close();
    }
  });

  test(
    'PostgreSQL runtime role audits history but cannot execute DDL',
    {
      skip: process.env.QL3_TEST_POSTGRES_RUNTIME_URL
        ? false
        : 'requires a separate QL3_TEST_POSTGRES_RUNTIME_URL',
    },
    async () => {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
      } finally {
        await migrationDatabase.close();
      }

      const runtimeDatabase = await open('runtime');
      try {
        const readiness = await assertPostgresSchemaReady(runtimeDatabase.pool);
        assert.equal(readiness.ready, true);
        assert.equal(readiness.currentUser, 'ql3_runtime');
        const history = await readPostgresMigrationHistory(
          runtimeDatabase.pool,
        );
        assert.deepEqual(
          history.map(({ migrationId }) => migrationId),
          postgresqlMainMigrationStream.migrations.map(({ id }) => id),
        );
        await runtimeDatabase.pool.query(
          'SELECT contract_name, contract_version FROM "ql3"."schema_capabilities"',
        );
        await runtimeDatabase.pool.query(
          'SELECT subject_type, subject_id FROM "ql3"."identity_subjects" LIMIT 1',
        );
        await runtimeDatabase.pool.query(
          'SELECT credential_id, version FROM "ql3"."api_credentials" LIMIT 1',
        );
        await runtimeDatabase.pool.query(
          `INSERT INTO "ql3"."security_audit_events" (
             event_id, request_id, operation_id, outcome, reasons, occurred_at_ms
           ) VALUES (
             '123e4567-e89b-42d3-a456-426614174103', 'runtime-role-audit',
             'credential.authenticate', 'authentication_rejected',
             '["authentication_failed"]'::jsonb, 100
           )`,
        );
        await assert.rejects(
          runtimeDatabase.pool.query(
            'SELECT event_id FROM "ql3"."security_audit_events" LIMIT 1',
          ),
          (error) => error?.code === '42501',
        );
        for (const table of [
          'identity_subject_mutations',
          'api_credential_mutations',
        ]) {
          await assert.rejects(
            runtimeDatabase.pool.query(
              `SELECT mutation_id FROM "ql3"."${table}" LIMIT 1`,
            ),
            (error) => error?.code === '42501',
          );
          await assert.rejects(
            runtimeDatabase.pool.query(
              `INSERT INTO "ql3"."${table}" DEFAULT VALUES`,
            ),
            (error) => error?.code === '42501',
          );
        }
        await assert.rejects(
          runtimeDatabase.pool.query(
            `INSERT INTO "ql3"."api_credentials" (
               credential_id, version, state, subject_type, subject_id,
               pepper_key_id, secret_digest, created_at_ms, not_before_at_ms,
               expires_at_ms
             ) VALUES (
               'runtime_must_not_issue', 1, 'active', 'api_app', 'app_integration',
               'legacy-v1', $1, 100, 100, 1000
             )`,
            ['d'.repeat(64)],
          ),
          (error) => error?.code === '42501',
        );
        await assert.rejects(
          runtimeDatabase.pool.query(
            'CREATE TABLE "ql3"."runtime_role_must_not_create" (id integer)',
          ),
          (error) => error?.code === '42501',
        );
      } finally {
        await runtimeDatabase.close();
      }
    },
  );

  test(
    'PostgreSQL Package manager and executor roles pass their exact split readiness contracts',
    {
      skip:
        process.env.QL3_TEST_POSTGRES_PACKAGE_MANAGER_URL &&
        process.env.QL3_TEST_POSTGRES_PACKAGE_EXECUTOR_URL
          ? false
          : 'requires separate Package manager and executor URLs',
    },
    async () => {
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
      } finally {
        await migrationDatabase.close();
      }

      const managerDatabase = await open('package-manager');
      const executorDatabase = await open('package-executor');
      try {
        const [manager, executor] = await Promise.all([
          assertPostgresPackageManagerSchemaReady(managerDatabase.pool),
          assertPostgresPackageExecutorSchemaReady(executorDatabase.pool),
        ]);
        assert.equal(manager.currentUser, 'ql3_package_manager');
        assert.equal(executor.currentUser, 'ql3_package_executor');
      } finally {
        await Promise.all([managerDatabase.close(), executorDatabase.close()]);
      }
    },
  );

  test(
    'PostgreSQL automation manager atomically publishes current-head Task and Trigger into one scheduled Run',
    {
      skip:
        process.env.QL3_TEST_POSTGRES_AUTOMATION_MANAGER_URL &&
        process.env.QL3_TEST_POSTGRES_RUNTIME_URL &&
        process.env.QL3_TEST_POSTGRES_ADMIN_URL
          ? false
          : 'requires separate automation-manager, runtime and admin URLs',
    },
    async () => {
      const migrationDatabase = await open('migration');
      const automationDatabase = await open('automation-manager');
      const runtimeDatabase = await open('runtime');
      const adminDatabase = await open('admin');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        const observed = await migrationDatabase.pool.query(
          `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                  AS "observedAtMs"`,
        );
        const occurredAtMs = Number(observed.rows[0].observedAtMs);
        const projectId = 'automation-manager-integration';
        const actor = { type: 'user', id: 'usr_automation_integration' };
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."projects" (
             id, name, slug, status, version, created_at_ms, updated_at_ms
           ) VALUES ($1, 'Automation Integration', $1, 'active', 1, $2, $2)
           ON CONFLICT (id) DO NOTHING`,
          [projectId, occurredAtMs],
        );
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."project_role_bindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES ($1, 'user', $2, 1, 'active', 'owner', $3,
                     'user', $2, $4)
           ON CONFLICT (project_id, subject_type, subject_id, version)
           DO NOTHING`,
          [
            projectId,
            actor.id,
            '123e4567-e89b-42d3-a456-426614175100',
            occurredAtMs,
          ],
        );
        await migrationDatabase.pool.query(
          `UPDATE "ql3"."trigger_schedules"
           SET next_fire_at_ms = $1
           WHERE project_id <> $2`,
          [occurredAtMs + 86_400_000, projectId],
        );

        const readiness = await assertPostgresAutomationManagerSchemaReady(
          automationDatabase.pool,
        );
        assert.equal(readiness.currentUser, 'ql3_automation_manager');
        await assert.rejects(
          adminDatabase.pool.query(
            `SELECT 1 FROM "ql3"."task_definitions" LIMIT 1`,
          ),
          (error) => error?.code === '42501',
        );

        const fence = { projectVersion: 1, bindingVersion: 1 };
        const audit = (eventId, operationId, atMs) => ({
          eventId,
          requestId: `request-${eventId}`,
          operationId,
          projectId,
          subject: actor,
          authenticationId: 'oidc:automation-integration',
          outcome: 'allowed',
          reasons: ['role_grant'],
          fence,
          occurredAtMs: atMs,
        });
        const taskMutations =
          new PostgresTaskDefinitionAdministrationRepository(
            automationDatabase.pool,
          );
        const triggerMutations = new PostgresTriggerAdministrationRepository(
          automationDatabase.pool,
        );
        const taskBase = {
          projectId,
          taskId: 'automation-task',
          name: 'Automation Task',
          kind: 'command',
          labels: {},
          enabled: true,
        };
        const taskSpec = (value) => ({
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/bin/echo',
              args: [value],
            },
          },
        });
        const taskV1Command = {
          ...taskBase,
          expectedRevision: null,
          mutationId: '123e4567-e89b-42d3-a456-426614175101',
          spec: taskSpec('v1'),
          occurredAtMs: occurredAtMs + 1,
        };
        const taskV1 = (
          await taskMutations.appendAuthorizedTaskDefinitionRevision({
            command: taskV1Command,
            actor,
            fence,
            audit: audit(
              taskV1Command.mutationId,
              'task.create',
              occurredAtMs + 1,
            ),
          })
        ).definition;
        const triggerBase = {
          projectId,
          triggerId: 'automation-trigger',
          taskId: taskV1.taskId,
          spec: {
            schema: 'qinglong/cron@v1',
            config: {
              expression: '* * * * *',
              timezone: 'UTC',
              misfirePolicy: 'skip',
            },
          },
          enabled: true,
        };
        const triggerV1Command = {
          ...triggerBase,
          expectedRevision: null,
          mutationId: '123e4567-e89b-42d3-a456-426614175102',
          taskRevision: taskV1.revision,
          taskContentDigest: taskV1.contentDigest,
          occurredAtMs: occurredAtMs + 2,
        };
        await triggerMutations.appendAuthorizedTriggerRevision({
          command: triggerV1Command,
          actor,
          fence,
          audit: audit(
            triggerV1Command.mutationId,
            'trigger.create',
            occurredAtMs + 2,
          ),
        });

        const taskV2Command = {
          ...taskBase,
          expectedRevision: 1,
          mutationId: '123e4567-e89b-42d3-a456-426614175103',
          spec: taskSpec('v2'),
          occurredAtMs: occurredAtMs + 3,
        };
        const taskV2 = (
          await taskMutations.appendAuthorizedTaskDefinitionRevision({
            command: taskV2Command,
            actor,
            fence,
            audit: audit(
              taskV2Command.mutationId,
              'task.update',
              occurredAtMs + 3,
            ),
          })
        ).definition;
        const schedules = new PostgresClusterScheduleRepository(
          runtimeDatabase.pool,
        );
        assert.equal(
          await schedules.claimNextClusterSchedule({
            ownerId: 'automation-scheduler',
            claimToken: '123e4567-e89b-42d3-a456-426614175105',
            leaseMs: 30_000,
          }),
          null,
        );

        const triggerV2Command = {
          ...triggerBase,
          expectedRevision: 1,
          mutationId: '123e4567-e89b-42d3-a456-426614175104',
          taskRevision: taskV2.revision,
          taskContentDigest: taskV2.contentDigest,
          occurredAtMs: occurredAtMs + 4,
        };
        await triggerMutations.appendAuthorizedTriggerRevision({
          command: triggerV2Command,
          actor,
          fence,
          audit: audit(
            triggerV2Command.mutationId,
            'trigger.update',
            occurredAtMs + 4,
          ),
        });
        const initial = await schedules.claimNextClusterSchedule({
          ownerId: 'automation-scheduler',
          claimToken: '123e4567-e89b-42d3-a456-426614175106',
          leaseMs: 30_000,
        });
        assert.equal(initial.triggerId, triggerBase.triggerId);
        assert.equal(initial.taskRevision, taskV2.revision);
        await schedules.commitClusterScheduleDecision({
          claim: initial,
          decision: resolveClusterScheduleDecision(initial, 0, nextMinute),
        });
        await migrationDatabase.pool.query(
          `UPDATE "ql3"."trigger_schedules"
           SET next_fire_at_ms = $1, updated_at_ms = $1
           WHERE project_id = $2 AND trigger_id = $3`,
          [occurredAtMs, projectId, triggerBase.triggerId],
        );
        const due = await schedules.claimNextClusterSchedule({
          ownerId: 'automation-scheduler',
          claimToken: '123e4567-e89b-42d3-a456-426614175107',
          leaseMs: 30_000,
        });
        assert.equal(due.triggerId, triggerBase.triggerId);
        const decision = resolveClusterScheduleDecision(due, 5_000, nextMinute);
        assert.equal(decision.disposition, 'admit');
        const admitted = await schedules.commitClusterScheduleDecision({
          claim: due,
          decision,
          runId: '123e4567-e89b-42d3-a456-426614175108',
          attemptId: '123e4567-e89b-42d3-a456-426614175109',
          createdEventId: '123e4567-e89b-42d3-a456-426614175110',
          queuedEventId: '123e4567-e89b-42d3-a456-426614175111',
        });
        assert.equal(admitted.status, 'admitted');
        const run = await runtimeDatabase.pool.query(
          `SELECT task_revision AS "taskRevision", trigger_id AS "triggerId",
                  status
           FROM "ql3"."runs" WHERE id = $1`,
          [admitted.runId],
        );
        assert.deepEqual(run.rows, [
          {
            taskRevision: `qltd:v1:${taskV2.revision}:${taskV2.contentDigest}`,
            triggerId: triggerBase.triggerId,
            status: 'queued',
          },
        ]);
      } finally {
        await Promise.all([
          migrationDatabase.close(),
          automationDatabase.close(),
          runtimeDatabase.close(),
          adminDatabase.close(),
        ]);
      }
    },
  );

  test(
    'PostgreSQL admin role atomically administers identities and credentials without runtime authority',
    {
      skip: process.env.QL3_TEST_POSTGRES_ADMIN_URL
        ? false
        : 'requires a separate QL3_TEST_POSTGRES_ADMIN_URL',
    },
    async () => {
      const {
        PostgresApiCredentialAdministrationRepository,
        PostgresIdentityAdministrationRepository,
        PostgresSecurityAuditQueryRepository,
        PostgresWorkerCredentialAdministrationRepository,
        assertPostgresAdminSchemaReady,
      } = require('../dist/entrypoints/admin');
      const {
        IdentityAdministrationVersionConflictError,
      } = require('@qinglong/runtime-core/identity-administration');

      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await migrationDatabase.pool.query(
          'TRUNCATE TABLE "ql3"."worker_credential_mutations", "ql3"."worker_credentials", "ql3"."identity_subject_mutations", "ql3"."api_credential_mutations", "ql3"."security_audit_events", "ql3"."api_credentials", "ql3"."identity_subjects" CASCADE',
        );
      } finally {
        await migrationDatabase.close();
      }

      const actor = { type: 'user', id: 'usr_admin_integration' };
      const subject = { type: 'api_app', id: 'app_admin_integration' };
      const audit = (
        eventId,
        requestId,
        operationId,
        reason,
        occurredAtMs,
      ) => ({
        eventId,
        requestId,
        operationId,
        projectId: null,
        subject: actor,
        authenticationId: 'session:admin:integration',
        outcome: 'allowed',
        reasons: [reason],
        fence: null,
        occurredAtMs,
      });
      const identityCommand = (mutationId, operation, expected, time) => ({
        expectedCurrentVersion: expected,
        mutation: {
          mutationId,
          operation,
          subject,
          subjectVersion: expected + 1,
          expectedPreviousVersion: expected,
          status: operation === 'disable' ? 'disabled' : 'active',
          changedBy: actor,
          createdAtMs: time,
        },
        audit: audit(
          mutationId,
          `request-${mutationId}`,
          `identity.${operation}`,
          'identity_admin',
          time,
        ),
      });

      const adminDatabase = await open('admin');
      try {
        const readiness = await assertPostgresAdminSchemaReady(
          adminDatabase.pool,
        );
        assert.equal(readiness.currentUser, 'ql3_admin');

        const identities = new PostgresIdentityAdministrationRepository(
          adminDatabase.pool,
        );
        const register = identityCommand(
          '123e4567-e89b-42d3-a456-426614174401',
          'register',
          0,
          100,
        );
        assert.equal((await identities.append(register)).status, 'inserted');
        const replay = identityCommand(
          register.mutation.mutationId,
          'register',
          0,
          200,
        );
        replay.audit.requestId = register.audit.requestId;
        assert.equal((await identities.append(replay)).status, 'existing');
        assert.equal(
          (await identities.resolveMutation(register.mutation.mutationId))
            .identity.version,
          1,
        );

        const concurrent = [
          identityCommand(
            '123e4567-e89b-42d3-a456-426614174402',
            'disable',
            1,
            300,
          ),
          identityCommand(
            '123e4567-e89b-42d3-a456-426614174403',
            'disable',
            1,
            301,
          ),
        ];
        const concurrentResults = await Promise.allSettled(
          concurrent.map((command) => identities.append(command)),
        );
        assert.equal(
          concurrentResults.filter((result) => result.status === 'fulfilled')
            .length,
          1,
        );
        assert.equal(
          concurrentResults.some(
            (result) =>
              result.status === 'rejected' &&
              result.reason instanceof
                IdentityAdministrationVersionConflictError,
          ),
          true,
        );

        const currentIdentity = await identities.resolve(subject);
        const enable = identityCommand(
          '123e4567-e89b-42d3-a456-426614174404',
          'enable',
          currentIdentity.version,
          400,
        );
        await identities.append(enable);

        const credentials = new PostgresApiCredentialAdministrationRepository(
          adminDatabase.pool,
        );
        const credentialCommand = (
          mutationId,
          operation,
          expected,
          time,
          digest,
          notBeforeAtMs,
          expiresAtMs,
        ) => ({
          expectedCurrentVersion: expected,
          credential: {
            credentialId: 'credential_admin_integration',
            version: expected + 1,
            state: operation === 'revoke' ? 'revoked' : 'active',
            pepperKeyId: 'legacy-v1',
            subject,
            subjectStatus: 'active',
            secretDigest: digest,
            createdAtMs: time,
            notBeforeAtMs,
            expiresAtMs,
          },
          mutation: {
            mutationId,
            operation,
            credentialId: 'credential_admin_integration',
            credentialVersion: expected + 1,
            expectedPreviousVersion: expected,
            changedBy: actor,
            createdAtMs: time,
          },
          audit: audit(
            mutationId,
            `request-${mutationId}`,
            `credential.${operation}`,
            'credential_admin',
            time,
          ),
        });
        const issue = credentialCommand(
          '123e4567-e89b-42d3-a456-426614174411',
          'issue',
          0,
          500,
          'a'.repeat(64),
          500,
          5_000,
        );
        assert.equal((await credentials.append(issue)).status, 'inserted');
        const issueReplay = credentialCommand(
          issue.mutation.mutationId,
          'issue',
          0,
          500,
          'b'.repeat(64),
          500,
          5_000,
        );
        issueReplay.audit.requestId = issue.audit.requestId;
        assert.equal(
          (await credentials.append(issueReplay)).status,
          'existing',
        );
        assert.equal(
          (await credentials.resolveMutation(issue.mutation.mutationId))
            .credential.secretDigest,
          'a'.repeat(64),
        );

        const rotate = credentialCommand(
          '123e4567-e89b-42d3-a456-426614174412',
          'rotate',
          1,
          700,
          'c'.repeat(64),
          700,
          6_000,
        );
        await credentials.append(rotate);
        const revoke = credentialCommand(
          '123e4567-e89b-42d3-a456-426614174413',
          'revoke',
          2,
          800,
          '0'.repeat(64),
          800,
          801,
        );
        await credentials.append(revoke);

        const workerCredentials =
          new PostgresWorkerCredentialAdministrationRepository(
            adminDatabase.pool,
          );
        const workerIssue = {
          expectedCurrentVersion: 0,
          credential: {
            credentialId: 'worker_admin_integration',
            version: 1,
            state: 'active',
            workerId: 'worker-admin-a',
            secretDigest: 'e'.repeat(64),
            createdAtMs: 900,
            notBeforeAtMs: 900,
            expiresAtMs: 9_000,
          },
          mutation: {
            mutationId: '123e4567-e89b-42d3-a456-426614174421',
            operation: 'issue',
            credentialId: 'worker_admin_integration',
            credentialVersion: 1,
            expectedPreviousVersion: 0,
            changedBy: actor,
            createdAtMs: 900,
          },
          audit: audit(
            '123e4567-e89b-42d3-a456-426614174421',
            'request-worker-admin-integration',
            'worker_credential.issue',
            'worker_credential_admin',
            900,
          ),
        };
        assert.equal(
          (await workerCredentials.append(workerIssue)).status,
          'created',
        );
        assert.equal(
          (
            await workerCredentials.append({
              ...workerIssue,
              credential: {
                ...workerIssue.credential,
                secretDigest: 'f'.repeat(64),
              },
            })
          ).status,
          'existing',
        );
        assert.equal(
          (
            await workerCredentials.resolveMutation(
              workerIssue.mutation.mutationId,
            )
          ).credential.workerId,
          'worker-admin-a',
        );

        const query = new PostgresSecurityAuditQueryRepository(
          adminDatabase.pool,
        );
        const page = await query.list({
          limit: 20,
          filter: { subject: actor },
        });
        assert.equal(page.records.length, 7);
        assert.equal(page.records[0].operationId, 'worker_credential.issue');

        assert.equal(
          (
            await adminDatabase.pool.query(
              'SELECT status FROM "ql3"."projects" WHERE id = $1',
              ['default'],
            )
          ).rows[0].status,
          'active',
        );
        for (const table of ['runs', 'project_role_bindings']) {
          await assert.rejects(
            adminDatabase.pool.query(`SELECT * FROM "ql3"."${table}" LIMIT 1`),
            (error) => error?.code === '42501',
          );
        }
      } finally {
        await adminDatabase.close();
      }
    },
  );

  test('PostgreSQL converges Worker credential delivery across admin and ingress Pools', async () => {
    const {
      PostgresWorkerCredentialAdministrationRepository,
    } = require('../dist/entrypoints/admin');
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."worker_credential_deliveries", "ql3"."worker_credential_mutations", "ql3"."worker_credentials", "ql3"."security_audit_events", "ql3"."worker_sessions" CASCADE',
      );
    } finally {
      await migrationDatabase.close();
    }

    const adminDatabase = await open('admin');
    const ingressDatabase = await open('worker-ingress');
    try {
      const authority = new PostgresWorkerCredentialAdministrationRepository(
        adminDatabase.pool,
      );
      const sessions = new PostgresWorkerSessionRepository(
        ingressDatabase.pool,
      );
      const nowResult = await adminDatabase.pool.query(
        'SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"',
      );
      const baseAtMs = Number(nowResult.rows[0].nowMs) - 1_000;
      const workerId = 'worker-delivery-integration';
      const previousCredentialId = 'worker_delivery_previous';
      const credentialId = 'worker_delivery_current';
      const previousMutationId = '123e4567-e89b-42d3-a456-426614174501';
      const deliveryId = '123e4567-e89b-42d3-a456-426614174502';
      const revokeMutationId = '123e4567-e89b-42d3-a456-426614174503';
      const sessionId = '018f0000-0000-7000-8000-000000000003';
      const actor = { type: 'user', id: 'usr_delivery_integration' };
      const audit = (eventId, requestId, operation, subject, occurredAtMs) => ({
        eventId,
        requestId,
        operationId: `worker_credential.${operation}`,
        projectId: null,
        subject,
        authenticationId:
          subject.type === 'user'
            ? 'session:delivery-integration'
            : 'service:credential-recovery',
        outcome: 'allowed',
        reasons: ['worker_credential_admin'],
        fence: null,
        occurredAtMs,
      });
      const previous = {
        expectedCurrentVersion: 0,
        credential: {
          credentialId: previousCredentialId,
          version: 1,
          state: 'active',
          workerId,
          secretDigest: 'a'.repeat(64),
          createdAtMs: baseAtMs,
          notBeforeAtMs: baseAtMs,
          expiresAtMs: baseAtMs + 3_600_000,
        },
        mutation: {
          mutationId: previousMutationId,
          operation: 'issue',
          credentialId: previousCredentialId,
          credentialVersion: 1,
          expectedPreviousVersion: 0,
          changedBy: actor,
          createdAtMs: baseAtMs,
        },
        audit: audit(
          previousMutationId,
          'request-worker-delivery-previous',
          'issue',
          actor,
          baseAtMs,
        ),
      };
      assert.equal((await authority.append(previous)).status, 'created');

      const committedAtMs = baseAtMs + 100;
      const delivery = {
        deliveryId,
        version: 1,
        state: 'credential_committed',
        workerId,
        credentialId,
        credentialVersion: 1,
        previousCredentialId,
        secretDigest: 'b'.repeat(64),
        tokenDigest: 'c'.repeat(64),
        deploymentTargetDigest: 'd'.repeat(64),
        deploymentGeneration: 'secret-generation-integration',
        stagedAtMs: baseAtMs + 50,
        credentialCommittedAtMs: committedAtMs,
        publishedAtMs: null,
        publicationDigest: null,
        observedAtMs: null,
        observedSessionId: null,
        observedSessionVersion: null,
        previousRevokedAtMs: null,
      };
      const current = {
        expectedCurrentVersion: 0,
        credential: {
          credentialId,
          version: 1,
          state: 'active',
          workerId,
          secretDigest: delivery.secretDigest,
          createdAtMs: committedAtMs,
          notBeforeAtMs: committedAtMs,
          expiresAtMs: committedAtMs + 3_600_000,
        },
        mutation: {
          mutationId: deliveryId,
          operation: 'issue',
          credentialId,
          credentialVersion: 1,
          expectedPreviousVersion: 0,
          changedBy: actor,
          createdAtMs: committedAtMs,
        },
        audit: audit(
          deliveryId,
          'request-worker-delivery-current',
          'issue',
          actor,
          committedAtMs,
        ),
      };
      assert.equal(
        (await authority.commitDelivered({ credential: current, delivery }))
          .status,
        'created',
      );
      const published = await authority.markPublished({
        deliveryId,
        expectedVersion: 1,
        publicationDigest: 'e'.repeat(64),
        publishedAtMs: committedAtMs + 100,
      });
      assert.equal(published.state, 'published');

      const capabilitiesJson =
        '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
      const capabilitiesHash = createHash('sha256')
        .update(capabilitiesJson)
        .digest('hex');
      const registered = await sessions.register({
        workerId,
        sessionId,
        capabilitiesJson,
        capabilitiesHash,
        maxConcurrentRuns: 2,
        availableSlots: 2,
        leaseDurationMs: 60_000,
      });
      const observedSession = await sessions.heartbeatAuthenticated(
        {
          workerId,
          sessionId,
          generation: registered.worker.generation,
          expectedVersion: registered.worker.version,
          availableSlots: 2,
          leaseDurationMs: 60_000,
        },
        {
          workerId,
          credentialId,
          credentialVersion: 1,
        },
      );
      assert.equal(observedSession.version, 1);
      const recoveryPage = await authority.listRecoveryPage({ limit: 1 });
      assert.equal(recoveryPage.deliveries.length, 1);
      assert.equal(recoveryPage.deliveries[0].state, 'observed');
      assert.equal(recoveryPage.deliveries[0].observedSessionId, sessionId);

      let loseCommitResponse = true;
      const responseLossPool = {
        query: (...args) => adminDatabase.pool.query(...args),
        async connect() {
          const client = await adminDatabase.pool.connect();
          return {
            async query(text, values) {
              const result = await client.query(text, values);
              if (loseCommitResponse && String(text) === 'COMMIT') {
                loseCommitResponse = false;
                const error = new Error('simulated COMMIT response loss');
                error.code = '40001';
                throw error;
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      const revokeAtMs = recoveryPage.observedAtMs;
      const revokeActor = { type: 'system', id: 'credential-recovery' };
      const revokeCommand = {
        credential: {
          expectedCurrentVersion: 1,
          credential: {
            credentialId: previousCredentialId,
            version: 2,
            state: 'revoked',
            workerId,
            secretDigest: '0'.repeat(64),
            createdAtMs: revokeAtMs,
            notBeforeAtMs: revokeAtMs,
            expiresAtMs: revokeAtMs + 3_600_000,
          },
          mutation: {
            mutationId: revokeMutationId,
            operation: 'revoke',
            credentialId: previousCredentialId,
            credentialVersion: 2,
            expectedPreviousVersion: 1,
            changedBy: revokeActor,
            createdAtMs: revokeAtMs,
          },
          audit: audit(
            revokeMutationId,
            `worker-delivery-revoke:${deliveryId}`,
            'revoke',
            revokeActor,
            revokeAtMs,
          ),
        },
        delivery: {
          ...recoveryPage.deliveries[0],
          version: 4,
          state: 'previous_revoked',
          previousRevokedAtMs: revokeAtMs,
        },
      };
      const responseLossAuthority =
        new PostgresWorkerCredentialAdministrationRepository(responseLossPool);
      assert.equal(
        (await responseLossAuthority.revokePreviousDelivered(revokeCommand))
          .status,
        'existing',
      );
      assert.equal(loseCommitResponse, false);
      assert.equal(
        (await authority.revokePreviousDelivered(revokeCommand)).status,
        'existing',
      );
      assert.equal(
        (await authority.resolveDelivery(deliveryId)).state,
        'previous_revoked',
      );
      assert.deepEqual(
        (await authority.listRecoveryPage({ limit: 1 })).deliveries,
        [],
      );
      const persisted = await adminDatabase.pool.query(
        `SELECT
           (SELECT array_agg(version ORDER BY version)
              FROM "ql3"."worker_credential_deliveries"
             WHERE delivery_id = $1) AS delivery_versions,
           (SELECT array_agg(state ORDER BY version)
              FROM "ql3"."worker_credentials"
             WHERE credential_id = $2) AS previous_states`,
        [deliveryId, previousCredentialId],
      );
      assert.deepEqual(persisted.rows[0].delivery_versions, [1, 2, 3, 4]);
      assert.deepEqual(persisted.rows[0].previous_states, [
        'active',
        'revoked',
      ]);
    } finally {
      await Promise.allSettled([
        adminDatabase.close(),
        ingressDatabase.close(),
      ]);
    }
  });

  test('PostgreSQL gives delivery commit and orphan tombstone exactly one winner', async () => {
    const {
      PostgresWorkerCredentialAdministrationRepository,
    } = require('../dist/entrypoints/admin');
    const {
      WorkerCredentialDeliveryConflictError,
    } = require('@qinglong/runtime-core/worker-credential-delivery');
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."worker_credential_stage_discards", "ql3"."worker_credential_deliveries", "ql3"."worker_credential_mutations", "ql3"."worker_credentials", "ql3"."security_audit_events" CASCADE',
      );
    } finally {
      await migrationDatabase.close();
    }

    const firstDatabase = await open('admin');
    const secondDatabase = await open('admin');
    try {
      const first = new PostgresWorkerCredentialAdministrationRepository(
        firstDatabase.pool,
      );
      const second = new PostgresWorkerCredentialAdministrationRepository(
        secondDatabase.pool,
      );
      const nowResult = await firstDatabase.pool.query(
        'SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"',
      );
      const nowMs = Number(nowResult.rows[0].nowMs);
      const deliveryId = '123e4567-e89b-42d3-a456-426614174504';
      const intent = {
        deliveryId,
        workerId: 'worker-stage-discard-race',
        credentialId: 'worker_stage_discard_race',
        credentialVersion: 1,
        previousCredentialId: null,
        secretDigest: '1'.repeat(64),
        tokenDigest: '2'.repeat(64),
        deploymentTargetDigest: '3'.repeat(64),
        deploymentGeneration: 'stage-discard-race-generation',
        stagedAtMs: nowMs,
      };
      const delivery = {
        ...intent,
        version: 1,
        state: 'credential_committed',
        credentialCommittedAtMs: nowMs,
        publishedAtMs: null,
        publicationDigest: null,
        observedAtMs: null,
        observedSessionId: null,
        observedSessionVersion: null,
        previousRevokedAtMs: null,
      };
      const credential = {
        expectedCurrentVersion: 0,
        credential: {
          credentialId: intent.credentialId,
          version: 1,
          state: 'active',
          workerId: intent.workerId,
          secretDigest: intent.secretDigest,
          createdAtMs: nowMs,
          notBeforeAtMs: nowMs,
          expiresAtMs: nowMs + 3_600_000,
        },
        mutation: {
          mutationId: deliveryId,
          operation: 'issue',
          credentialId: intent.credentialId,
          credentialVersion: 1,
          expectedPreviousVersion: 0,
          changedBy: { type: 'user', id: 'usr_stage_discard_race' },
          createdAtMs: nowMs,
        },
        audit: {
          eventId: deliveryId,
          requestId: 'request-stage-discard-race',
          operationId: 'worker_credential.issue',
          projectId: null,
          subject: { type: 'user', id: 'usr_stage_discard_race' },
          authenticationId: 'session:stage-discard-race',
          outcome: 'allowed',
          reasons: ['worker_credential_admin'],
          fence: null,
          occurredAtMs: nowMs,
        },
      };
      const results = await Promise.allSettled([
        first.authorizeStageDiscard(intent),
        second.commitDelivered({ credential, delivery }),
      ]);
      assert.equal(
        results.filter(({ status }) => status === 'fulfilled').length,
        1,
      );
      assert.equal(
        results.filter(({ status }) => status === 'rejected').length,
        1,
      );
      assert.ok(
        results.find(({ status }) => status === 'rejected').reason instanceof
          WorkerCredentialDeliveryConflictError,
      );
      const counts = await firstDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer
              FROM "ql3"."worker_credential_stage_discards"
             WHERE delivery_id = $1 AND version = 1) AS discard_count,
           (SELECT count(*)::integer
              FROM "ql3"."worker_credential_deliveries"
             WHERE delivery_id = $1 AND version = 1) AS delivery_count`,
        [deliveryId],
      );
      assert.equal(
        counts.rows[0].discard_count + counts.rows[0].delivery_count,
        1,
      );
      if (counts.rows[0].discard_count === 1) {
        assert.equal(
          (
            await first.markStageDiscarded({
              deliveryId,
              expectedVersion: 1,
            })
          ).state,
          'discarded',
        );
        await assert.rejects(
          second.commitDelivered({ credential, delivery }),
          WorkerCredentialDeliveryConflictError,
        );
      } else {
        assert.equal(
          (await first.resolveDelivered(deliveryId)).delivery.version,
          1,
        );
        await assert.rejects(
          second.authorizeStageDiscard(intent),
          WorkerCredentialDeliveryConflictError,
        );
      }
    } finally {
      await Promise.allSettled([firstDatabase.close(), secondDatabase.close()]);
    }
  });

  test('PostgreSQL Worker Session and Run Lease use exact multi-replica fences', async () => {
    const migrationDatabase = await open('migration');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        'TRUNCATE TABLE "ql3"."run_events", "ql3"."run_dispatch_leases", "ql3"."run_attempts", "ql3"."runs", "ql3"."worker_sessions" CASCADE',
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."runs" (
           id, project_id, task_id, task_revision, trigger_type,
           execution_origin, execution_owner, status, created_at_ms, queued_at_ms
         ) VALUES
           ('run-worker-1', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'queued', 1, 1),
           ('run-worker-2', 'default', 'task', 'v1', 'manual', 'api', 'runtime', 'queued', 2, 2)`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."run_attempts" (
           id, run_id, attempt, status, executor_type, created_at_ms
         ) VALUES
           ('attempt-worker-1', 'run-worker-1', 1, 'claimed', 'remote-worker', 1),
           ('attempt-worker-2', 'run-worker-2', 1, 'claimed', 'remote-worker', 2)`,
      );
    } finally {
      await migrationDatabase.close();
    }

    const runtimeDatabase = await open('runtime');
    try {
      const workers = new PostgresWorkerSessionRepository(runtimeDatabase.pool);
      const leases = new PostgresRunDispatchLeaseRepository(
        runtimeDatabase.pool,
      );
      const capabilitiesJson =
        '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
      const capabilitiesHash = createHash('sha256')
        .update(capabilitiesJson)
        .digest('hex');
      const session1 = '018f0000-0000-7000-8000-000000000001';
      const session2 = '018f0000-0000-7000-8000-000000000002';
      const registered = await workers.register({
        workerId: 'worker-a',
        sessionId: session1,
        capabilitiesJson,
        capabilitiesHash,
        maxConcurrentRuns: 2,
        availableSlots: 1,
        leaseDurationMs: 60_000,
      });
      assert.equal(registered.worker.generation, 1);
      assert.equal(registered.worker.version, 0);
      assert.equal(registered.replacedSession, false);

      const leaseToken = 'lease_token_000000000000000000001';
      const claimed = await leases.claim({
        runId: 'run-worker-1',
        attemptId: 'attempt-worker-1',
        workerId: 'worker-a',
        workerSessionId: session1,
        workerGeneration: 1,
        leaseToken,
        leaseDurationMs: 60_000,
        eventId: 'event-worker-claim-1',
        offerId: 'offer-worker-1',
      });
      assert.equal(claimed.status, 'claimed');
      assert.equal(claimed.lease.leaseGeneration, 1);
      assert.equal(claimed.lease.version, 0);
      assert.equal(
        claimed.lease.leaseTokenDigest,
        createHash('sha256').update(leaseToken).digest('hex'),
      );
      assert.equal(JSON.stringify(claimed).includes(leaseToken), false);

      const replay = await leases.claim({
        runId: 'run-worker-1',
        attemptId: 'attempt-worker-1',
        workerId: 'worker-a',
        workerSessionId: session1,
        workerGeneration: 1,
        leaseToken,
        leaseDurationMs: 60_000,
        eventId: 'event-worker-claim-replay',
        offerId: 'offer-worker-1',
      });
      assert.equal(replay.status, 'idempotent');

      const capacity = await leases.claim({
        runId: 'run-worker-2',
        attemptId: 'attempt-worker-2',
        workerId: 'worker-a',
        workerSessionId: session1,
        workerGeneration: 1,
        leaseToken: 'lease_token_000000000000000000002',
        leaseDurationMs: 60_000,
        eventId: 'event-worker-claim-2',
        offerId: 'offer-worker-2',
      });
      assert.equal(capacity.status, 'capacity_exhausted');

      const renewed = await leases.renew({
        attemptId: 'attempt-worker-1',
        workerId: 'worker-a',
        workerSessionId: session1,
        workerGeneration: 1,
        leaseGeneration: 1,
        leaseToken,
        expectedVersion: 0,
        leaseDurationMs: 60_000,
      });
      assert.equal(renewed.version, 1);
      await assert.rejects(
        leases.renew({
          attemptId: 'attempt-worker-1',
          workerId: 'worker-a',
          workerSessionId: session1,
          workerGeneration: 1,
          leaseGeneration: 1,
          leaseToken,
          expectedVersion: 0,
          leaseDurationMs: 60_000,
        }),
        (error) =>
          error instanceof RunDispatchLeaseFenceRejectedError &&
          error.reason === 'version_mismatch',
      );
      const released = await leases.release({
        runId: 'run-worker-1',
        attemptId: 'attempt-worker-1',
        workerId: 'worker-a',
        workerSessionId: session1,
        workerGeneration: 1,
        leaseGeneration: 1,
        leaseToken,
        expectedVersion: 1,
        reason: 'declined',
        eventId: 'event-worker-release-1',
      });
      assert.equal(released.status, 'released');
      assert.equal(released.version, 2);

      const replacement = await workers.register({
        workerId: 'worker-a',
        sessionId: session2,
        capabilitiesJson,
        capabilitiesHash,
        maxConcurrentRuns: 1,
        availableSlots: 1,
        leaseDurationMs: 60_000,
      });
      assert.equal(replacement.replacedSession, true);
      assert.equal(replacement.worker.generation, 2);
      assert.equal(replacement.worker.version, 1);

      const persistedAttempt = await runtimeDatabase.pool.query(
        `SELECT worker_session_id, worker_generation, lease_generation,
                lease_version, lease_token, lease_token_digest, offer_id
         FROM "ql3"."run_attempts" WHERE id = 'attempt-worker-1'`,
      );
      assert.deepEqual(persistedAttempt.rows[0], {
        worker_session_id: null,
        worker_generation: null,
        lease_generation: null,
        lease_version: null,
        lease_token: null,
        lease_token_digest: null,
        offer_id: null,
      });
    } finally {
      await runtimeDatabase.close();
    }
  });

  test(
    'PostgreSQL Worker ingress role authenticates, sessions and attests without dispatch authority',
    {
      skip: process.env.QL3_TEST_POSTGRES_WORKER_INGRESS_URL
        ? false
        : 'requires a separate QL3_TEST_POSTGRES_WORKER_INGRESS_URL',
    },
    async () => {
      const sessionId = '018f0000-0000-7000-8000-000000000011';
      const leaseDigest = 'd'.repeat(64);
      const migrationDatabase = await open('migration');
      try {
        await runPostgresMigrations({ pool: migrationDatabase.pool });
        await migrationDatabase.pool.query(
          'TRUNCATE TABLE "ql3"."worker_execution_attestations", "ql3"."worker_credential_mutations", "ql3"."worker_credentials", "ql3"."run_events", "ql3"."run_dispatch_leases", "ql3"."run_attempts", "ql3"."runs", "ql3"."worker_sessions" CASCADE',
        );
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."worker_credentials" (
             credential_id, version, state, worker_id, secret_digest,
             created_at_ms, not_before_at_ms, expires_at_ms
           ) VALUES ('worker_ingress_integration', 1, 'active', 'worker-ingress-a',
                     $1, 1, 1, 9999999999999)`,
          ['a'.repeat(64)],
        );
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."runs" (
             id, project_id, task_id, task_revision, trigger_type,
             execution_origin, execution_owner, status, created_at_ms, queued_at_ms
           ) VALUES (
             'run-worker-ingress', 'default', 'task', 'v1', 'manual',
             'api', 'runtime', 'dispatching', 1, 1
           )`,
        );
        await migrationDatabase.pool.query(
          `INSERT INTO "ql3"."run_attempts" (
             id, run_id, attempt, status, executor_type, worker_id,
             executor_handle, callback_sequence, created_at_ms,
             worker_session_id, worker_generation, lease_generation,
             lease_version, lease_token_digest, offer_id
           ) VALUES (
             'attempt-worker-ingress', 'run-worker-ingress', 1, 'starting',
             'remote-worker', 'worker-ingress-a', 'remote:handle-1', 5, 1,
             $1, 1, 1, 0, $2, 'offer-worker-ingress'
           )`,
          [sessionId, leaseDigest],
        );
      } finally {
        await migrationDatabase.close();
      }

      const ingressDatabase = await open('worker-ingress');
      try {
        const readiness = await assertPostgresWorkerIngressSchemaReady(
          ingressDatabase.pool,
        );
        assert.equal(readiness.currentUser, 'ql3_worker_ingress');
        const credentials = new PostgresWorkerCredentialRepository(
          ingressDatabase.pool,
        );
        assert.equal(
          (await credentials.resolve('worker_ingress_integration')).workerId,
          'worker-ingress-a',
        );
        const capabilitiesJson =
          '{"architecture":"arm64","executors":["remote-worker"],"protocolVersion":"1.0.0","supportTier":"tier1"}';
        const workers = new PostgresWorkerSessionRepository(
          ingressDatabase.pool,
        );
        const registered = await workers.register({
          workerId: 'worker-ingress-a',
          sessionId,
          capabilitiesJson,
          capabilitiesHash: createHash('sha256')
            .update(capabilitiesJson)
            .digest('hex'),
          maxConcurrentRuns: 1,
          availableSlots: 1,
          leaseDurationMs: 60_000,
        });
        assert.equal(registered.worker.generation, 1);

        const setup = await open('migration');
        try {
          await setup.pool.query(
            `INSERT INTO "ql3"."run_dispatch_leases" (
               attempt_id, run_id, status, version, lease_generation,
               worker_id, worker_session_id, worker_generation,
               lease_token_digest, offer_id, acquired_at_ms, renewed_at_ms,
               expires_at_ms, updated_at_ms
             ) VALUES (
               'attempt-worker-ingress', 'run-worker-ingress', 'leased', 0, 1,
               'worker-ingress-a', $1, 1, $2, 'offer-worker-ingress',
               1, 1, 9999999999999, 1
             )`,
            [sessionId, leaseDigest],
          );
        } finally {
          await setup.close();
        }

        const attestations = new PostgresWorkerExecutionAttestationRepository(
          ingressDatabase.pool,
        );
        const command = {
          attestationId: '018f0000-0000-7000-8000-000000000012',
          runId: 'run-worker-ingress',
          attemptId: 'attempt-worker-ingress',
          sequence: 1,
          state: 'running',
          workerId: 'worker-ingress-a',
          workerSessionId: sessionId,
          workerGeneration: 1,
          leaseTokenDigest: leaseDigest,
          leaseGeneration: 1,
          leaseVersion: 0,
          offerId: 'offer-worker-ingress',
          callbackSequence: 5,
          executorHandle: 'remote:handle-1',
          journalRevision: 1,
        };
        const created = await attestations.submit(command);
        assert.equal(created.status, 'created');
        assert.equal((await attestations.submit(command)).status, 'existing');
        assert.equal(
          (await attestations.findLatestExact(command)).attestationId,
          command.attestationId,
        );
        await assert.rejects(
          attestations.submit({
            ...command,
            attestationId: '018f0000-0000-7000-8000-000000000013',
            sequence: 3,
            journalRevision: 2,
          }),
          (error) =>
            error instanceof WorkerExecutionAttestationFenceRejectedError &&
            error.reason === 'sequence_mismatch',
        );
        const stopped = await attestations.submit({
          ...command,
          attestationId: '018f0000-0000-7000-8000-000000000014',
          sequence: 2,
          state: 'stopped',
          journalRevision: 2,
        });
        assert.equal(stopped.status, 'created');
        const provider = new PostgresRemoteWorkerAttestationEvidenceProvider(
          ingressDatabase.pool,
          attestations,
        );
        assert.deepEqual(
          await provider.inspect(
            { ...command, executorType: 'remote-worker' },
            { signal: new AbortController().signal },
          ),
          { status: 'not_running' },
        );

        for (const statement of [
          'SELECT id FROM "ql3"."runs" LIMIT 1',
          'UPDATE "ql3"."run_attempts" SET status = status',
          'SELECT event_id FROM "ql3"."security_audit_events" LIMIT 1',
        ]) {
          await assert.rejects(
            ingressDatabase.pool.query(statement),
            (error) => error?.code === '42501',
          );
        }
      } finally {
        await ingressDatabase.close();
      }
    },
  );

  test('persists and exactly replays one semantic Package revision in PostgreSQL', async () => {
    const fixture = materializedRevisionFixture(
      `postgres-live-${process.pid}`,
      'cluster-control',
    );
    const database = await open('migration');
    try {
      await runPostgresMigrations({ pool: database.pool });
      await database.pool.query(
        `INSERT INTO "ql3"."projects"
           (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [fixture.projectId],
      );
      const repository =
        new PostgresPluginPackageMaterializedRevisionRepository(
          database.pool,
          fixture.registry,
        );
      assert.equal(
        (await repository.publish(fixture.revision)).status,
        'created',
      );
      assert.equal(
        (await repository.publish(fixture.revision)).status,
        'existing',
      );
      assert.deepEqual(
        await repository.find(fixture.revision.generation.generationDigest),
        fixture.revision,
      );
    } finally {
      await database.close();
    }
  });

  test('persists one content-free Legacy Env migration plan with isolated authority', async () => {
    const projectId = `legacy-env-project-${process.pid}`;
    const planId = `legacy-env-plan-${process.pid}`;
    const mutationId = `legacy-env-mutation-${process.pid}`;
    const migrationDatabase = await open('migration');
    const automationDatabase = await open('automation-manager');
    const runtimeDatabase = await open('runtime');
    const adminDatabase = await open('admin');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects"
           (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES ($1, $1, $1, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [projectId],
      );
      const intent = {
        planId,
        mutationId,
        projectId,
        source: {
          reconciliationBundleDigest: '1'.repeat(64),
          decisionDigest: '2'.repeat(64),
          candidateSetDigest: '3'.repeat(64),
          sourceRowCount: 3,
          activeRowCount: 2,
          disabledRowCount: 1,
          effectiveBindingCount: 2,
        },
        target: {
          secretRef: createSecretRef({
            projectId,
            name: 'legacy-env-bundle',
            version: 1,
          }),
          taskRevisionSetDigest: '4'.repeat(64),
          triggerRevisionSetDigest: '5'.repeat(64),
          taskCount: 2,
          triggerCount: 1,
          totalEffectiveBytes: 1024,
        },
      };
      const repository = new PostgresClusterLegacyEnvMigrationPlanRepository(
        automationDatabase.pool,
      );
      const created = await repository.publish(intent);
      const replay = await repository.publish(intent);
      assert.equal(created.status, 'created');
      assert.equal(replay.status, 'existing');
      assert.deepEqual(replay.plan, created.plan);
      assert.deepEqual(await repository.findByPlanId(planId), created.plan);

      const stored = await automationDatabase.pool.query(
        `SELECT plan_json AS "planJson"
           FROM "ql3"."cluster_legacy_env_migration_plans"
          WHERE plan_id = $1`,
        [planId],
      );
      assert.equal(stored.rowCount, 1);
      assert.deepEqual(stored.rows[0].planJson, created.plan);
      assert.doesNotMatch(
        JSON.stringify(stored.rows[0].planJson),
        /TOKEN|secretValue|ciphertext|keyId/i,
      );

      const invalidPlanId = `${planId}-widened`;
      const invalidMutationId = `${mutationId}-widened`;
      const invalidDigest = 'f'.repeat(64);
      await assert.rejects(
        migrationDatabase.pool.query(
          `INSERT INTO "ql3"."cluster_legacy_env_migration_plans" (
             plan_id, mutation_id, project_id, plan_digest,
             reconciliation_bundle_digest, decision_digest,
             candidate_set_digest, source_row_count, active_row_count,
             disabled_row_count, effective_binding_count, secret_ref,
             task_revision_set_digest, trigger_revision_set_digest,
             task_count, trigger_count, total_effective_bytes,
             planned_at_ms, plan_json
           )
           SELECT $2::varchar, $3::varchar, project_id, $4::varchar,
                  reconciliation_bundle_digest, decision_digest,
                  candidate_set_digest, source_row_count, active_row_count,
                  disabled_row_count, effective_binding_count, secret_ref,
                  task_revision_set_digest, trigger_revision_set_digest,
                  task_count, trigger_count, total_effective_bytes,
                  planned_at_ms,
                  plan_json || jsonb_build_object(
                    'planId', $2::varchar,
                    'mutationId', $3::varchar,
                    'planDigest', $4::varchar,
                    'envName', 'TOKEN'
                  )
             FROM "ql3"."cluster_legacy_env_migration_plans"
            WHERE plan_id = $1`,
          [planId, invalidPlanId, invalidMutationId, invalidDigest],
        ),
        (error) =>
          error?.code === '23514' &&
          error?.constraint === 'ql3_cluster_legacy_env_plan_json_check',
      );

      await assert.rejects(
        automationDatabase.pool.query(
          `UPDATE "ql3"."cluster_legacy_env_migration_plans"
              SET planned_at_ms = planned_at_ms
            WHERE plan_id = $1`,
          [planId],
        ),
        (error) => error?.code === '42501',
      );
      for (const database of [runtimeDatabase, adminDatabase]) {
        await assert.rejects(
          database.pool.query(
            `SELECT plan_id
               FROM "ql3"."cluster_legacy_env_migration_plans"
              WHERE plan_id = $1`,
            [planId],
          ),
          (error) => error?.code === '42501',
        );
      }
    } finally {
      await Promise.all([
        adminDatabase.close(),
        runtimeDatabase.close(),
        automationDatabase.close(),
        migrationDatabase.close(),
      ]);
    }
  });

  test('atomically applies one Legacy Env plan to Task, Trigger and schedule receipts', async () => {
    const projectId = `legacy-env-application-${process.pid}`;
    const taskId = `legacy task ${process.pid}`;
    const triggerId = `legacy trigger ${process.pid}`;
    const planId = `legacy-env-application-plan-${process.pid}`;
    const planMutationId = `legacy-env-application-plan-mutation-${process.pid}`;
    const applicationId = `legacy-env-application-receipt-${process.pid}`;
    const taskMutationId = '719f7900-0000-4000-8000-000000000001';
    const triggerMutationId = '719f7900-0000-4000-8000-000000000002';
    const applicationMutationId = '719f7900-0000-4000-8000-000000000003';
    const migrationDatabase = await open('migration');
    const automationDatabase = await open('automation-manager');
    const runtimeDatabase = await open('runtime');
    const adminDatabase = await open('admin');
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migrationDatabase.pool.query(
        `TRUNCATE TABLE
           "ql3"."cluster_legacy_env_migration_application_triggers",
           "ql3"."cluster_legacy_env_migration_application_tasks",
           "ql3"."cluster_legacy_env_migration_application_receipts",
           "ql3"."cluster_legacy_env_migration_plans",
           "ql3"."trigger_schedules", "ql3"."triggers",
           "ql3"."task_execution_revisions", "ql3"."task_definitions"
         CASCADE`,
      );
      await migrationDatabase.pool.query(
        `INSERT INTO "ql3"."projects"
           (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES ($1, $1, $2, 'active', 1, 1, 1)
         ON CONFLICT (id) DO NOTHING`,
        [projectId, `legacy-env-application-${process.pid}`],
      );
      const clock = await migrationDatabase.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS "observedAtMs"`,
      );
      const occurredAtMs = Number(clock.rows[0].observedAtMs) - 1000;
      const initialTask = (
        await new PostgresTaskDefinitionRepository(
          migrationDatabase.pool,
        ).appendTaskDefinitionRevision({
          projectId,
          taskId,
          expectedRevision: null,
          mutationId: '719f7900-0000-4000-8000-000000000010',
          name: 'Legacy command',
          description: 'preserved by atomic migration',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: {
                kind: 'argv',
                file: '/bin/echo',
                args: ['legacy'],
              },
              timeoutMs: 30_000,
            },
          },
          labels: { 'qinglong.io/source': 'legacy' },
          enabled: true,
          occurredAtMs,
        })
      ).definition;
      const trigger = (
        await new PostgresTriggerRepository(
          migrationDatabase.pool,
        ).appendTriggerRevision({
          projectId,
          triggerId,
          expectedRevision: null,
          mutationId: '719f7900-0000-4000-8000-000000000011',
          taskId,
          taskRevision: initialTask.revision,
          taskContentDigest: initialTask.contentDigest,
          spec: {
            schema: 'qinglong/cron@v1',
            config: {
              expression: '* * * * *',
              timezone: 'UTC',
              misfirePolicy: 'skip',
            },
          },
          enabled: true,
          occurredAtMs: occurredAtMs + 1,
        })
      ).trigger;
      const task = (
        await new PostgresTaskDefinitionRepository(
          migrationDatabase.pool,
        ).appendTaskDefinitionRevision({
          projectId,
          taskId,
          expectedRevision: initialTask.revision,
          mutationId: '719f7900-0000-4000-8000-000000000012',
          name: initialTask.name,
          description: initialTask.description,
          kind: initialTask.kind,
          spec: initialTask.spec,
          labels: initialTask.labels,
          enabled: initialTask.enabled,
          occurredAtMs: occurredAtMs + 2,
        })
      ).definition;

      const taskMutations = [
        {
          ordinal: 0,
          taskId,
          previousRevision: task.revision,
          previousContentDigest: task.contentDigest,
          mutationId: taskMutationId,
        },
      ];
      const triggerMutations = [
        {
          ordinal: 0,
          triggerId,
          taskId,
          previousRevision: trigger.revision,
          previousContentDigest: trigger.contentDigest,
          previousTaskRevision: initialTask.revision,
          previousTaskContentDigest: initialTask.contentDigest,
          mutationId: triggerMutationId,
        },
      ];
      const taskDigester =
        createClusterLegacyEnvMigrationTaskMutationSetDigester();
      taskMutations.forEach((value) => taskDigester.update(value));
      const taskSet = taskDigester.finish();
      const triggerDigester =
        createClusterLegacyEnvMigrationTriggerMutationSetDigester();
      triggerMutations.forEach((value) => triggerDigester.update(value));
      const triggerSet = triggerDigester.finish();
      const secretRef = createSecretRef({
        projectId,
        name: 'legacy-env-bundle',
        version: 1,
      });
      const plan = (
        await new PostgresClusterLegacyEnvMigrationPlanRepository(
          automationDatabase.pool,
        ).publish({
          planId,
          mutationId: planMutationId,
          projectId,
          source: {
            reconciliationBundleDigest: '1'.repeat(64),
            decisionDigest: '2'.repeat(64),
            candidateSetDigest: '3'.repeat(64),
            sourceRowCount: 1,
            activeRowCount: 1,
            disabledRowCount: 0,
            effectiveBindingCount: 1,
          },
          target: {
            secretRef,
            taskRevisionSetDigest: taskSet.revisionSetDigest,
            triggerRevisionSetDigest: triggerSet.revisionSetDigest,
            taskCount: taskSet.count,
            triggerCount: triggerSet.count,
            totalEffectiveBytes: 128,
          },
        })
      ).plan;
      const intent = {
        applicationId,
        mutationId: applicationMutationId,
        projectId,
        planId,
        planDigest: plan.planDigest,
        taskMutationSetDigest: taskSet.mutationSetDigest,
        triggerMutationSetDigest: triggerSet.mutationSetDigest,
      };
      let taskStreamCalls = 0;
      let triggerStreamCalls = 0;
      const streams = {
        taskMutations() {
          taskStreamCalls += 1;
          return taskMutations;
        },
        triggerMutations() {
          triggerStreamCalls += 1;
          return triggerMutations;
        },
      };
      const applications =
        new PostgresClusterLegacyEnvMigrationApplicationRepository(
          automationDatabase.pool,
        );
      const applied = await applications.apply(intent, streams);
      assert.equal(applied.status, 'applied');
      assert.equal(taskStreamCalls, 1);
      assert.equal(triggerStreamCalls, 1);
      assert.deepEqual(
        await applications.findByApplicationId(applicationId),
        applied.receipt,
      );

      const state = await automationDatabase.pool.query(
        `SELECT task.current_revision AS "taskRevision",
                task_revision.spec_json AS "taskSpec",
                task_revision.name AS "taskName",
                task_revision.description AS "taskDescription",
                task_revision.labels_json AS "taskLabels",
                execution.plan_json AS "executionPlan",
                trigger.current_revision AS "triggerRevision",
                trigger_revision.task_revision AS "triggerTaskRevision",
                trigger_revision.task_content_digest AS "triggerTaskContentDigest",
                schedule.trigger_revision AS "scheduleRevision",
                schedule.next_fire_at_ms AS "nextFireAtMs",
                schedule.last_scheduled_at_ms AS "lastScheduledAtMs",
                schedule.state_version AS "scheduleStateVersion",
                schedule.claim_version AS "scheduleClaimVersion"
           FROM "ql3"."task_definitions" AS task
           JOIN "ql3"."task_definition_revisions" AS task_revision
             ON task_revision.project_id = task.project_id
            AND task_revision.task_id = task.task_id
            AND task_revision.revision = task.current_revision
           JOIN "ql3"."task_execution_revisions" AS execution
             ON execution.project_id = task.project_id
            AND execution.task_id = task.task_id
            AND execution.source_revision = task.current_revision
           JOIN "ql3"."triggers" AS trigger
             ON trigger.project_id = task.project_id
            AND trigger.task_id = task.task_id
           JOIN "ql3"."trigger_revisions" AS trigger_revision
             ON trigger_revision.project_id = trigger.project_id
            AND trigger_revision.trigger_id = trigger.trigger_id
            AND trigger_revision.revision = trigger.current_revision
           JOIN "ql3"."trigger_schedules" AS schedule
             ON schedule.project_id = trigger.project_id
            AND schedule.trigger_id = trigger.trigger_id
          WHERE task.project_id = $1 AND task.task_id = $2
            AND trigger.trigger_id = $3`,
        [projectId, taskId, triggerId],
      );
      assert.equal(state.rowCount, 1);
      const row = state.rows[0];
      assert.equal(row.taskRevision, 3);
      assert.equal(row.taskSpec.config.environmentBundleRef, secretRef);
      assert.equal(row.taskSpec.config.timeoutMs, 30_000);
      assert.equal(row.taskName, task.name);
      assert.equal(row.taskDescription, task.description);
      assert.deepEqual(row.taskLabels, { ...task.labels });
      assert.equal(row.executionPlan.environmentBundleRef, secretRef);
      assert.equal(row.triggerRevision, 2);
      assert.equal(row.triggerTaskRevision, 3);
      assert.match(row.triggerTaskContentDigest, /^[0-9a-f]{64}$/);
      assert.equal(row.scheduleRevision, 2);
      assert.equal(row.nextFireAtMs, null);
      assert.equal(row.lastScheduledAtMs, null);
      assert.equal(row.scheduleStateVersion, 1);
      assert.equal(row.scheduleClaimVersion, 1);

      const replay = await applications.apply(intent, streams);
      assert.equal(replay.status, 'existing');
      assert.deepEqual(replay.receipt, applied.receipt);
      assert.equal(taskStreamCalls, 1);
      assert.equal(triggerStreamCalls, 1);

      const ledger = await automationDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer
              FROM "ql3"."cluster_legacy_env_migration_application_receipts"
             WHERE application_id = $1) AS receipts,
           (SELECT count(*)::integer
              FROM "ql3"."cluster_legacy_env_migration_application_tasks"
             WHERE application_id = $1) AS tasks,
           (SELECT count(*)::integer
              FROM "ql3"."cluster_legacy_env_migration_application_triggers"
             WHERE application_id = $1) AS triggers`,
        [applicationId],
      );
      assert.deepEqual(ledger.rows, [{ receipts: 1, tasks: 1, triggers: 1 }]);
      await assert.rejects(
        automationDatabase.pool.query(
          `UPDATE "ql3"."cluster_legacy_env_migration_application_receipts"
              SET committed_at_ms = committed_at_ms
            WHERE application_id = $1`,
          [applicationId],
        ),
        (error) => error?.code === '42501',
      );
      for (const database of [runtimeDatabase, adminDatabase]) {
        await assert.rejects(
          database.pool.query(
            `SELECT application_id
               FROM "ql3"."cluster_legacy_env_migration_application_receipts"
              WHERE application_id = $1`,
            [applicationId],
          ),
          (error) => error?.code === '42501',
        );
      }
    } finally {
      await Promise.all([
        adminDatabase.close(),
        runtimeDatabase.close(),
        automationDatabase.close(),
        migrationDatabase.close(),
      ]);
    }
  });
}
