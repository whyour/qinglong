#!/usr/bin/env node

const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const {
  assertPostgresSchemaReady,
  createPostgresDatabaseOpener,
  PostgresClusterRunCancellationConvergenceRepository,
  PostgresClusterRunCancellationRepository,
  PostgresClusterScheduleRepository,
  PostgresRemoteWorkerCompletionRepository,
  PostgresRemoteWorkerLeaseControlRepository,
  PostgresRunAttemptLogRetentionClaimRepository,
  PostgresToolInvocationArtifactRepository,
  PostgresWorkerSessionRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runtime.js');
const {
  runPostgresMigrations,
} = require('../packages/ql3-cluster-postgres/dist/migration/migration.js');
const {
  POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
  POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
  POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
  POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
  POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
  migratePostgresModelInvocationFeature,
} = require('../packages/ql3-ai/dist/migration/modelInvocationMigration.js');
const {
  MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
  ModelProviderCredentialCatalogUnavailableError,
  ModelProviderCredentialTransitionConflictError,
  createModelProviderCredentialTransitionCommand,
} = require('../packages/ql3-ai/dist/model-provider-credential/modelProviderCredentialCatalog.js');
const {
  modelProviderCredentialAdministrationOperationId,
} = require('../packages/ql3-ai/dist/model-provider-credential/modelProviderCredentialAdministration.js');
const {
  PostgresModelProviderCredentialReader,
  PostgresModelProviderCredentialRepository,
} = require('../packages/ql3-ai/dist/model-provider-credential/postgresModelProviderCredentialRepository.js');
const {
  PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
  PostgresModelProviderCredentialManagementIdentityLedgerRepository,
  PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError,
  assertPostgresModelProviderCredentialManagerReady,
} = require('../packages/ql3-ai/dist/model-provider-credential/postgresModelProviderCredentialManagementIdentityLedger.js');
const {
  MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
  ModelProviderCredentialManagementAuditUnavailableError,
  PostgresModelProviderCredentialManagementAuditQueryRepository,
} = require('../packages/ql3-ai/dist/model-provider-credential/postgresModelProviderCredentialManagementAuditQuery.js');
const {
  MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
  MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
  digestModelProviderCredentialBinding,
} = require('../packages/ql3-ai/dist/model-provider-credential/providerCredential.js');
const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestPlan,
} = require('../packages/ql3-ai/dist/model-provider-credential/modelProviderCredentialTestConnection.js');
const {
  MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
  PostgresModelProviderCredentialTestExecutionRepository,
  PostgresModelProviderCredentialTestPlanRepository,
  assertPostgresModelProviderCredentialTesterReady,
} = require('../packages/ql3-ai/dist/model-provider-credential/postgresModelProviderCredentialTestConnection.js');
const {
  BoundedModelGateway,
} = require('../packages/ql3-ai/dist/model-gateway/gateway.js');
const {
  DurableModelInvocationCoordinator,
} = require('../packages/ql3-ai/dist/model-invocation/durableModelInvocationCoordinator.js');
const {
  PostgresModelInvocationRepository,
} = require('../packages/ql3-ai/dist/model-invocation/postgresModelInvocationRepository.js');
const {
  PostgresPluginPackagePromptAdmissionRepository,
} = require('../packages/ql3-ai/dist/prompt/postgresPluginPackagePromptAdmissionRepository.js');
const {
  PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
  normalizePluginPackagePromptExecutionInspectionResult,
} = require('../packages/ql3-ai/dist/prompt/pluginPackagePromptExecutionInspection.js');
const {
  PostgresPluginPackagePromptExecutionInspectionRepository,
} = require('../packages/ql3-ai/dist/prompt/postgresPluginPackagePromptExecutionInspectionRepository.js');
const {
  PluginPackagePromptExecutor,
} = require('../packages/ql3-ai/dist/prompt/pluginPackagePromptExecutor.js');
const {
  PluginPackagePromptOutputCompletionCoordinator,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputCompletion.js');
const {
  PostgresPluginPackagePromptOutputRetentionRepository,
  PostgresPluginPackagePromptOutputGarbageCollector,
  assertPostgresPluginPackagePromptOutputMaintenanceReady,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputRetentionRepository.js');
const {
  createPluginPackagePromptOutputRetentionPolicyCatalogResolver,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputRetention.js');
const {
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
  openPluginPackagePromptOutputArtifact,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  PostgresPluginPackagePromptOutputArtifactRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository.js');
const {
  PluginPackagePromptOutputReadService,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptOutputRead.js');
const {
  PluginPackagePromptExecutionOutputReadService,
} = require('../packages/ql3-ai/dist/prompt-output/pluginPackagePromptExecutionOutputRead.js');
const {
  PostgresPluginPackagePromptExecutionOutputReferenceRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptExecutionOutputReferenceRepository.js');
const {
  PluginPackagePromptOutputKeyRetirementCoordinator,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRetirement.js');
const {
  PostgresPluginPackagePromptOutputKeyRetirementRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputKeyRetirementRepository.js');
const {
  PluginPackagePromptOutputKeyRotationCoordinator,
  PluginPackagePromptOutputKeyRotationUnavailableError,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');
const {
  PostgresPluginPackagePromptOutputKeyRotationRepository,
} = require('../packages/ql3-ai/dist/prompt-output/storage/postgresPluginPackagePromptOutputKeyRotationRepository.js');
const {
  inspectPluginPackagePromptOutputKeyringManifest,
  pluginPackagePromptOutputKeyringCatalogDigest,
  retirePluginPackagePromptOutputKeyringManifest,
  rotatePluginPackagePromptOutputKeyringManifest,
} = require('../packages/ql3-ai/dist/prompt-output/key-management/pluginPackagePromptOutputKeyringManifest.js');
const {
  PostgresPluginPackagePromptCatalogService,
  PostgresPluginPackagePromptExecutionService,
} = require('../packages/ql3-ai/dist/prompt/postgresPluginPackagePromptApplication.js');
const {
  PostgresTaskDefinitionRepository,
  PostgresTriggerRepository,
  PostgresWorkerCredentialAdministrationRepository,
  assertPostgresAdminSchemaReady,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/admin.js');
const {
  PostgresTaskStartRepository,
} = require('../packages/ql3-cluster-postgres/dist/task-start/taskStartRepository.js');
const {
  CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
  PostgresRunManualRetryRepository,
} = require('../packages/ql3-cluster-postgres/dist/run-management/runManualRetryRepository.js');
const {
  RunManualRetryRateLimitedError,
} = require('../packages/ql3-runtime-core/dist/run/manual-retry/runManualRetry.js');
const {
  assertPostgresPackageManagerSchemaReady,
  PostgresPluginPackageIdentityKeysetLedgerConflictError,
  PostgresPluginPackageIdentityKeysetLedgerRepository,
  PostgresPluginPackageIdentityKeysetLedgerUnavailableError,
  PostgresPluginPackageManagementQuotaRepository,
  PostgresPluginPackagePublisherTrustAuthorityRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/packageManager.js');
const {
  assertPostgresWorkerCredentialManagerSchemaReady,
  PostgresWorkerCredentialManagementQuotaRepository,
} = require('../packages/ql3-cluster-postgres/dist/worker-credential/workerCredentialManager.js');
const {
  assertPostgresWorkerCredentialExecutorSchemaReady,
} = require('../packages/ql3-cluster-postgres/dist/worker-credential/workerCredentialExecutor.js');
const {
  assertPostgresAutomationManagerSchemaReady,
  PostgresTaskDefinitionAdministrationRepository,
  PostgresTriggerAdministrationRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/automationManager.js');
const {
  assertPostgresApprovalManagerSchemaReady,
} = require('../packages/ql3-cluster-postgres/dist/approval-management/index.js');
const {
  assertPostgresRunManagerSchemaReady,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/runManager.js');
const {
  assertPostgresPackageExecutorSchemaReady,
  PostgresPluginPackageMaterializedRevisionRepository,
  PostgresPluginPackageAutomationPublicationRepository,
  PostgresPluginPackageLifecyclePlanRepository,
  PostgresPluginPackagePublisherProvenanceRepository,
  PostgresPluginPackageQuarantineRepository,
  PostgresPluginPackageTaskReconciliationRepository,
  PostgresProjectToolDefinitionSnapshotRepository,
} = require('../packages/ql3-cluster-postgres/dist/entrypoints/packageExecutor.js');
const {
  PostgresPluginPackageInstallRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/installation/pluginPackageInstallRepository.js');
const {
  createRecoverableWorkerCredentialIssuer,
  createWorkerCredentialDeliveryRecoveryService,
} = require('../packages/ql3-cluster-admin/dist/worker-credential/workerCredentialDelivery.js');
const {
  createModelProviderCredentialTestExecutor,
} = require('../packages/ql3-cluster-admin/dist/model-provider-credential/modelProviderCredentialTestExecutor.js');
const {
  resolveClusterScheduleDecision,
} = require('../packages/ql3-runtime-core/dist/scheduler/clusterScheduler.js');
const {
  createRunAttemptLogRetirementRecord,
} = require('../packages/ql3-runtime-core/dist/run/log-retention/runAttemptLogRetention.js');
const {
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementUnavailableError,
} = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageManagement.js');
const {
  createInitialPluginPackageAutomationPublication,
} = require('../packages/ql3-runtime-core/dist/plugin-package/pluginPackageAutomationPublication.js');
const {
  createPluginPackageWorkflowExecutionPlan,
  PluginPackageWorkflowAdmissionNotAllowedError,
} = require('../packages/ql3-runtime-core/dist/plugin-package/workflow/pluginPackageWorkflowExecutionPlan.js');
const {
  PostgresPluginPackageWorkflowAdmissionRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository.js');
const {
  PostgresAuthorizedPluginPackageWorkflowAdmissionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunEventListRepository,
  PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository,
  PostgresAuthorizedPluginPackageWorkflowRunListRepository,
  PostgresAuthorizedPluginPackageWorkflowStepRunListRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/workflow/pluginPackageWorkflowAdministration.js');
const {
  PostgresPluginPackageWorkflowFrontierRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/workflow/pluginPackageWorkflowFrontierRepository.js');
const {
  PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository.js');
const {
  PostgresStepRunRepository,
} = require('../packages/ql3-cluster-postgres/dist/run/stepRunRepository.js');
const {
  transitionStepRunMutation,
} = require('../packages/ql3-runtime-core/dist/run/stepRun.js');
const {
  createSecretRef,
} = require('../packages/ql3-runtime-core/dist/secret/secretReference.js');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('../packages/ql3-runtime-core/dist/plugin-package/publisher/pluginPackagePublisherTrust.js');
const {
  createPluginPackageQuarantineEvent,
  pluginPackageQuarantineMutationId,
} = require('../packages/ql3-runtime-core/dist/plugin-package/lifecycle/pluginPackageQuarantine.js');
const {
  createPluginPackageLifecycleEvent,
  pluginPackageLifecycleActionDigest,
} = require('../packages/ql3-runtime-core/dist/plugin-package/lifecycle/pluginPackageLifecycle.js');
const {
  ClusterSchedulerCoordinator,
} = require('../packages/ql3-cluster-control/dist/scheduling/scheduler.js');
const {
  cronerClusterNextOccurrence,
} = require('../packages/ql3-cluster-control/dist/scheduling/cronerSchedule.js');
const {
  ProjectToolDefinitionSnapshotPublicationCoordinator,
} = require('../packages/ql3-runtime-core/dist/tool-execution/tool-registry/projectToolDefinitionSnapshot.js');
const {
  PostgresApprovalRequestRepository,
} = require('../packages/ql3-cluster-postgres/dist/approved-action/approvalRequestRepository.js');
const {
  PostgresPluginPackageLifecycleRepository,
} = require('../packages/ql3-cluster-postgres/dist/plugin-package/lifecycle/pluginPackageLifecycleRepository.js');
const {
  createApprovalRequest,
} = require('../packages/ql3-runtime-core/dist/approved-action/approvedAction.js');
const {
  createClusterPluginPackagePublisherTrustManagementService,
} = require('../packages/ql3-cluster-admin/dist/plugin-package/publisher/pluginPackagePublisherTrustManagement.js');
const {
  runClusterPluginPackageExecutorProcess,
} = require('../packages/ql3-cluster-admin/dist/plugin-package/executor/pluginPackageExecutorProcess.js');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('../packages/ql3-runtime-core/dist/task-definition/taskSpecSemantic.js');
const {
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
} = require('../packages/ql3-runtime-core/dist/tool-execution/toolInvocationArtifact.js');
const {
  persistNonEmptyToolResultRetirement,
  verifyPromotedNonEmptyToolResult,
} = require('./ql3-postgres-ha-tool-result-fixture.cjs');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
  publisherProvenanceInstallRepository,
} = require('../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const requireClusterPostgresDependency = createRequire(
  path.resolve(__dirname, '../packages/ql3-cluster-postgres/package.json'),
);
const { Client: RawPostgresClient, Pool: RawPostgresPool } =
  requireClusterPostgresDependency('pg');

const IMAGE = process.env.QL3_HA_POSTGRES_IMAGE ?? 'postgres:18';
const SKIP_IMAGE_PULL = process.env.QL3_HA_SKIP_IMAGE_PULL === 'true';
const DATABASE = 'ql3_contract';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';
const MIGRATION_USER = 'ql3_migration';
const MIGRATION_PASSWORD = 'ql3_migration_test';
const RUNTIME_USER = 'ql3_runtime';
const RUNTIME_PASSWORD = 'ql3_runtime_test';
const AI_MAINTENANCE_USER = 'ql3_ai_maintenance';
const AI_MAINTENANCE_PASSWORD = 'ql3_ai_maintenance_test';
const AI_CREDENTIAL_MANAGER_USER = 'ql3_ai_credential_manager';
const AI_CREDENTIAL_MANAGER_PASSWORD = 'ql3_ai_credential_manager_test';
const AI_CREDENTIAL_TESTER_USER = 'ql3_ai_credential_tester';
const AI_CREDENTIAL_TESTER_PASSWORD = 'ql3_ai_credential_tester_test';
const ADMIN_USER = 'ql3_admin';
const ADMIN_PASSWORD = 'ql3_admin_test';
const AUTOMATION_MANAGER_USER = 'ql3_automation_manager';
const AUTOMATION_MANAGER_PASSWORD = 'ql3_automation_manager_test';
const APPROVAL_MANAGER_USER = 'ql3_approval_manager';
const APPROVAL_MANAGER_PASSWORD = 'ql3_approval_manager_test';
const RUN_MANAGER_USER = 'ql3_run_manager';
const RUN_MANAGER_PASSWORD = 'ql3_run_manager_test';
const PACKAGE_MANAGER_USER = 'ql3_package_manager';
const PACKAGE_MANAGER_PASSWORD = 'ql3_package_manager_test';
const PACKAGE_EXECUTOR_USER = 'ql3_package_executor';
const PACKAGE_EXECUTOR_PASSWORD = 'ql3_package_executor_test';
const WORKER_CREDENTIAL_MANAGER_USER = 'ql3_worker_credential_manager';
const WORKER_CREDENTIAL_MANAGER_PASSWORD = 'ql3_worker_credential_manager_test';
const WORKER_CREDENTIAL_EXECUTOR_USER = 'ql3_worker_credential_executor';
const WORKER_CREDENTIAL_EXECUTOR_PASSWORD =
  'ql3_worker_credential_executor_test';
const WORKER_INGRESS_USER = 'ql3_worker_ingress';
const WORKER_INGRESS_PASSWORD = 'ql3_worker_ingress_test';
const REPLICATION_USER = 'ql3_replicator';
const POSTGRES_VOLUME_ROOT = '/var/lib/postgresql';
const POSTGRES_DATA = '/var/lib/postgresql/18/docker';
const COMMAND_TIMEOUT_MS = 120_000;
const IMAGE_PULL_TIMEOUT_MS = 300_000;
const WAIT_TIMEOUT_MS = 30_000;
const SCHEDULER_FAILOVER_LEASE_MS = 15_000;
const MIN_PRE_FENCE_CLAIM_REMAINING_MS = 5_000;
const CHILD_STDERR_LIMIT = 32 * 1024;
const LIFECYCLE_CRASH_ACTOR = path.resolve(
  __dirname,
  'ql3-postgres-lifecycle-crash-actor.cjs',
);
const REPORT_ENVIRONMENT_VARIABLE = 'QL3_HA_REPORT';

const WORKER_CREDENTIAL_PEPPER = Buffer.alloc(32, 1).toString('base64url');

function privateReportPath(argv, environment = process.env) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    args.length > 1 ||
    (args.length === 1 && !args[0].startsWith('--report='))
  ) {
    throw new Error(
      'usage: ql3-postgres-ha-contract [--report=/absolute/private-report.json]',
    );
  }
  const argument = args[0]?.slice('--report='.length);
  const configured = environment[REPORT_ENVIRONMENT_VARIABLE];
  if (argument && configured) {
    throw new Error('configure the PostgreSQL HA report path only once');
  }
  const reportFile =
    argument ||
    configured ||
    path.join(
      fs.realpathSync(os.tmpdir()),
      `ql3-postgres-ha-report-${process.pid}-${randomBytes(6).toString(
        'hex',
      )}.json`,
    );
  if (
    !path.isAbsolute(reportFile) ||
    path.normalize(reportFile) !== reportFile ||
    path.parse(reportFile).root === reportFile ||
    reportFile.includes('\0')
  ) {
    throw new Error(
      'PostgreSQL HA report path must be a normalized absolute file',
    );
  }
  if (fs.existsSync(reportFile)) {
    throw new Error('refusing to overwrite the PostgreSQL HA report');
  }
  const parentPath = path.dirname(reportFile);
  const parent = fs.lstatSync(parentPath);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    fs.realpathSync(parentPath) !== parentPath
  ) {
    throw new Error(
      'PostgreSQL HA report parent must be a canonical real directory',
    );
  }
  return reportFile;
}

function writePrivateReport(reportFile, report) {
  const parentPath = path.dirname(reportFile);
  const temporaryReport = path.join(
    parentPath,
    `.${path.basename(reportFile)}.${process.pid}.` +
      `${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  let parentDescriptor;
  try {
    descriptor = fs.openSync(temporaryReport, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryReport, reportFile);
    parentDescriptor = fs.openSync(parentPath, 'r');
    fs.fsyncSync(parentDescriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor);
    fs.rmSync(temporaryReport, { force: true });
  }
}

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

function databaseUrl(user, password, port) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@127.0.0.1:${port}/${DATABASE}`;
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

function postCommitResponseLossPool(pool, evidence) {
  return {
    query(statement, values) {
      return pool.query(statement, values);
    },
    async connect() {
      const client = await pool.connect();
      client.on?.('error', () => {
        // The fixture deliberately terminates only this transaction client.
      });
      return {
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (
            !evidence.injected &&
            typeof statement === 'string' &&
            statement.trim().toUpperCase() === 'COMMIT'
          ) {
            evidence.commitCompletedBeforeFault = true;
            evidence.backendTerminationRequested = true;
            try {
              await client.query(
                'SELECT pg_terminate_backend(pg_backend_pid())',
              );
            } catch {
              evidence.backendConnectionRejected = true;
            }
            evidence.injected = true;
            const error = new Error('injected scheduler COMMIT response loss');
            error.code = 'ECONNRESET';
            throw error;
          }
          return result;
        },
        release() {
          client.release();
        },
      };
    },
  };
}

function nthCommitResponseLossPool(pool, evidence, commitNumber) {
  return {
    query(statement, values) {
      return pool.query(statement, values);
    },
    async connect() {
      const client = await pool.connect();
      client.on?.('error', () => {
        // The fixture deliberately terminates only this transaction client.
      });
      return {
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (
            typeof statement === 'string' &&
            statement.trim().toUpperCase() === 'COMMIT'
          ) {
            evidence.commitCount += 1;
            if (!evidence.injected && evidence.commitCount === commitNumber) {
              evidence.commitCompletedBeforeFault = true;
              evidence.backendTerminationRequested = true;
              try {
                await client.query(
                  'SELECT pg_terminate_backend(pg_backend_pid())',
                );
              } catch {
                evidence.backendConnectionRejected = true;
              }
              evidence.injected = true;
              const error = new Error('injected COMMIT response loss');
              error.code = 'ECONNRESET';
              throw error;
            }
          }
          return result;
        },
        release() {
          client.release();
        },
      };
    },
  };
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
          SUPERUSER,
          '-d',
          DATABASE,
        ],
        { allowFailure: true },
      ).status === 0,
    `${containerName} PostgreSQL readiness`,
  );
}

function mappedPostgresPort(containerName) {
  const output = docker(['port', containerName, '5432/tcp']).stdout;
  const match = output.match(/:(\d+)\s*$/);
  if (!match) throw new Error(`cannot parse mapped PostgreSQL port: ${output}`);
  return Number(match[1]);
}

async function startEndpointProxy(initialPort) {
  let targetPort = initialPort;
  const pairs = new Set();
  const server = net.createServer((client) => {
    const upstream = net.createConnection({
      host: '127.0.0.1',
      port: targetPort,
    });
    const pair = { client, upstream };
    pairs.add(pair);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.once('error', close);
    client.once('close', close);
    upstream.once('error', close);
    upstream.once('close', close);
    client.pipe(upstream).pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('HA endpoint proxy did not bind a TCP address');
  }
  return {
    host: '127.0.0.1',
    port: address.port,
    switchTarget(port) {
      targetPort = port;
      for (const pair of [...pairs]) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      pairs.clear();
    },
    async close() {
      for (const pair of [...pairs]) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      pairs.clear();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function boundedAppend(current, chunk) {
  return `${current}${chunk}`.slice(-CHILD_STDERR_LIMIT);
}

async function startReplica(options) {
  const childPath = path.resolve(__dirname, 'ql3-postgres-ha-replica.cjs');
  const child = fork(childPath, [], {
    env: {
      ...process.env,
      QL3_HA_DATABASE_URL: options.databaseUrl,
      QL3_HA_REPLICA_ID: options.replicaId,
      QL3_HA_APPLICATION_NAME: options.applicationName,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let exited = false;
  let exitError;
  let requestSequence = 0;
  const pending = new Map();
  child.stderr.on('data', (chunk) => {
    stderr = boundedAppend(stderr, chunk.toString('utf8'));
  });
  child.stdout.on('data', () => {});
  child.once('exit', (code, signal) => {
    exited = true;
    exitError = new Error(
      `HA replica ${options.replicaId} exited code=${code} signal=${signal}${
        stderr ? `: ${stderr.trim()}` : ''
      }`,
    );
    rejectReady?.(exitError);
    for (const entry of pending.values()) entry.reject(exitError);
    pending.clear();
  });

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      resolveReady(message);
      return;
    }
    if (message.type === 'fatal') {
      rejectReady(new Error(message.message));
      return;
    }
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.type === 'request-error') {
      entry.reject(new Error(message.message));
    } else {
      entry.resolve(message);
    }
  });

  async function request(type, timeoutMs = 5_000) {
    if (exited) {
      throw exitError ?? new Error(`HA replica ${options.replicaId} exited`);
    }
    const requestId = `${options.replicaId}:${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`HA replica ${options.replicaId} ${type} timed out`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      child.send({ type, requestId });
    });
  }

  let readyRecord;
  try {
    readyRecord = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `HA replica ${options.replicaId} startup timed out${
                stderr ? `: ${stderr.trim()}` : ''
              }`,
            ),
          ),
        WAIT_TIMEOUT_MS,
      );
      ready.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  } catch (error) {
    if (!exited) {
      child.kill('SIGTERM');
      await waitFor(
        () => exited,
        `${options.replicaId} failed-start exit`,
        10_000,
      ).catch(() => child.kill('SIGKILL'));
    }
    throw error;
  }
  return {
    child,
    ready: readyRecord,
    request,
    async stop() {
      if (exited) return;
      try {
        await request('stop', 10_000);
      } catch {
        child.kill('SIGTERM');
      }
      await waitFor(() => exited, `${options.replicaId} exit`, 10_000).catch(
        () => child.kill('SIGKILL'),
      );
    },
  };
}

function probe(address, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: address.host,
        port: address.port,
        path: requestPath,
        method: 'GET',
        headers: { connection: 'close' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: response.statusCode,
            body: body ? JSON.parse(body) : null,
          });
        });
      },
    );
    request.once('error', reject);
    request.end();
  });
}

async function replicaStatuses(replicas) {
  return Promise.all(
    replicas.map(async (replica) => {
      const status = await replica.request('status');
      return {
        replicaId: status.replicaId,
        availability: status.availability,
      };
    }),
  );
}

async function waitForReplicasUnavailable(replicas) {
  return waitFor(async () => {
    const statuses = await replicaStatuses(replicas);
    return statuses.every((status) => status.availability === 'unavailable')
      ? statuses
      : null;
  }, 'both old control replicas to become unavailable');
}

async function backendFacts(database, applicationNames) {
  const result = await database.pool.query(
    `SELECT pid::text AS "backendPid", application_name AS "applicationName"
       FROM pg_stat_activity
      WHERE application_name = ANY($1::text[])
      ORDER BY application_name`,
    [applicationNames],
  );
  return result.rows;
}

async function timelineId(database) {
  const result = await database.pool.query(
    `SELECT pg_walfile_name(pg_current_wal_lsn()) AS "walFile"`,
  );
  assert.equal(result.rowCount, 1);
  const walFile = result.rows[0].walFile;
  if (typeof walFile !== 'string' || !/^[0-9A-F]{24}$/.test(walFile)) {
    throw new Error('PostgreSQL returned an invalid current WAL file name');
  }
  return Number.parseInt(walFile.slice(0, 8), 16);
}

async function modelInvocationFeatureFacts(pool) {
  const catalog = await pool.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspname = 'ql3_ai'
       ) AS "schemaExists"`,
  );
  const tables = await pool.query(
    `SELECT tablename AS "tableName"
      FROM pg_tables
      WHERE schemaname = 'ql3_ai'
        AND (
          tablename LIKE 'model_invocation_%'
          OR tablename LIKE 'model_price_catalog_%'
          OR tablename LIKE 'model_provider_credential_%'
        )
      ORDER BY tablename`,
  );
  const history = await pool.query(
    `SELECT migration_id AS "migrationId", checksum
       FROM "ql3_ai"."ai_schema_migrations"
      ORDER BY migration_id`,
  );
  const privileges = await pool.query(
    `SELECT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_starts', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_starts', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_starts', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_starts', 'DELETE'
       ) AS "startsAppendOnly",
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_completions', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_completions', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_completions', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_completions', 'DELETE'
       ) AS "completionsAppendOnly",
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_resolutions', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_resolutions', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_resolutions', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_resolutions', 'DELETE'
       ) AS "resolutionsAppendOnly",
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_usage_ledger', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_usage_ledger', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_usage_ledger', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_invocation_usage_ledger', 'DELETE'
       ) AS "usageLedgerAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_reservations', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_reservations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_reservations', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_reservations', 'DELETE'
       ) AS "quotaReservationsAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_settlements', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_settlements', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_settlements', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_quota_settlements', 'DELETE'
       ) AS "quotaSettlementsAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_quotes', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_quotes', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_quotes', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_quotes', 'DELETE'
       ) AS "priceQuotesAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_settlements', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_settlements', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_settlements', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_price_settlements', 'DELETE'
       ) AS "priceSettlementsAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_publications', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_publications', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_publications', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_publications', 'DELETE'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_heads', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_heads', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_heads', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_heads', 'DELETE'
       ) AS "catalogRuntimeReadOnly",
       NOT has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_authorizations', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_authorizations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_authorizations', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_price_catalog_authorizations', 'DELETE'
       ) AS "catalogAuthorizationRuntimeDenied",
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_publications', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_publications', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_publications', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_publications', 'DELETE'
       ) AND
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_heads', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_heads', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_heads', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_heads', 'DELETE'
       ) AS "catalogAdminAppendOnly",
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_authorizations', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_authorizations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_authorizations', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_price_catalog_authorizations', 'DELETE'
       ) AS "catalogAuthorizationAdminAppendOnly",
       NOT has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_price_catalog_publications', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_price_catalog_publications', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_price_catalog_publications', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_price_catalog_heads', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_price_catalog_heads', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_price_catalog_heads', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_price_catalog_authorizations', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_price_catalog_authorizations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_price_catalog_authorizations', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_price_catalog_authorizations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_price_catalog_authorizations', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_price_catalog_authorizations', 'INSERT'
       ) AS "catalogOtherRolesDenied",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_admissions', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_admissions', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_admissions', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_admissions', 'DELETE'
       ) AS "promptAdmissionsAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_finalizations', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_finalizations', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_finalizations', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_finalizations', 'DELETE'
       ) AS "promptFinalizationsAppendOnly",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT,INSERT'
       ) AND
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'SELECT'
       ) AND
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifacts', 'UPDATE'
       ) AS "promptOutputArtifactAuthoritySplit",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones', 'SELECT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'DELETE'
       ) AND
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'SELECT'
       ) AND
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'INSERT'
       ) AND NOT
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'UPDATE'
       ) AND NOT
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT
       has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_invocation_prompt_output_artifact_tombstones',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AS "promptOutputTombstoneAuthoritySplit",
       has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT'
       ) AND NOT has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_runtime',
         'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT'
       ) AND has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
         'SELECT'
       ) AND has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
         'INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_retirement_completions',
         'UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_admin',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_package_manager',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_package_executor',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_worker_ingress',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AS "promptOutputKeyRetirementAuthoritySplit",
       has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
         'UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_invocation_prompt_output_key_rotation_completions',
         'UPDATE,DELETE'
       ) AND NOT EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
             'ql3_runtime', 'ql3_admin', 'ql3_package_manager',
             'ql3_package_executor', 'ql3_automation_manager',
             'ql3_approval_manager',
             'ql3_worker_ingress', 'ql3_worker_credential_manager',
             'ql3_worker_credential_executor', 'ql3_ai_credential_manager',
             'ql3_ai_credential_tester'
           ]::text[]) AS denied(role_name)
           CROSS JOIN unnest(ARRAY[
             'ql3_ai.model_invocation_prompt_output_key_rotation_preparations',
             'ql3_ai.model_invocation_prompt_output_key_rotation_completions'
           ]::text[]) AS rotation_table(table_name)
          WHERE has_table_privilege(
            denied.role_name,
            rotation_table.table_name,
            'SELECT,INSERT,UPDATE,DELETE'
          )
       ) AS "promptOutputKeyRotationAuthoritySplit",
       has_function_privilege(
         'ql3_runtime',
         'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
         'EXECUTE'
       ) AND NOT
       has_function_privilege(
         'ql3_admin',
         'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
         'EXECUTE'
       ) AND NOT
       has_function_privilege(
         'ql3_package_manager',
         'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
         'EXECUTE'
       ) AND NOT
       has_function_privilege(
         'ql3_package_executor',
         'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
         'EXECUTE'
       ) AND NOT
       has_function_privilege(
         'ql3_worker_ingress',
         'ql3_ai.plugin_package_prompt_admission_snapshot(varchar,varchar,character,varchar,varchar,integer,integer)',
         'EXECUTE'
       ) AS "promptSnapshotRuntimeOnly",
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.ai_schema_migrations', 'SELECT'
       ) AND NOT has_table_privilege(
         'ql3_runtime', 'ql3_ai.ai_schema_migrations', 'INSERT,UPDATE,DELETE'
       ) AS "migrationHistoryRuntimeReadOnly",
       has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_bindings', 'SELECT'
       ) AND NOT has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_bindings',
         'INSERT,UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_transitions', 'SELECT'
       ) AND NOT has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_transitions',
         'INSERT,UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_audits',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_runtime', 'ql3_ai.model_provider_credential_audits',
         'UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_bindings',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_bindings',
         'UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_transitions',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_transitions',
         'UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_audits',
         'SELECT'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager', 'ql3_ai.model_provider_credential_audits',
         'INSERT,UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager',
         'ql3_ai.model_provider_credential_management_identity_keyset_ledger',
         'SELECT,INSERT,UPDATE'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager',
         'ql3_ai.model_provider_credential_management_identity_keyset_ledger',
         'DELETE'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance', 'ql3_ai.model_provider_credential_bindings',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance', 'ql3_ai.model_provider_credential_transitions',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_ai_maintenance',
         'ql3_ai.model_provider_credential_management_identity_keyset_ledger',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager',
         'ql3_ai.model_invocation_prompt_output_artifacts',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager',
         'ql3_ai.model_invocation_prompt_output_key_retirement_preparations',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3.projects', 'SELECT'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3.project_role_bindings', 'SELECT'
       ) AND has_table_privilege(
         'ql3_ai_credential_manager', 'ql3.security_audit_events',
         'SELECT,INSERT'
       ) AND NOT has_table_privilege(
         'ql3_ai_credential_manager', 'ql3.security_audit_events',
         'UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_admin', 'ql3_ai.model_provider_credential_bindings',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_package_manager', 'ql3_ai.model_provider_credential_bindings',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AND NOT has_table_privilege(
         'ql3_worker_ingress', 'ql3_ai.model_provider_credential_bindings',
         'SELECT,INSERT,UPDATE,DELETE'
       ) AS "modelProviderCredentialManagementAuthoritySplit"`,
  );
  return {
    schemaExists: catalog.rows[0].schemaExists,
    tables: tables.rows.map(({ tableName }) => tableName),
    history: history.rows,
    privileges: privileges.rows[0],
  };
}

async function runModelProviderCredentialCatalogMatrix(options) {
  const { primaryPort, migrationPool } = options;
  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const projectId = `ai-credential-${suffix}`;
  const provider = 'openai-compatible';
  const actor = Object.freeze({ type: 'user', id: `ai-owner-${suffix}` });
  const fence = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
  const secretRef = createSecretRef({
    projectId,
    name: 'provider-token',
  });
  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, $1, $1, 'active', 1, 1, 1)`,
    [projectId],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', $2, 1, 'active', 'owner',
               $3, 'system', 'ha-contract', 1)`,
    [projectId, actor.id, `ai-owner-binding-${suffix}`],
  );
  const managerDatabase = await databaseOpener(
    'ai-credential-manager',
    databaseUrl(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
    ),
    'ql3-ha-ai-credential-manager',
  )();
  const secondManagerDatabase = await databaseOpener(
    'ai-credential-manager',
    databaseUrl(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
    ),
    'ql3-ha-ai-credential-manager-second',
  )();
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-ai-credential-runtime',
  )();
  try {
    const managerReadiness =
      await assertPostgresModelProviderCredentialManagerReady(
        managerDatabase.pool,
      );
    const catalog = new PostgresModelProviderCredentialRepository(
      managerDatabase.pool,
    );
    const runtime = new PostgresModelProviderCredentialReader(
      runtimeDatabase.pool,
    );
    const authorized = (command, requestId, occurredAtMs) =>
      Object.freeze({
        command,
        actor,
        fence,
        audit: Object.freeze({
          eventId: command.mutationId,
          requestId,
          operationId: modelProviderCredentialAdministrationOperationId(
            command.action,
          ),
          projectId,
          subject: actor,
          authenticationId: `ha-authentication-${suffix}`,
          outcome: 'allowed',
          reasons: Object.freeze(['project_owner']),
          fence,
          occurredAtMs,
        }),
      });
    const bindingV1 = Object.freeze({
      schema: MODEL_PROVIDER_CREDENTIAL_BINDING_SCHEMA,
      projectId,
      provider,
      revision: 'credential-v1',
      secretRef,
      scheme: 'bearer',
    });
    const bindV1 = createModelProviderCredentialTransitionCommand({
      schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
      mutationId: randomUUID(),
      projectId,
      provider,
      expectedGeneration: 0,
      action: 'bind',
      binding: bindingV1,
      changedBy: actor,
    });
    const bindV1Authorized = authorized(
      bindV1,
      `bind-v1-request-${suffix}`,
      10,
    );
    const responseLossEvidence = credentialCommitFaultEvidence();
    const responseLoss = credentialCommitFaultPool(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
      'ql3-ha-ai-credential-response-loss',
      responseLossEvidence,
    );
    try {
      const faultCatalog = new PostgresModelProviderCredentialRepository(
        responseLoss.repositoryPool,
      );
      await assert.rejects(
        faultCatalog.commitAuthorized(bindV1Authorized),
        ModelProviderCredentialCatalogUnavailableError,
      );
    } finally {
      await responseLoss.pool.end();
    }
    assert.deepEqual(responseLossEvidence, {
      injected: true,
      commitCompletedBeforeFault: true,
      backendTerminationRequested: true,
      backendConnectionRejected: true,
    });
    const first = await catalog.commitAuthorized(bindV1Authorized);
    const replay = await catalog.commitAuthorized(bindV1Authorized);
    assert.equal(first.status, 'existing');
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.transition, first.transition);
    const stale = createModelProviderCredentialTransitionCommand({
      schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
      mutationId: randomUUID(),
      projectId,
      provider,
      expectedGeneration: 0,
      action: 'bind',
      binding: { ...bindingV1, revision: 'stale-v2' },
      changedBy: actor,
    });
    await assert.rejects(
      catalog.commitAuthorized(
        authorized(stale, `stale-bind-request-${suffix}`, 11),
      ),
      (error) =>
        error?.code ===
        'MODEL_PROVIDER_CREDENTIAL_ADMINISTRATION_MUTATION_CONFLICT',
    );
    assert.deepEqual(
      await runtime.resolveModelProviderCredentialBinding({
        projectId,
        provider,
      }),
      bindingV1,
    );
    const credentialAudit = Object.freeze({
      schema: MODEL_PROVIDER_CREDENTIAL_AUDIT_SCHEMA,
      operation: 'generate',
      projectId,
      provider,
      requestId: `request-${suffix}`,
      bindingRevision: bindingV1.revision,
      bindingDigest: digestModelProviderCredentialBinding(bindingV1),
      occurredAtMs: 10,
    });
    await runtime.record(credentialAudit);
    await runtime.record(credentialAudit);
    const auditFacts = await migrationPool.query(
      `SELECT audit_json AS "auditJson"
         FROM "ql3_ai"."model_provider_credential_audits"
        WHERE project_id = $1 AND request_id = $2`,
      [projectId, credentialAudit.requestId],
    );
    assert.equal(auditFacts.rowCount, 1);
    assert.deepEqual(auditFacts.rows[0].auditJson, credentialAudit);
    const serializedAudit = JSON.stringify(auditFacts.rows[0].auditJson);
    assert.equal(serializedAudit.includes('secretRef'), false);
    assert.equal(serializedAudit.includes('provider-token'), false);
    await assert.rejects(
      runtimeDatabase.pool.query(
        `UPDATE "ql3_ai"."model_provider_credential_bindings"
            SET revision = revision
          WHERE project_id = $1`,
        [projectId],
      ),
      (error) => error?.code === '42501',
    );
    await assert.rejects(
      managerDatabase.pool.query(
        `DELETE FROM "ql3_ai"."model_provider_credential_transitions"
          WHERE project_id = $1`,
        [projectId],
      ),
      (error) => error?.code === '42501',
    );
    const revokeCommand = createModelProviderCredentialTransitionCommand({
      schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
      mutationId: randomUUID(),
      projectId,
      provider,
      expectedGeneration: 1,
      action: 'revoke',
      binding: null,
      changedBy: actor,
    });
    const revoke = await catalog.commitAuthorized(
      authorized(revokeCommand, `revoke-request-${suffix}`, 12),
    );
    assert.equal(revoke.status, 'created');
    assert.equal(
      await runtime.resolveModelProviderCredentialBinding({
        projectId,
        provider,
      }),
      null,
    );
    const bindingV2 = Object.freeze({
      ...bindingV1,
      revision: 'credential-v2',
    });
    const bindV2Command = createModelProviderCredentialTransitionCommand({
      schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
      mutationId: randomUUID(),
      projectId,
      provider,
      expectedGeneration: 2,
      action: 'bind',
      binding: bindingV2,
      changedBy: actor,
    });
    const rebound = await catalog.commitAuthorized(
      authorized(bindV2Command, `bind-v2-request-${suffix}`, 13),
    );
    assert.equal(rebound.status, 'created');
    assert.deepEqual(
      await runtime.resolveModelProviderCredentialBinding({
        projectId,
        provider,
      }),
      bindingV2,
    );
    const competingBindings = Object.freeze([
      Object.freeze({ ...bindingV1, revision: 'credential-v3-left' }),
      Object.freeze({ ...bindingV1, revision: 'credential-v3-right' }),
    ]);
    const competingCommands = competingBindings.map((binding) =>
      createModelProviderCredentialTransitionCommand({
        schema: MODEL_PROVIDER_CREDENTIAL_TRANSITION_COMMAND_SCHEMA,
        mutationId: randomUUID(),
        projectId,
        provider,
        expectedGeneration: 3,
        action: 'bind',
        binding,
        changedBy: actor,
      }),
    );
    const competingResults = await Promise.allSettled(
      competingCommands.map((command, index) =>
        catalog.commitAuthorized(
          authorized(
            command,
            `competing-bind-${index + 1}-request-${suffix}`,
            14 + index,
          ),
        ),
      ),
    );
    const competingWinnerIndexes = competingResults.flatMap((result, index) =>
      result.status === 'fulfilled' ? [index] : [],
    );
    const competingWinners = competingWinnerIndexes.map(
      (index) => competingResults[index],
    );
    const competingLosers = competingResults.filter(
      (result) => result.status === 'rejected',
    );
    assert.equal(competingWinners.length, 1);
    assert.equal(competingLosers.length, 1);
    assert.equal(competingWinners[0].value.status, 'created');
    assert.equal(
      competingLosers[0].reason?.code,
      'MODEL_PROVIDER_CREDENTIAL_ADMINISTRATION_MUTATION_CONFLICT',
    );
    const winningBinding = competingBindings[competingWinnerIndexes[0]];
    assert.deepEqual(
      await runtime.resolveModelProviderCredentialBinding({
        projectId,
        provider,
      }),
      winningBinding,
    );
    const managementAudits = await migrationPool.query(
      `SELECT operation_id AS "operationId", project_id AS "projectId",
              subject_type AS "subjectType", subject_id AS "subjectId",
              authentication_id AS "authenticationId", outcome, reasons,
              project_version AS "projectVersion",
              binding_version AS "bindingVersion"
        FROM "ql3"."security_audit_events"
        WHERE project_id = $1
          AND operation_id IN (
            'model_provider_credential.bind',
            'model_provider_credential.revoke'
          )
        ORDER BY occurred_at_ms, operation_id`,
      [projectId],
    );
    assert.equal(managementAudits.rowCount, 4);
    assert.deepEqual(
      managementAudits.rows.map((row) => row.operationId),
      [
        'model_provider_credential.bind',
        'model_provider_credential.revoke',
        'model_provider_credential.bind',
        'model_provider_credential.bind',
      ],
    );
    const serializedManagementAudit = JSON.stringify(managementAudits.rows);
    assert.equal(serializedManagementAudit.includes('secretRef'), false);
    assert.equal(serializedManagementAudit.includes('provider-token'), false);
    const auditQueryRepository =
      new PostgresModelProviderCredentialManagementAuditQueryRepository(
        managerDatabase.pool,
      );
    const authorizedAuditQuery = (queryId, requestId, occurredAtMs, before) =>
      Object.freeze({
        query: Object.freeze({
          schemaVersion: 1,
          queryId,
          requestId,
          projectId,
          limit: 2,
          ...(before === undefined ? {} : { before }),
        }),
        actor,
        fence,
        audit: Object.freeze({
          eventId: queryId,
          requestId,
          operationId:
            MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
          projectId,
          subject: actor,
          authenticationId: `ha-authentication-${suffix}`,
          outcome: 'allowed',
          reasons: Object.freeze(['project_owner']),
          fence,
          occurredAtMs,
        }),
      });
    const firstAuditQuery = authorizedAuditQuery(
      randomUUID(),
      `audit-list-first-${suffix}`,
      16,
    );
    const auditQueryResponseLossEvidence = credentialCommitFaultEvidence();
    const auditQueryResponseLoss = credentialCommitFaultPool(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
      'ql3-ha-ai-credential-audit-query-response-loss',
      auditQueryResponseLossEvidence,
    );
    try {
      const responseLossAuditQuery =
        new PostgresModelProviderCredentialManagementAuditQueryRepository(
          auditQueryResponseLoss.repositoryPool,
        );
      await assert.rejects(
        responseLossAuditQuery.listAuthorized(firstAuditQuery),
        ModelProviderCredentialManagementAuditUnavailableError,
      );
    } finally {
      await auditQueryResponseLoss.pool.end();
    }
    assert.deepEqual(auditQueryResponseLossEvidence, {
      injected: true,
      commitCompletedBeforeFault: true,
      backendTerminationRequested: true,
      backendConnectionRejected: true,
    });
    const firstAuditPage = await auditQueryRepository.listAuthorized(
      firstAuditQuery,
    );
    assert.equal(firstAuditPage.records.length, 2);
    assert.notEqual(firstAuditPage.nextCursor, null);
    const secondAuditPage = await auditQueryRepository.listAuthorized(
      authorizedAuditQuery(
        randomUUID(),
        `audit-list-second-${suffix}`,
        17,
        firstAuditPage.nextCursor,
      ),
    );
    assert.equal(secondAuditPage.records.length, 2);
    assert.equal(secondAuditPage.nextCursor, null);
    const queriedManagementAudits = [
      ...firstAuditPage.records,
      ...secondAuditPage.records,
    ];
    assert.deepEqual(
      new Set(queriedManagementAudits.map(({ operation }) => operation)),
      new Set(['provider-credential.bind', 'provider-credential.revoke']),
    );
    assert.equal(
      new Set(queriedManagementAudits.map(({ eventId }) => eventId)).size,
      4,
    );
    const serializedAuditQuery = JSON.stringify({
      firstAuditPage,
      secondAuditPage,
    });
    for (const forbidden of [
      'secretRef',
      'provider-token',
      'authenticationId',
      'bindingDigest',
      'transitionDigest',
    ]) {
      assert.equal(serializedAuditQuery.includes(forbidden), false);
    }
    const auditQueryAccessFacts = await migrationPool.query(
      `SELECT event_id AS "eventId"
         FROM "ql3"."security_audit_events"
        WHERE project_id = $1
          AND operation_id = $2
        ORDER BY occurred_at_ms, event_id`,
      [
        projectId,
        MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
      ],
    );
    assert.equal(auditQueryAccessFacts.rowCount, 2);
    const maintenanceDatabase = await databaseOpener(
      'ai-maintenance',
      databaseUrl(AI_MAINTENANCE_USER, AI_MAINTENANCE_PASSWORD, primaryPort),
      'ql3-ha-ai-maintenance-credential-deny',
    )();
    try {
      await assert.rejects(
        maintenanceDatabase.pool.query(
          `SELECT 1 FROM "ql3_ai"."model_provider_credential_bindings"
            WHERE project_id = $1 LIMIT 1`,
          [projectId],
        ),
        (error) => error?.code === '42501',
      );
    } finally {
      await maintenanceDatabase.close();
    }
    const identityLedger =
      new PostgresModelProviderCredentialManagementIdentityLedgerRepository(
        managerDatabase.pool,
      );
    const secondIdentityLedger =
      new PostgresModelProviderCredentialManagementIdentityLedgerRepository(
        secondManagerDatabase.pool,
      );
    const identitySnapshot = (
      generation,
      activeKeyIds,
      revokedKeyIds,
      overrides = {},
    ) =>
      Object.freeze({
        schemaVersion: 1,
        generation,
        digest: String.fromCharCode(64 + generation).repeat(43),
        issuer: 'https://provider-credential-identity.ha.example.test/',
        audience: 'qinglong3-model-provider-credential-management',
        activeKeyIds: Object.freeze(activeKeyIds),
        revokedKeyIds: Object.freeze(revokedKeyIds),
        ...overrides,
      });
    const identityGenerationOne = identitySnapshot(
      1,
      ['ha-provider-credential-identity-1'],
      [],
    );
    const identityGenerationTwo = identitySnapshot(
      2,
      ['ha-provider-credential-identity-2'],
      ['ha-provider-credential-identity-1'],
    );
    await identityLedger.observe(identityGenerationOne);
    await Promise.all([
      identityLedger.observe(identityGenerationTwo),
      secondIdentityLedger.observe(identityGenerationTwo),
    ]);
    await assert.rejects(
      secondIdentityLedger.observe(identityGenerationOne),
      PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
    );
    await assert.rejects(
      secondIdentityLedger.observe({
        ...identityGenerationTwo,
        digest: 'Z'.repeat(43),
      }),
      PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
    );
    await assert.rejects(
      secondIdentityLedger.observe(
        identitySnapshot(3, ['ha-provider-credential-identity-3'], []),
      ),
      PostgresModelProviderCredentialManagementIdentityLedgerConflictError,
    );
    const identityResponseLossEvidence = credentialCommitFaultEvidence();
    const identityResponseLoss = credentialCommitFaultPool(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
      'ql3-ha-ai-credential-identity-response-loss',
      identityResponseLossEvidence,
    );
    const identityGenerationThree = identitySnapshot(
      3,
      ['ha-provider-credential-identity-3'],
      [
        'ha-provider-credential-identity-1',
        'ha-provider-credential-identity-2',
      ],
    );
    try {
      const responseLossIdentityLedger =
        new PostgresModelProviderCredentialManagementIdentityLedgerRepository(
          identityResponseLoss.repositoryPool,
        );
      await assert.rejects(
        responseLossIdentityLedger.observe(identityGenerationThree),
        PostgresModelProviderCredentialManagementIdentityLedgerUnavailableError,
      );
    } finally {
      await identityResponseLoss.pool.end();
    }
    await secondIdentityLedger.observe(identityGenerationThree);
    const identityFacts = await managerDatabase.pool.query(
      `SELECT generation::text, digest, issuer, audience,
              active_key_ids AS "activeKeyIds",
              revoked_key_ids AS "revokedKeyIds"
         FROM "ql3_ai"."model_provider_credential_management_identity_keyset_ledger"
        WHERE authority = 'model-provider-credential-management'`,
    );
    assert.deepEqual(identityFacts.rows, [
      {
        generation: '3',
        digest: 'C'.repeat(43),
        issuer: identityGenerationThree.issuer,
        audience: identityGenerationThree.audience,
        activeKeyIds: identityGenerationThree.activeKeyIds,
        revokedKeyIds: identityGenerationThree.revokedKeyIds,
      },
    ]);
    return {
      projectId,
      provider,
      actorId: actor.id,
      activeRevision: winningBinding.revision,
      activeTransitionDigest:
        competingWinners[0].value.transition.transitionDigest,
      credentialAuditRequestId: credentialAudit.requestId,
      managementAuditCount: managementAudits.rowCount,
      auditQueryAccessCount: auditQueryAccessFacts.rowCount,
      auditQueryRecordCount: queriedManagementAudits.length,
      auditQueryCommitResponseLossRecovered: true,
      auditQueryPagination: true,
      auditQueryReplay: {
        queryId: firstAuditQuery.query.queryId,
        requestId: firstAuditQuery.query.requestId,
        authenticationId: firstAuditQuery.audit.authenticationId,
        occurredAtMs: firstAuditQuery.audit.occurredAtMs,
      },
      exactReplay: true,
      commitResponseLossRecovered: true,
      concurrentSingleWinner: true,
      staleCasRejected: true,
      revokeObserved: true,
      contentFreeAudit: true,
      authoritySplit: true,
      managerReadiness,
      identityKeysetLedger: {
        ...identityFacts.rows[0],
        competingInstances: 2,
        rollbackRejected: true,
        sameGenerationRewriteRejected: true,
        implicitRemovalRejected: true,
        commitResponseLossConverged:
          identityResponseLossEvidence.commitCompletedBeforeFault,
        survivedPromotion: false,
      },
      survivedPromotion: false,
    };
  } finally {
    await Promise.all([
      managerDatabase.close(),
      secondManagerDatabase.close(),
      runtimeDatabase.close(),
    ]);
  }
}

async function verifyModelProviderCredentialCatalogAfterPromotion(options) {
  const { promotedPort, promotedPool, report } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-ai-credential-promoted-runtime',
  )();
  const managerDatabase = await databaseOpener(
    'ai-credential-manager',
    databaseUrl(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      promotedPort,
    ),
    'ql3-ha-ai-credential-promoted-manager',
  )();
  try {
    const runtime = new PostgresModelProviderCredentialReader(
      runtimeDatabase.pool,
    );
    const binding = await runtime.resolveModelProviderCredentialBinding({
      projectId: report.projectId,
      provider: report.provider,
    });
    assert.equal(binding?.revision, report.activeRevision);
    const facts = await promotedPool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3_ai"."model_provider_credential_bindings"
           WHERE project_id = $1) AS "bindingCount",
         (SELECT count(*)::integer
            FROM "ql3_ai"."model_provider_credential_transitions"
           WHERE project_id = $1) AS "transitionCount",
         (SELECT count(*)::integer
            FROM "ql3_ai"."model_provider_credential_audits"
           WHERE project_id = $1 AND request_id = $2) AS "auditCount",
         (SELECT count(*)::integer
            FROM "ql3"."security_audit_events"
           WHERE project_id = $1
             AND operation_id IN (
               'model_provider_credential.bind',
               'model_provider_credential.revoke'
             )) AS "managementAuditCount",
         (SELECT count(*)::integer
            FROM "ql3"."security_audit_events"
           WHERE project_id = $1
             AND operation_id = $3) AS "auditQueryAccessCount"`,
      [
        report.projectId,
        report.credentialAuditRequestId,
        MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
      ],
    );
    assert.deepEqual(facts.rows[0], {
      bindingCount: 3,
      transitionCount: 4,
      auditCount: 1,
      managementAuditCount: 4,
      auditQueryAccessCount: 2,
    });
    const promotedAuditQuery =
      new PostgresModelProviderCredentialManagementAuditQueryRepository(
        managerDatabase.pool,
      );
    const promotedAuditPage = await promotedAuditQuery.listAuthorized({
      query: {
        schemaVersion: 1,
        queryId: report.auditQueryReplay.queryId,
        requestId: report.auditQueryReplay.requestId,
        projectId: report.projectId,
        limit: 2,
      },
      actor: { type: 'user', id: report.actorId },
      fence: { projectVersion: 1, bindingVersion: 1 },
      audit: {
        eventId: report.auditQueryReplay.queryId,
        requestId: report.auditQueryReplay.requestId,
        operationId:
          MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
        projectId: report.projectId,
        subject: { type: 'user', id: report.actorId },
        authenticationId: report.auditQueryReplay.authenticationId,
        outcome: 'allowed',
        reasons: ['project_owner'],
        fence: { projectVersion: 1, bindingVersion: 1 },
        occurredAtMs: report.auditQueryReplay.occurredAtMs,
      },
    });
    assert.equal(promotedAuditPage.records.length, 2);
    assert.notEqual(promotedAuditPage.nextCursor, null);
    const promotedAuditAccessFacts = await promotedPool.query(
      `SELECT count(*)::integer AS "auditQueryAccessCount"
         FROM "ql3"."security_audit_events"
        WHERE project_id = $1
          AND operation_id = $2`,
      [
        report.projectId,
        MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_AUDIT_QUERY_OPERATION_ID,
      ],
    );
    assert.equal(
      promotedAuditAccessFacts.rows[0].auditQueryAccessCount,
      report.auditQueryAccessCount,
    );
    report.auditQueryAfterPromotion = {
      recordCount: promotedAuditPage.records.length,
      accessAuditCount: promotedAuditAccessFacts.rows[0].auditQueryAccessCount,
      contentFree:
        !JSON.stringify(promotedAuditPage).includes('secretRef') &&
        !JSON.stringify(promotedAuditPage).includes('authenticationId'),
    };
    const identityFacts = await promotedPool.query(
      `SELECT generation::text, digest, issuer, audience,
              active_key_ids AS "activeKeyIds",
              revoked_key_ids AS "revokedKeyIds"
         FROM "ql3_ai"."model_provider_credential_management_identity_keyset_ledger"
        WHERE authority = 'model-provider-credential-management'`,
    );
    assert.deepEqual(identityFacts.rows, [
      {
        generation: report.identityKeysetLedger.generation,
        digest: report.identityKeysetLedger.digest,
        issuer: report.identityKeysetLedger.issuer,
        audience: report.identityKeysetLedger.audience,
        activeKeyIds: report.identityKeysetLedger.activeKeyIds,
        revokedKeyIds: report.identityKeysetLedger.revokedKeyIds,
      },
    ]);
    report.identityKeysetLedger.afterPromotion = identityFacts.rows[0];
    report.identityKeysetLedger.survivedPromotion = true;
    report.survivedPromotion = true;
  } finally {
    await Promise.all([runtimeDatabase.close(), managerDatabase.close()]);
  }
}

async function modelProviderCredentialTestConnectionFacts(
  pool,
  testId,
  executionId,
) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_provider_credential_test_plans"
         WHERE test_id = $1::uuid) AS "planCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_provider_credential_test_executions"
         WHERE test_id = $1::uuid) AS "executionCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_provider_credential_test_results"
         WHERE test_id = $1::uuid) AS "resultCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_provider_credential_audits"
         WHERE request_id = $2) AS "credentialAuditCount",
       (SELECT count(*)::integer
          FROM "ql3"."security_audit_events"
         WHERE event_id = $1::uuid
           AND operation_id = $3) AS "planAuditCount",
       (SELECT plan_digest
          FROM "ql3_ai"."model_provider_credential_test_plans"
         WHERE test_id = $1::uuid) AS "planDigest",
       (SELECT outcome
          FROM "ql3_ai"."model_provider_credential_test_results"
         WHERE test_id = $1::uuid) AS outcome,
       (SELECT model_count
          FROM "ql3_ai"."model_provider_credential_test_results"
         WHERE test_id = $1::uuid) AS "modelCount",
       NOT EXISTS (
         SELECT 1
           FROM "ql3_ai"."model_provider_credential_test_plans"
          WHERE test_id = $1::uuid
            AND (plan_json::text LIKE '%ha-provider-token%'
              OR plan_json::text LIKE '%secretRef%')
       ) AND NOT EXISTS (
         SELECT 1
           FROM "ql3_ai"."model_provider_credential_test_executions"
          WHERE test_id = $1::uuid
            AND (execution_json::text LIKE '%ha-provider-token%'
              OR execution_json::text LIKE '%secretRef%')
       ) AND NOT EXISTS (
         SELECT 1
           FROM "ql3_ai"."model_provider_credential_test_results"
          WHERE test_id = $1::uuid
            AND (result_json::text LIKE '%ha-provider-token%'
              OR result_json::text LIKE '%secretRef%')
       ) AND NOT EXISTS (
         SELECT 1
           FROM "ql3_ai"."model_provider_credential_audits"
          WHERE request_id = $2
            AND (audit_json::text LIKE '%ha-provider-token%'
              OR audit_json::text LIKE '%secretRef%')
       ) AS "privateMaterialAbsent"`,
    [testId, executionId, MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function runModelProviderCredentialTestConnectionHaEvidence(options) {
  const { primaryPort, primaryPool, standbyPool, credentialCatalog } = options;
  const clock = await primaryPool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
            AS "observedAtMs"`,
  );
  const plannedAtMs = Number(clock.rows[0].observedAtMs);
  const testId = randomUUID();
  const executionId = randomUUID();
  const requestId = `ha-test-${randomBytes(8).toString('hex')}`;
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'ha-private-catalog-v1',
    providers: [
      {
        provider: credentialCatalog.provider,
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.ha.example.test/v1/',
        revision: 'ha-private-endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 8,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  const plan = createModelProviderCredentialTestPlan({
    testId,
    requestId,
    projectId: credentialCatalog.projectId,
    provider: credentialCatalog.provider,
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: credentialCatalog.actorId },
    fence: { projectVersion: 1, bindingVersion: 1 },
    plannedAtMs,
    expiresAtMs: plannedAtMs + 5 * 60_000,
  });
  const authorizedPlan = Object.freeze({
    plan,
    audit: Object.freeze({
      eventId: testId,
      requestId,
      operationId: MODEL_PROVIDER_CREDENTIAL_TEST_PLAN_OPERATION_ID,
      projectId: credentialCatalog.projectId,
      subject: Object.freeze({
        type: 'user',
        id: credentialCatalog.actorId,
      }),
      authenticationId: `ha-test-authentication-${testId}`,
      outcome: 'allowed',
      reasons: Object.freeze(['project_owner']),
      fence: Object.freeze({ projectVersion: 1, bindingVersion: 1 }),
      occurredAtMs: plannedAtMs,
    }),
  });
  const managerDatabase = await databaseOpener(
    'ai-credential-manager',
    databaseUrl(
      AI_CREDENTIAL_MANAGER_USER,
      AI_CREDENTIAL_MANAGER_PASSWORD,
      primaryPort,
    ),
    'ql3-ha-ai-credential-test-plan-manager',
  )();
  const testerPool = new RawPostgresPool({
    connectionString: databaseUrl(
      AI_CREDENTIAL_TESTER_USER,
      AI_CREDENTIAL_TESTER_PASSWORD,
      primaryPort,
    ),
    application_name: 'ql3-ha-ai-credential-tester',
    max: 1,
    connectionTimeoutMillis: 2_000,
  });
  testerPool.on('error', () => {
    // Completion-response-loss deliberately terminates the only backend.
  });
  const completionFault = {
    commitCount: 0,
    injected: false,
    commitCompletedBeforeFault: false,
    backendTerminationRequested: false,
    backendConnectionRejected: false,
  };
  let providerCalls = 0;
  let secretDisposals = 0;
  try {
    const planRepository =
      new PostgresModelProviderCredentialTestPlanRepository(
        managerDatabase.pool,
        { quotaWindowMs: 60_000, quotaLimit: 2 },
      );
    const createdPlan = await planRepository.createAuthorized(authorizedPlan);
    const replayedPlan = await planRepository.createAuthorized(authorizedPlan);
    assert.equal(createdPlan.status, 'created');
    assert.equal(replayedPlan.status, 'existing');
    assert.deepEqual(replayedPlan.plan, createdPlan.plan);
    const testerReadiness =
      await assertPostgresModelProviderCredentialTesterReady(testerPool);
    const credentials = new PostgresModelProviderCredentialReader(testerPool);
    const secretRef = createSecretRef({
      projectId: credentialCatalog.projectId,
      name: 'provider-token',
    });
    let monotonicMs = 0;
    const executor = createModelProviderCredentialTestExecutor({
      repository: new PostgresModelProviderCredentialTestExecutionRepository(
        nthCommitResponseLossPool(testerPool, completionFault, 2),
      ),
      credentials,
      secrets: {
        async resolveProjectSecretMaterial(request) {
          assert.equal(request.projectId, credentialCatalog.projectId);
          assert.equal(request.secretRef, secretRef);
          const bytes = Buffer.from('ha-provider-token', 'ascii');
          return Object.freeze({
            secretRef,
            bytes,
            dispose() {
              secretDisposals += 1;
              bytes.fill(0);
            },
          });
        },
      },
      now: Date.now,
      monotonicNow() {
        monotonicMs += 5;
        return monotonicMs;
      },
      async fetch(url, init) {
        providerCalls += 1;
        assert.equal(
          url.toString(),
          'https://provider.ha.example.test/v1/models',
        );
        assert.equal(init.method, 'GET');
        assert.equal(
          new Headers(init.headers).get('authorization'),
          'Bearer ha-provider-token',
        );
        return new Response(
          JSON.stringify({
            data: [{ id: 'ha-model-a' }, { id: 'ha-model-b' }],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const input = Object.freeze({ executionId, testId, allowlist });
    const completed = await executor.execute(input);
    const replayed = await executor.execute(input);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.outcome, 'reachable');
    assert.equal(completed.result.modelCount, 2);
    assert.equal(replayed.status, 'existing');
    assert.deepEqual(replayed.result, completed.result);
    assert.equal(providerCalls, 1);
    assert.equal(secretDisposals, 1);
    assert.deepEqual(completionFault, {
      commitCount: 4,
      injected: true,
      commitCompletedBeforeFault: true,
      backendTerminationRequested: true,
      backendConnectionRejected: true,
    });
    const beforePromotion = await modelProviderCredentialTestConnectionFacts(
      primaryPool,
      testId,
      executionId,
    );
    assert.deepEqual(beforePromotion, {
      planCount: 1,
      executionCount: 1,
      resultCount: 1,
      credentialAuditCount: 1,
      planAuditCount: 1,
      planDigest: plan.planDigest,
      outcome: 'reachable',
      modelCount: 2,
      privateMaterialAbsent: true,
    });
    await waitFor(async () => {
      try {
        const replicated = await modelProviderCredentialTestConnectionFacts(
          standbyPool,
          testId,
          executionId,
        );
        return JSON.stringify(replicated) === JSON.stringify(beforePromotion)
          ? replicated
          : null;
      } catch {
        return null;
      }
    }, 'model provider credential test connection WAL replay');
    return {
      testId,
      executionId,
      projectId: credentialCatalog.projectId,
      provider: credentialCatalog.provider,
      planDigest: plan.planDigest,
      endpointConfigDigest: plan.endpoint.configDigest,
      allowlistCatalogDigest: allowlist.catalogDigest,
      planExactReplay: true,
      executionExactReplay: true,
      providerCalls,
      secretDisposals,
      testerPoolMaxConnections: 1,
      testerReadiness,
      completionCommitResponseLoss: completionFault,
      beforePromotion,
      replicatedBeforePromotion: true,
      survivedPromotion: false,
    };
  } finally {
    await Promise.all([managerDatabase.close(), testerPool.end()]);
  }
}

async function verifyModelProviderCredentialTestConnectionAfterPromotion(
  options,
) {
  const { promotedPort, promotedPool, report } = options;
  const testerPool = new RawPostgresPool({
    connectionString: databaseUrl(
      AI_CREDENTIAL_TESTER_USER,
      AI_CREDENTIAL_TESTER_PASSWORD,
      promotedPort,
    ),
    application_name: 'ql3-ha-ai-credential-tester-promoted',
    max: 1,
    connectionTimeoutMillis: 2_000,
  });
  testerPool.on('error', () => {});
  try {
    const readiness = await assertPostgresModelProviderCredentialTesterReady(
      testerPool,
    );
    const afterPromotion = await modelProviderCredentialTestConnectionFacts(
      promotedPool,
      report.testId,
      report.executionId,
    );
    assert.deepEqual(afterPromotion, report.beforePromotion);
    report.afterPromotion = afterPromotion;
    report.promotedTesterReadiness = readiness;
    report.survivedPromotion = true;
  } finally {
    await testerPool.end();
  }
}

async function pluginPackagePromptFacts(pool, requestId) {
  const result = await pool.query(
    `SELECT
       admission.request_id AS "requestId",
       admission.invocation_id AS "invocationId",
       admission.plan_digest AS "planDigest",
       admission.receipt_digest AS "admissionReceiptDigest",
       admission.publication_digest AS "publicationDigest",
       admission.prompt_id AS "promptId",
       finalization.terminal_evidence_kind AS "terminalEvidenceKind",
       finalization.terminal_evidence_digest AS "terminalEvidenceDigest",
       finalization.receipt_digest AS "finalizationReceiptDigest",
       finalization.run_status AS "runStatus",
       finalization.final_run_version AS "finalRunVersion",
       finalization.final_run_event_sequence AS "finalRunEventSequence",
       run.status AS "durableRunStatus",
       run.version AS "durableRunVersion",
       run.event_sequence AS "durableRunEventSequence",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_invocation_starts" AS start
         WHERE start.invocation_id = admission.invocation_id) AS "startCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_invocation_completions" AS completion
         WHERE completion.invocation_id = admission.invocation_id)
         AS "completionCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_invocation_prompt_output_artifacts" AS artifact
         WHERE artifact.invocation_id = admission.invocation_id)
         AS "outputArtifactCount",
       (SELECT count(*)::integer
          FROM "ql3_ai"."model_invocation_prompt_output_artifact_tombstones"
            AS tombstone
         WHERE tombstone.invocation_id = admission.invocation_id)
         AS "outputTombstoneCount",
       COALESCE(
         (SELECT artifact.artifact_id
            FROM "ql3_ai"."model_invocation_prompt_output_artifacts" AS artifact
           WHERE artifact.invocation_id = admission.invocation_id),
         (SELECT tombstone.artifact_id
            FROM "ql3_ai"."model_invocation_prompt_output_artifact_tombstones"
              AS tombstone
           WHERE tombstone.invocation_id = admission.invocation_id)
       )
         AS "outputArtifactId",
       (SELECT step.output_ref
          FROM "ql3"."step_runs" AS step
         WHERE step.id = admission.step_run_id
           AND step.run_id = admission.run_id)
         AS "stepOutputRef",
       position(
         'private HA prompt value' IN
         admission.plan_json::text || admission.receipt_json::text ||
         finalization.receipt_json::text
       ) = 0 AS "privatePromptAbsent",
       position(
         'private HA provider output' IN
         admission.plan_json::text || admission.receipt_json::text ||
         finalization.receipt_json::text
       ) = 0 AS "privateOutputAbsent"
       ,COALESCE((SELECT position(
          'private HA provider output' IN artifact.artifact_json::text
        ) = 0
          FROM "ql3_ai"."model_invocation_prompt_output_artifacts" AS artifact
         WHERE artifact.invocation_id = admission.invocation_id), true)
         AS "artifactPlaintextAbsent"
       ,COALESCE((SELECT position(
          'private HA provider output' IN tombstone.tombstone_json::text
        ) = 0
          FROM "ql3_ai"."model_invocation_prompt_output_artifact_tombstones"
            AS tombstone
         WHERE tombstone.invocation_id = admission.invocation_id), true)
         AS "tombstonePlaintextAbsent"
      FROM "ql3_ai"."model_invocation_prompt_admissions" AS admission
      JOIN "ql3_ai"."model_invocation_prompt_finalizations" AS finalization
        USING (request_id)
      JOIN "ql3"."runs" AS run ON run.id = admission.run_id
     WHERE admission.request_id = $1`,
    [requestId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function pluginPackagePromptCatalogFacts(pool, projectId, packageName) {
  const catalog = await new PostgresPluginPackagePromptCatalogService(
    pool,
  ).inspect(projectId, packageName);
  const encoded = JSON.stringify(catalog);
  return {
    ...catalog,
    templateFieldAbsent: !encoded.includes('"template"'),
    privatePromptContentAbsent:
      !encoded.includes('Hello {{name}}') &&
      !encoded.includes('private HA prompt value'),
  };
}

async function pluginPackagePromptAuditFacts(pool, requestId) {
  const result = await pool.query(
    `SELECT count(*)::integer AS "allowedAuditCount",
            min(event_id::text) AS "auditEventId",
            COALESCE(bool_and(
              position('private HA prompt value' IN reasons::text) = 0 AND
              position('private HA provider output' IN reasons::text) = 0
            ), true) AS "privateContentAbsent"
       FROM "ql3"."security_audit_events"
      WHERE request_id = $1
        AND operation_id = 'prompt.execute'
        AND outcome = 'allowed'`,
    [requestId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

function pluginPackagePromptExecutionInspectionCommand(options) {
  const {
    target,
    eventId,
    requestId,
    packageName = target.packageName,
  } = options;
  const actor = Object.freeze({ type: 'api_app', id: 'ha-workflow-operator' });
  const fence = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
  return {
    projectId: target.projectId,
    packageName,
    promptId: target.promptId,
    executionRequestId: target.executionRequestId,
    actor,
    fence,
    audit: {
      eventId,
      requestId,
      operationId: 'prompt.execution.read',
      projectId: target.projectId,
      subject: actor,
      authenticationId: 'api_credential:ha-workflow-product:1',
      outcome: 'allowed',
      reasons: ['project_policy_allowed'],
      fence,
      occurredAtMs: 91_250,
    },
  };
}

function pluginPackagePromptExecutionOutputReader(options) {
  const { pool, keyId, key, nowMs } = options;
  return new PluginPackagePromptExecutionOutputReadService({
    references:
      new PostgresPluginPackagePromptExecutionOutputReferenceRepository(pool),
    outputs: new PluginPackagePromptOutputReadService({
      artifacts: new PostgresPluginPackagePromptOutputArtifactRepository(pool),
      authorizer: {
        async authorize() {
          return { effect: 'allow' };
        },
      },
      retention: new PostgresPluginPackagePromptOutputRetentionRepository(pool),
      keys: {
        async active() {
          return { keyId, key: Buffer.from(key) };
        },
        async resolve(observedKeyId) {
          return observedKeyId === keyId
            ? { keyId, key: Buffer.from(key) }
            : null;
        },
      },
      now: () => nowMs,
    }),
  });
}

function pluginPackagePromptExecutionOutputSummary(result) {
  return {
    status: result.status,
    artifactId:
      result.status === 'available' ? result.reference.artifactId : null,
    artifactDigest:
      result.status === 'available' ? result.reference.artifactDigest : null,
    outputMatched:
      result.status === 'available' &&
      result.result.text === 'private HA provider output',
    contentFree: !JSON.stringify({
      status: result.status,
      artifactId:
        result.status === 'available' ? result.reference.artifactId : null,
      artifactDigest:
        result.status === 'available' ? result.reference.artifactDigest : null,
    }).includes('private HA provider output'),
  };
}

async function pluginPackagePromptExecutionInspectionFacts(
  pool,
  target,
  auditEventIds,
  auditPool = pool,
) {
  async function read(packageName) {
    const page = await pool.query(
      `SELECT admission.invocation_id AS "invocationId",
              admission.run_id AS "runId",
              admission.step_run_id AS "stepRunId",
              admission.admitted_at_ms::text AS "admittedAtMs",
              run.status AS "runStatus",
              run.version::integer AS "runVersion",
              run.event_sequence::integer AS "eventSequence",
              run.started_at_ms::text AS "startedAtMs",
              run.finished_at_ms::text AS "finishedAtMs",
              step.status AS "stepStatus",
              step.version::integer AS "stepVersion",
              finalization.finalized_at_ms::text AS "finalizedAtMs"
         FROM "ql3_ai"."model_invocation_prompt_admissions" AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
          AND run.project_id = admission.project_id
         JOIN "ql3"."step_runs" AS step
           ON step.run_id = admission.run_id
          AND step.id = admission.step_run_id
         LEFT JOIN "ql3_ai"."model_invocation_prompt_finalizations"
           AS finalization
           ON finalization.request_id = admission.request_id
        WHERE admission.request_id = $1
          AND admission.project_id = $2
          AND admission.package_name = $3
          AND admission.prompt_id = $4
        LIMIT 2`,
      [
        target.executionRequestId,
        target.projectId,
        packageName,
        target.promptId,
      ],
    );
    assert.ok(page.rows.length <= 1);
    const row = page.rows[0];
    return normalizePluginPackagePromptExecutionInspectionResult({
      schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
      found: Boolean(row),
      projectId: target.projectId,
      packageName,
      promptId: target.promptId,
      executionRequestId: target.executionRequestId,
      execution: row
        ? {
            invocationId: row.invocationId,
            runId: row.runId,
            stepRunId: row.stepRunId,
            runStatus: row.runStatus,
            runVersion: row.runVersion,
            eventSequence: row.eventSequence,
            stepStatus: row.stepStatus,
            stepVersion: row.stepVersion,
            admittedAtMs: Number(row.admittedAtMs),
            startedAtMs: Number(row.startedAtMs),
            finishedAtMs:
              row.finishedAtMs === null ? null : Number(row.finishedAtMs),
            finalizedAtMs:
              row.finalizedAtMs === null ? null : Number(row.finalizedAtMs),
          }
        : null,
    });
  }

  const exact = await read(target.packageName);
  const masked = await read(target.maskedPackageName);
  const audits = await auditPool.query(
    `SELECT event_id::text AS "eventId",
            operation_id AS "operationId",
            outcome,
            reasons::text AS reasons
       FROM "ql3"."security_audit_events"
      WHERE event_id = ANY($1::uuid[])
      ORDER BY event_id`,
    [auditEventIds],
  );
  const encoded = JSON.stringify({ exact, masked, audits: audits.rows });
  return {
    exact,
    masked,
    auditEventIds: audits.rows.map(({ eventId }) => eventId),
    allowedAuditCount: audits.rows.filter(
      ({ operationId, outcome }) =>
        operationId === 'prompt.execution.read' && outcome === 'allowed',
    ).length,
    contentFree:
      !encoded.includes('private HA prompt value') &&
      !encoded.includes('private HA provider output') &&
      !encoded.includes('planDigest') &&
      !encoded.includes('receiptDigest') &&
      !encoded.includes('artifactId'),
  };
}

async function pluginPackagePromptOutputKeyRetirementFacts(pool, keyId) {
  const result = await pool.query(
    `SELECT preparation.key_id AS "keyId",
            preparation.retirement_id AS "retirementId",
            preparation.request_id AS "requestId",
            preparation.mutation_id AS "mutationId",
            preparation.preparation_digest AS "preparationDigest",
            completion.retired_catalog_digest AS "retiredCatalogDigest",
            completion.absence_proof AS "absenceProof",
            completion.completion_digest AS "completionDigest",
            position('private HA provider output' IN
              preparation.preparation_json::text ||
              completion.completion_json::text) = 0 AS "privateOutputAbsent"
       FROM "ql3_ai"."model_invocation_prompt_output_key_retirement_preparations"
         AS preparation
       JOIN "ql3_ai"."model_invocation_prompt_output_key_retirement_completions"
         AS completion USING (key_id, retirement_id, request_id, mutation_id)
      WHERE preparation.key_id = $1`,
    [keyId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

function pluginPackagePromptOutputKeyRotationForbiddenValues() {
  return [
    'private HA provider output',
    Buffer.alloc(32, 13).toString('base64url'),
    Buffer.alloc(32, 13).toString('hex'),
    Buffer.alloc(32, 29).toString('base64url'),
    Buffer.alloc(32, 29).toString('hex'),
  ];
}

async function pluginPackagePromptOutputKeyRotationFacts(
  pool,
  rotationId,
  forbiddenValues,
) {
  const result = await pool.query(
    `SELECT preparation.rotation_id AS "rotationId",
            preparation.request_id AS "requestId",
            preparation.mutation_id AS "mutationId",
            preparation.expected_secret_uid AS "expectedSecretUid",
            preparation.expected_active_key_id AS "expectedActiveKeyId",
            preparation.expected_catalog_digest AS "expectedCatalogDigest",
            preparation.new_key_id AS "newKeyId",
            preparation.material_proof AS "materialProof",
            preparation.preparation_digest AS "preparationDigest",
            completion.generation::text AS generation,
            completion.catalog_digest AS "catalogDigest",
            completion.completion_digest AS "completionDigest",
            preparation.preparation_json::text AS "preparationJson",
            completion.completion_json::text AS "completionJson"
       FROM "ql3_ai"."model_invocation_prompt_output_key_rotation_preparations"
         AS preparation
       JOIN "ql3_ai"."model_invocation_prompt_output_key_rotation_completions"
         AS completion USING (rotation_id, request_id, mutation_id)
      WHERE preparation.rotation_id = $1`,
    [rotationId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  const durableJson = `${row.preparationJson}${row.completionJson}`;
  for (const forbidden of forbiddenValues) {
    assert.equal(durableJson.includes(forbidden), false);
  }
  delete row.preparationJson;
  delete row.completionJson;
  return { ...row, contentFree: true };
}

async function runPluginPackagePromptHaEvidence(options) {
  const { runtimePool, maintenancePool, auditPool, standbyPool, publication } =
    options;
  const requestId = 'ha-plugin-package-prompt-request-001';
  const auditEventId = randomUUID();
  const modelRepository = new PostgresModelInvocationRepository(runtimePool);
  const modelCoordinator = new DurableModelInvocationCoordinator(
    modelRepository,
  );
  let activeOutputKeyId = 'ha-prompt-output-key-1';
  const outputKeyMaterials = new Map([
    [activeOutputKeyId, Buffer.alloc(32, 13)],
  ]);
  const durableOutput = new PluginPackagePromptOutputCompletionCoordinator({
    coordinator: modelCoordinator,
    keys: {
      async active() {
        const key = outputKeyMaterials.get(activeOutputKeyId);
        assert.ok(key);
        return {
          keyId: activeOutputKeyId,
          key: Buffer.from(key),
        };
      },
      async resolve(keyId) {
        const key = outputKeyMaterials.get(keyId);
        return key ? { keyId, key: Buffer.from(key) } : null;
      },
    },
    now: () => 91_001,
    nonceFactory: () => Buffer.alloc(12, 17),
  });
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'ha/model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'openai-compatible',
            model: 'ha/model-a',
            text: 'private HA provider output',
            finishReason: 'stop',
            usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 },
          };
        },
        async *stream() {
          throw new Error('HA Package Prompt evidence does not stream');
        },
      },
    ],
    policies: {
      async resolve() {
        return {
          revision: 'ha-prompt-policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['ha/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 256,
          maxTotalTokens: 512,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: {
      async resolve() {
        throw new Error('HA Package Prompt pricing must remain unreachable');
      },
    },
    audit: modelCoordinator,
    successfulCompletion: durableOutput,
    maxConcurrent: 1,
    now: () => 91_000,
  });
  const executor = new PostgresPluginPackagePromptExecutionService(
    runtimePool,
    (guard) =>
      new PluginPackagePromptExecutor({
        admissions: new PostgresPluginPackagePromptAdmissionRepository(
          runtimePool,
          guard,
        ),
        invocations: modelRepository,
        gateway,
        durableOutput,
      }),
  );
  const input = {
    projectId: publication.target.projectId,
    packageName: publication.target.packageName,
    promptId: 'ha-greeting',
    requestId,
    traceId: 'ha-plugin-package-prompt-trace-001',
    auditEventId,
    principal: {
      subject: { type: 'user', id: 'ha-prompt-operator' },
      authenticationId: 'api_credential:ha-prompt-product:1',
      authenticatedAtMs: 1,
      expiresAtMs: 4102444800000,
      assurance: 'single_factor',
    },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { name: 'private HA prompt value' },
    provider: 'openai-compatible',
    model: 'ha/model-a',
    maxOutputTokens: 256,
    temperature: 0,
    plannedAtMs: 90_000,
    deadlineAtMs: 120_000,
    output: {
      mode: 'durable_artifact',
      retentionPolicy: {
        revision: 'ha-prompt-output-v1',
        retentionMs: 86_400_000,
      },
    },
  };
  const executed = await executor.execute(input);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.result.text, 'private HA provider output');
  assert.equal(executed.finalization.runStatus, 'succeeded');
  assert.equal(executed.outputArtifact.artifactId.startsWith('pao:'), true);
  const replay = await executor.execute(input);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.deepEqual(replay.admission, executed.admission);
  assert.deepEqual(replay.finalization, executed.finalization);
  assert.deepEqual(replay.outputArtifact, executed.outputArtifact);
  assert.equal(providerCalls, 1);
  const executionInspectionTarget = Object.freeze({
    projectId: publication.target.projectId,
    packageName: publication.target.packageName,
    maskedPackageName: 'ha-masked-package',
    promptId: input.promptId,
    executionRequestId: requestId,
  });
  const inspectionAuditEventIds = [randomUUID(), randomUUID()].sort();
  const executionInspectionRepository =
    new PostgresPluginPackagePromptExecutionInspectionRepository(runtimePool);
  const inspectedExecution =
    await executionInspectionRepository.inspectAuthorized(
      pluginPackagePromptExecutionInspectionCommand({
        target: executionInspectionTarget,
        eventId: inspectionAuditEventIds[0],
        requestId: 'ha-prompt-execution-inspection-primary',
      }),
    );
  const maskedExecution = await executionInspectionRepository.inspectAuthorized(
    pluginPackagePromptExecutionInspectionCommand({
      target: executionInspectionTarget,
      eventId: inspectionAuditEventIds[1],
      requestId: 'ha-prompt-execution-inspection-primary-masked',
      packageName: executionInspectionTarget.maskedPackageName,
    }),
  );
  assert.equal(inspectedExecution.found, true);
  assert.equal(inspectedExecution.execution.runId, executed.admission.runId);
  assert.equal(inspectedExecution.execution.runStatus, 'succeeded');
  assert.equal(maskedExecution.found, false);
  assert.equal(maskedExecution.execution, null);
  const executionInspectionBeforePromotion =
    await pluginPackagePromptExecutionInspectionFacts(
      runtimePool,
      executionInspectionTarget,
      inspectionAuditEventIds,
      auditPool,
    );
  assert.deepEqual(
    executionInspectionBeforePromotion.exact,
    inspectedExecution,
  );
  assert.deepEqual(executionInspectionBeforePromotion.masked, maskedExecution);
  assert.equal(executionInspectionBeforePromotion.allowedAuditCount, 2);
  assert.equal(executionInspectionBeforePromotion.contentFree, true);
  const outputArtifactRepository =
    new PostgresPluginPackagePromptOutputArtifactRepository(runtimePool);
  const sealedOutputArtifact = await outputArtifactRepository.find(
    executed.outputArtifact.artifactId,
  );
  assert.ok(sealedOutputArtifact);
  const keyId = executed.outputArtifact.keyId;
  const nextKeyId = 'ha-prompt-output-key-2';
  const oldMaterial = Buffer.alloc(32, 13);
  const stagedMaterial = Buffer.alloc(32, 29);
  const rotationForbiddenValues =
    pluginPackagePromptOutputKeyRotationForbiddenValues();
  let keyringManifest = Object.freeze({
    schema: 'qinglong/plugin-package-prompt-output-file-keyring@v1',
    generation: 1,
    activeKeyId: keyId,
    keys: Object.freeze({
      [keyId]: oldMaterial.toString('base64url'),
    }),
    retirements: Object.freeze({}),
  });
  const sourceCatalogDigest =
    pluginPackagePromptOutputKeyringCatalogDigest(keyringManifest);
  const keyRotationRepository =
    new PostgresPluginPackagePromptOutputKeyRotationRepository({
      pool: maintenancePool,
      now: () => 91_500,
    });
  let keyRotationMaterialCalls = 0;
  let keyRotationSecretWrites = 0;
  let loseFirstRotationResponse = true;
  const keyRotation = new PluginPackagePromptOutputKeyRotationCoordinator({
    repository: keyRotationRepository,
    materials: {
      async rotate(command) {
        keyRotationMaterialCalls += 1;
        const mutation = rotatePluginPackagePromptOutputKeyringManifest(
          keyringManifest,
          command,
        );
        if (mutation.changed) {
          keyringManifest = mutation.manifest;
          keyRotationSecretWrites += 1;
        }
        if (loseFirstRotationResponse) {
          loseFirstRotationResponse = false;
          throw new PluginPackagePromptOutputKeyRotationUnavailableError();
        }
        return mutation.state;
      },
    },
  });
  const keyRotationRequest = {
    rotationId: 'ha-prompt-output-key-rotation-001',
    requestId: 'ha-prompt-output-key-rotation-request-001',
    mutationId: 'ha-prompt-output-key-rotation-mutation-001',
    expectedSecretUid: 'ha-prompt-output-keyring-uid-001',
    expectedActiveKeyId: keyId,
    expectedCatalogDigest: sourceCatalogDigest,
    newKeyId: nextKeyId,
  };
  await assert.rejects(
    keyRotation.rotate({
      request: keyRotationRequest,
      material: stagedMaterial,
    }),
    (error) =>
      error?.code === 'PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_UNAVAILABLE',
  );
  const rotated = await keyRotation.rotate({
    request: keyRotationRequest,
    material: stagedMaterial,
  });
  assert.equal(rotated.status, 'completed');
  assert.equal(rotated.completion.generation, 2);
  assert.equal(rotated.completion.previousActiveKeyId, keyId);
  assert.equal(rotated.completion.activeKeyId, nextKeyId);
  const rotationReplay = await keyRotation.rotate({
    request: keyRotationRequest,
    material: stagedMaterial,
  });
  assert.equal(rotationReplay.status, 'existing');
  assert.deepEqual(rotationReplay.preparation, rotated.preparation);
  assert.deepEqual(rotationReplay.completion, rotated.completion);
  assert.equal(keyRotationMaterialCalls, 2);
  assert.equal(keyRotationSecretWrites, 1);
  assert.equal(
    inspectPluginPackagePromptOutputKeyringManifest(keyringManifest, keyId)
      .state,
    'inactive',
  );
  assert.equal(
    inspectPluginPackagePromptOutputKeyringManifest(keyringManifest, nextKeyId)
      .state,
    'active',
  );
  assert.deepEqual(
    openPluginPackagePromptOutputArtifact(sealedOutputArtifact, oldMaterial),
    executed.result,
  );
  const keyRotationBeforePromotion =
    await pluginPackagePromptOutputKeyRotationFacts(
      maintenancePool,
      keyRotationRequest.rotationId,
      rotationForbiddenValues,
    );
  const beforeGc = await pluginPackagePromptFacts(runtimePool, requestId);
  assert.equal(beforeGc.outputArtifactCount, 1);
  assert.equal(beforeGc.outputTombstoneCount, 0);
  assert.equal(beforeGc.outputArtifactId, beforeGc.stepOutputRef);
  const maintenanceReadiness =
    await assertPostgresPluginPackagePromptOutputMaintenanceReady(
      maintenancePool,
    );
  const garbageCollector =
    new PostgresPluginPackagePromptOutputGarbageCollector({
      pool: maintenancePool,
      policies: createPluginPackagePromptOutputRetentionPolicyCatalogResolver({
        schemaVersion: 1,
        policies: [
          {
            projectId: publication.target.projectId,
            policy: input.output.retentionPolicy,
            policyDigest:
              pluginPackagePromptOutputArtifactRetentionPolicyDigest(
                input.output.retentionPolicy,
              ),
          },
        ],
      }),
      limit: 1,
    });
  assert.deepEqual(await garbageCollector.collect(), {
    scanned: 1,
    tombstoned: 1,
    skipped: 0,
    hasMore: false,
  });
  const replayAfterGc = await executor.execute(input);
  assert.equal(replayAfterGc.status, 'existing');
  assert.equal(replayAfterGc.result, null);
  assert.deepEqual(replayAfterGc.outputArtifact, executed.outputArtifact);
  assert.equal(providerCalls, 1);
  activeOutputKeyId = nextKeyId;
  outputKeyMaterials.set(nextKeyId, Buffer.from(stagedMaterial));
  const outputRecoveryRequestId =
    'ha-plugin-package-prompt-output-recovery-request-001';
  const outputRecoveryInput = {
    ...input,
    requestId: outputRecoveryRequestId,
    traceId: 'ha-plugin-package-prompt-output-recovery-trace-001',
    auditEventId: randomUUID(),
    plannedAtMs: 90_500,
  };
  const outputRecoveryExecution = await executor.execute(outputRecoveryInput);
  assert.equal(outputRecoveryExecution.status, 'executed');
  assert.equal(outputRecoveryExecution.outputArtifact.keyId, activeOutputKeyId);
  const outputRecoveryReplay = await executor.execute(outputRecoveryInput);
  assert.equal(outputRecoveryReplay.status, 'existing');
  assert.equal(outputRecoveryReplay.result, null);
  assert.deepEqual(
    outputRecoveryReplay.outputArtifact,
    outputRecoveryExecution.outputArtifact,
  );
  assert.equal(providerCalls, 2);
  const outputRecoveryTarget = Object.freeze({
    projectId: publication.target.projectId,
    packageName: publication.target.packageName,
    maskedPackageName: 'ha-masked-package',
    promptId: outputRecoveryInput.promptId,
    executionRequestId: outputRecoveryRequestId,
  });
  const outputRecoveryReader = pluginPackagePromptExecutionOutputReader({
    pool: runtimePool,
    keyId: nextKeyId,
    key: stagedMaterial,
    nowMs: 92_000,
  });
  const outputRecoveryBeforePromotion = await outputRecoveryReader.read({
    principal: input.principal,
    projectId: outputRecoveryTarget.projectId,
    packageName: outputRecoveryTarget.packageName,
    promptId: outputRecoveryTarget.promptId,
    executionRequestId: outputRecoveryTarget.executionRequestId,
  });
  const outputRecoveryMaskedBeforePromotion = await outputRecoveryReader.read({
    principal: input.principal,
    projectId: outputRecoveryTarget.projectId,
    packageName: outputRecoveryTarget.maskedPackageName,
    promptId: outputRecoveryTarget.promptId,
    executionRequestId: outputRecoveryTarget.executionRequestId,
  });
  assert.equal(outputRecoveryBeforePromotion.status, 'available');
  assert.equal(
    outputRecoveryBeforePromotion.result.text,
    'private HA provider output',
  );
  assert.equal(outputRecoveryMaskedBeforePromotion.status, 'not_found');
  const outputRecoveryBeforePromotionSummary =
    pluginPackagePromptExecutionOutputSummary(outputRecoveryBeforePromotion);
  const keyRetirementRepository =
    new PostgresPluginPackagePromptOutputKeyRetirementRepository({
      pool: maintenancePool,
      now: () => 92_000,
    });
  const keyRetirement = new PluginPackagePromptOutputKeyRetirementCoordinator({
    repository: keyRetirementRepository,
    materials: {
      async inspect(observedKeyId) {
        assert.equal(observedKeyId, keyId);
        return inspectPluginPackagePromptOutputKeyringManifest(
          keyringManifest,
          observedKeyId,
        );
      },
      async retire(command) {
        assert.equal(command.preparation.keyId, keyId);
        const durable = await keyRetirementRepository.find(keyId);
        assert.ok(durable);
        assert.equal(
          command.preparation.preparationDigest,
          durable.preparation.preparationDigest,
        );
        const mutation = retirePluginPackagePromptOutputKeyringManifest(
          keyringManifest,
          command.preparation,
        );
        keyringManifest = mutation.manifest;
        return mutation.state;
      },
    },
  });
  const keyRetirementCommand = {
    keyId,
    retirementId: 'ha-prompt-output-key-retirement-001',
    requestId: 'ha-prompt-output-key-retirement-request-001',
    mutationId: 'ha-prompt-output-key-retirement-mutation-001',
  };
  const retired = await keyRetirement.retire(keyRetirementCommand);
  assert.equal(retired.status, 'completed');
  const retirementReplay = await keyRetirement.retire(keyRetirementCommand);
  assert.equal(retirementReplay.status, 'existing');
  assert.deepEqual(retirementReplay.preparation, retired.preparation);
  assert.deepEqual(retirementReplay.completion, retired.completion);
  assert.equal(
    inspectPluginPackagePromptOutputKeyringManifest(keyringManifest, keyId)
      .state,
    'absent',
  );
  assert.equal(
    inspectPluginPackagePromptOutputKeyringManifest(keyringManifest, nextKeyId)
      .state,
    'active',
  );
  outputKeyMaterials.get(keyId)?.fill(0);
  outputKeyMaterials.delete(keyId);
  await assert.rejects(
    outputArtifactRepository.put(sealedOutputArtifact),
    (error) => error?.code === 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_CONFLICT',
  );
  const keyRetirementBeforePromotion =
    await pluginPackagePromptOutputKeyRetirementFacts(maintenancePool, keyId);
  assert.equal(keyRetirementBeforePromotion.privateOutputAbsent, true);
  await runtimePool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', 'ha-prompt-operator', 2, 'revoked', NULL,
               'ha-prompt-operator-v2', 'system', 'ha-contract', 2)`,
    [publication.target.projectId],
  );
  await assert.rejects(
    executor.execute({
      ...input,
      requestId: `${requestId}-revoked`,
      auditEventId: randomUUID(),
    }),
    (error) => error?.code === 'PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED',
  );
  await assert.rejects(
    executor.execute(input),
    (error) => error?.code === 'PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED',
  );
  assert.equal(providerCalls, 2);
  assert.deepEqual(
    await pluginPackagePromptAuditFacts(auditPool, `${requestId}-revoked`),
    {
      allowedAuditCount: 0,
      auditEventId: null,
      privateContentAbsent: true,
    },
  );
  const promptAudit = await pluginPackagePromptAuditFacts(auditPool, requestId);
  assert.deepEqual(promptAudit, {
    allowedAuditCount: 1,
    auditEventId,
    privateContentAbsent: true,
  });
  const beforePromotion = {
    ...(await pluginPackagePromptFacts(runtimePool, requestId)),
    catalog: await pluginPackagePromptCatalogFacts(
      runtimePool,
      publication.target.projectId,
      publication.target.packageName,
    ),
    audit: promptAudit,
    keyRotation: keyRotationBeforePromotion,
    keyRetirement: keyRetirementBeforePromotion,
  };
  assert.deepEqual(
    {
      runStatus: beforePromotion.runStatus,
      finalRunVersion: beforePromotion.finalRunVersion,
      finalRunEventSequence: beforePromotion.finalRunEventSequence,
      durableRunStatus: beforePromotion.durableRunStatus,
      durableRunVersion: beforePromotion.durableRunVersion,
      durableRunEventSequence: beforePromotion.durableRunEventSequence,
      startCount: beforePromotion.startCount,
      completionCount: beforePromotion.completionCount,
      outputArtifactCount: beforePromotion.outputArtifactCount,
      outputTombstoneCount: beforePromotion.outputTombstoneCount,
      outputReferenceBound:
        beforePromotion.outputArtifactId === beforePromotion.stepOutputRef,
      privatePromptAbsent: beforePromotion.privatePromptAbsent,
      privateOutputAbsent: beforePromotion.privateOutputAbsent,
      artifactPlaintextAbsent: beforePromotion.artifactPlaintextAbsent,
      tombstonePlaintextAbsent: beforePromotion.tombstonePlaintextAbsent,
      catalogFound: beforePromotion.catalog.found,
      catalogState: beforePromotion.catalog.publicationState,
      catalogPromptIds: beforePromotion.catalog.prompts.map(({ id }) => id),
      catalogTemplateFieldAbsent: beforePromotion.catalog.templateFieldAbsent,
      catalogPrivatePromptContentAbsent:
        beforePromotion.catalog.privatePromptContentAbsent,
    },
    {
      runStatus: 'succeeded',
      finalRunVersion: 5,
      finalRunEventSequence: 5,
      durableRunStatus: 'succeeded',
      durableRunVersion: 5,
      durableRunEventSequence: 5,
      startCount: 1,
      completionCount: 1,
      outputArtifactCount: 0,
      outputTombstoneCount: 1,
      outputReferenceBound: true,
      privatePromptAbsent: true,
      privateOutputAbsent: true,
      artifactPlaintextAbsent: true,
      tombstonePlaintextAbsent: true,
      catalogFound: true,
      catalogState: 'active',
      catalogPromptIds: ['ha-greeting'],
      catalogTemplateFieldAbsent: true,
      catalogPrivatePromptContentAbsent: true,
    },
  );
  await waitFor(async () => {
    try {
      const replicated = {
        ...(await pluginPackagePromptFacts(standbyPool, requestId)),
        catalog: await pluginPackagePromptCatalogFacts(
          standbyPool,
          publication.target.projectId,
          publication.target.packageName,
        ),
        audit: await pluginPackagePromptAuditFacts(standbyPool, requestId),
        keyRotation: await pluginPackagePromptOutputKeyRotationFacts(
          standbyPool,
          keyRotationRequest.rotationId,
          rotationForbiddenValues,
        ),
        keyRetirement: await pluginPackagePromptOutputKeyRetirementFacts(
          standbyPool,
          keyId,
        ),
      };
      return JSON.stringify(replicated) === JSON.stringify(beforePromotion)
        ? replicated
        : null;
    } catch {
      return null;
    }
  }, 'Package Prompt admission/finalization WAL replay');
  const executionInspectionReplicatedBeforePromotion = await waitFor(
    async () => {
      try {
        const replicated = await pluginPackagePromptExecutionInspectionFacts(
          standbyPool,
          executionInspectionTarget,
          inspectionAuditEventIds,
        );
        return JSON.stringify(replicated) ===
          JSON.stringify(executionInspectionBeforePromotion)
          ? replicated
          : null;
      } catch {
        return null;
      }
    },
    'Package Prompt execution inspection WAL replay',
  );
  const outputRecoveryReplicatedBeforePromotion = await waitFor(async () => {
    try {
      const reader = pluginPackagePromptExecutionOutputReader({
        pool: standbyPool,
        keyId: nextKeyId,
        key: stagedMaterial,
        nowMs: 92_500,
      });
      const exact = await reader.read({
        principal: input.principal,
        projectId: outputRecoveryTarget.projectId,
        packageName: outputRecoveryTarget.packageName,
        promptId: outputRecoveryTarget.promptId,
        executionRequestId: outputRecoveryTarget.executionRequestId,
      });
      const masked = await reader.read({
        principal: input.principal,
        projectId: outputRecoveryTarget.projectId,
        packageName: outputRecoveryTarget.maskedPackageName,
        promptId: outputRecoveryTarget.promptId,
        executionRequestId: outputRecoveryTarget.executionRequestId,
      });
      const summary = pluginPackagePromptExecutionOutputSummary(exact);
      return JSON.stringify(summary) ===
        JSON.stringify(outputRecoveryBeforePromotionSummary) &&
        masked.status === 'not_found'
        ? summary
        : null;
    } catch {
      return null;
    }
  }, 'Package Prompt execution output recovery WAL replay');
  return {
    requestId,
    beforePromotion,
    executionInspection: {
      target: executionInspectionTarget,
      primaryAuditEventIds: inspectionAuditEventIds,
      promotedAuditEventIds: [],
      beforePromotion: executionInspectionBeforePromotion,
      replicatedBeforePromotion:
        JSON.stringify(executionInspectionReplicatedBeforePromotion) ===
        JSON.stringify(executionInspectionBeforePromotion),
      afterPromotion: null,
      survivedPromotion: false,
    },
    outputRecovery: {
      target: outputRecoveryTarget,
      beforePromotion: outputRecoveryBeforePromotionSummary,
      replicatedBeforePromotion:
        JSON.stringify(outputRecoveryReplicatedBeforePromotion) ===
        JSON.stringify(outputRecoveryBeforePromotionSummary),
      afterPromotion: null,
      survivedPromotion: false,
      exactReplay: true,
      crossTargetHidden: true,
    },
    providerCalls,
    exactReplay: true,
    exactReplayAfterGc: true,
    keyRetirementCompleted: true,
    keyRetirementExactReplay: true,
    keyRetirementFenceRejectedLateArtifact: true,
    keyRotationCompleted: true,
    keyRotationExactReplay: true,
    keyRotationMaterialResponseLossConverged: true,
    keyRotationMaterialCalls,
    keyRotationSecretWrites,
    historicalArtifactDecryptAfterRotation: true,
    outputArtifactCommittedAtomicallyBeforeGc:
      beforeGc.outputArtifactCount === 1 &&
      beforeGc.outputArtifactId === beforeGc.stepOutputRef,
    maintenanceReadiness,
    garbageCollected: true,
    policyFenceRejectedAfterRevocation: true,
    replicatedBeforePromotion: true,
    survivedPromotion: false,
  };
}

async function verifyPluginPackagePromptExecutionInspectionAfterPromotion(
  options,
) {
  const { promotedPort, promotedPool, evidence } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-prompt-execution-inspection-promoted',
  )();
  const promotedAuditEventIds = [randomUUID(), randomUUID()].sort();
  try {
    const repository =
      new PostgresPluginPackagePromptExecutionInspectionRepository(
        runtimeDatabase.pool,
      );
    const exact = await repository.inspectAuthorized(
      pluginPackagePromptExecutionInspectionCommand({
        target: evidence.target,
        eventId: promotedAuditEventIds[0],
        requestId: 'ha-prompt-execution-inspection-promoted',
      }),
    );
    const masked = await repository.inspectAuthorized(
      pluginPackagePromptExecutionInspectionCommand({
        target: evidence.target,
        eventId: promotedAuditEventIds[1],
        requestId: 'ha-prompt-execution-inspection-promoted-masked',
        packageName: evidence.target.maskedPackageName,
      }),
    );
    assert.deepEqual(exact, evidence.beforePromotion.exact);
    assert.deepEqual(masked, evidence.beforePromotion.masked);
    const afterPromotion = await pluginPackagePromptExecutionInspectionFacts(
      promotedPool,
      evidence.target,
      [...evidence.primaryAuditEventIds, ...promotedAuditEventIds].sort(),
    );
    assert.deepEqual(afterPromotion.exact, evidence.beforePromotion.exact);
    assert.deepEqual(afterPromotion.masked, evidence.beforePromotion.masked);
    assert.equal(afterPromotion.allowedAuditCount, 4);
    assert.equal(afterPromotion.contentFree, true);
    evidence.promotedAuditEventIds = promotedAuditEventIds;
    evidence.afterPromotion = afterPromotion;
    evidence.survivedPromotion = true;
  } finally {
    await runtimeDatabase.close();
  }
}

async function verifyPluginPackagePromptExecutionOutputAfterPromotion(options) {
  const { promotedPort, evidence } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-prompt-execution-output-promoted',
  )();
  try {
    const reader = pluginPackagePromptExecutionOutputReader({
      pool: runtimeDatabase.pool,
      keyId: 'ha-prompt-output-key-2',
      key: Buffer.alloc(32, 29),
      nowMs: 93_000,
    });
    const principal = {
      subject: { type: 'user', id: 'ha-prompt-operator' },
      authenticationId: 'api_credential:ha-prompt-product:1',
      authenticatedAtMs: 1,
      expiresAtMs: 4102444800000,
      assurance: 'single_factor',
    };
    const exact = await reader.read({
      principal,
      projectId: evidence.target.projectId,
      packageName: evidence.target.packageName,
      promptId: evidence.target.promptId,
      executionRequestId: evidence.target.executionRequestId,
    });
    const masked = await reader.read({
      principal,
      projectId: evidence.target.projectId,
      packageName: evidence.target.maskedPackageName,
      promptId: evidence.target.promptId,
      executionRequestId: evidence.target.executionRequestId,
    });
    assert.equal(exact.status, 'available');
    assert.equal(exact.result.text, 'private HA provider output');
    assert.equal(masked.status, 'not_found');
    const summary = pluginPackagePromptExecutionOutputSummary(exact);
    assert.deepEqual(summary, evidence.beforePromotion);
    evidence.afterPromotion = summary;
    evidence.survivedPromotion = true;
  } finally {
    await runtimeDatabase.close();
  }
}

async function provisionRuntimeRole(database) {
  await database.pool.query(
    `CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`,
  );
}

async function provisionCredentialRoles(database) {
  await database.pool.query(
    `CREATE ROLE ${AI_MAINTENANCE_USER} LOGIN PASSWORD '${AI_MAINTENANCE_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${AI_CREDENTIAL_MANAGER_USER} LOGIN PASSWORD '${AI_CREDENTIAL_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${AI_CREDENTIAL_TESTER_USER} LOGIN PASSWORD '${AI_CREDENTIAL_TESTER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${ADMIN_USER} LOGIN PASSWORD '${ADMIN_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${AUTOMATION_MANAGER_USER} LOGIN PASSWORD '${AUTOMATION_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${APPROVAL_MANAGER_USER} LOGIN PASSWORD '${APPROVAL_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${RUN_MANAGER_USER} LOGIN PASSWORD '${RUN_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${PACKAGE_MANAGER_USER} LOGIN PASSWORD '${PACKAGE_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${PACKAGE_EXECUTOR_USER} LOGIN PASSWORD '${PACKAGE_EXECUTOR_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${WORKER_CREDENTIAL_MANAGER_USER} LOGIN PASSWORD '${WORKER_CREDENTIAL_MANAGER_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${WORKER_CREDENTIAL_EXECUTOR_USER} LOGIN PASSWORD '${WORKER_CREDENTIAL_EXECUTOR_PASSWORD}'`,
  );
  await database.pool.query(
    `CREATE ROLE ${WORKER_INGRESS_USER} LOGIN PASSWORD '${WORKER_INGRESS_PASSWORD}'`,
  );
}

function credentialCommitFaultPool(
  user,
  password,
  port,
  applicationName,
  evidence,
) {
  const pool = new RawPostgresPool({
    connectionString: databaseUrl(user, password, port),
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 2_000,
  });
  pool.on('error', () => {
    // The fixture deliberately terminates its only transaction backend.
  });
  return {
    pool,
    repositoryPool: postCommitResponseLossPool(pool, evidence),
  };
}

function credentialCommitFaultEvidence() {
  return {
    injected: false,
    commitCompletedBeforeFault: false,
    backendTerminationRequested: false,
    backendConnectionRejected: false,
  };
}

function createCredentialDeliveryAdapter() {
  let staged = null;
  let token = null;
  let stages = 0;
  let publishes = 0;
  let discards = 0;
  const publicationDigest = 'e'.repeat(64);
  return {
    async inspect(deliveryId) {
      return staged?.deliveryId === deliveryId ? staged : null;
    },
    async stage(delivery, value) {
      assert.equal(staged, null, 'credential staging must not replace a fact');
      assert.ok(Buffer.isBuffer(value));
      staged = Object.freeze({ ...delivery });
      token = Buffer.from(value);
      stages += 1;
    },
    async publish(delivery) {
      assert.ok(staged, 'credential publication requires a staged secret');
      assert.equal(delivery.deliveryId, staged.deliveryId);
      assert.ok(token);
      assert.ok(
        token.toString('utf8').startsWith('ql3w_'),
        'staged value must be a formatted Worker credential token',
      );
      publishes += 1;
      return { publicationDigest };
    },
    async discard(delivery) {
      assert.equal(delivery.deliveryId, staged?.deliveryId);
      token?.fill(0);
      token = null;
      staged = null;
      discards += 1;
    },
    facts() {
      return {
        stages,
        publishes,
        discards,
        publicationDigest,
        stagedSecretRetained: token !== null,
      };
    },
    dispose() {
      token?.fill(0);
      token = null;
      staged = null;
    },
  };
}

async function credentialDeliveryFacts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       (SELECT array_agg(version ORDER BY version)
          FROM "ql3"."worker_credential_deliveries"
         WHERE delivery_id = $1) AS "deliveryVersions",
       (SELECT array_agg(state ORDER BY version)
          FROM "ql3"."worker_credential_deliveries"
         WHERE delivery_id = $1) AS "deliveryStates",
       (SELECT array_agg(state ORDER BY version)
          FROM "ql3"."worker_credentials"
         WHERE credential_id = $2) AS "previousCredentialStates",
       (SELECT count(*)::integer
          FROM "ql3"."worker_credentials"
         WHERE worker_id = $3) AS "credentialRows",
       (SELECT count(*)::integer
          FROM "ql3"."worker_credential_mutations"
         WHERE credential_id = ANY($4::varchar[])) AS "mutationRows",
       (SELECT count(*)::integer
          FROM "ql3"."security_audit_events"
         WHERE subject_type = 'user'
           AND subject_id = $5
           AND operation_id IN (
             'worker_credential.issue',
             'worker_credential.revoke'
           )) AS "auditRows",
       (SELECT version
          FROM "ql3"."worker_sessions"
         WHERE worker_id = $3) AS "sessionVersion",
       EXISTS (
         SELECT 1
           FROM (
             SELECT to_jsonb(credential)::text AS payload
               FROM "ql3"."worker_credentials" AS credential
              WHERE worker_id = $3
             UNION ALL
             SELECT to_jsonb(delivery)::text AS payload
               FROM "ql3"."worker_credential_deliveries" AS delivery
              WHERE delivery_id = $1
             UNION ALL
             SELECT to_jsonb(mutation)::text AS payload
               FROM "ql3"."worker_credential_mutations" AS mutation
              WHERE credential_id = ANY($4::varchar[])
             UNION ALL
             SELECT to_jsonb(audit)::text AS payload
               FROM "ql3"."security_audit_events" AS audit
              WHERE subject_type = 'user'
                AND subject_id = $5
                AND operation_id IN (
                  'worker_credential.issue',
                  'worker_credential.revoke'
                )
           ) AS persisted
          WHERE persisted.payload LIKE '%ql3w_%'
       ) AS "secretPersistedInPostgres"`,
    [
      fixture.deliveryId,
      fixture.previousCredentialId,
      fixture.workerId,
      [fixture.previousCredentialId, fixture.credentialId],
      fixture.principal.subject.id,
    ],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

function assertCredentialFault(evidence) {
  assert.deepEqual(evidence, {
    injected: true,
    commitCompletedBeforeFault: true,
    backendTerminationRequested: true,
    backendConnectionRejected: true,
  });
}

async function runCredentialDeliveryCommitResponseLossMatrix(options) {
  const { primaryPort, standbyDatabase } = options;
  const adminDatabase = await databaseOpener(
    'admin',
    databaseUrl(ADMIN_USER, ADMIN_PASSWORD, primaryPort),
    'ql3-ha-credential-admin',
  )();
  const ingressDatabase = await databaseOpener(
    'worker-ingress',
    databaseUrl(WORKER_INGRESS_USER, WORKER_INGRESS_PASSWORD, primaryPort),
    'ql3-ha-credential-worker-ingress',
  )();
  const adapter = createCredentialDeliveryAdapter();
  const faultPools = [];
  const fixture = {
    deliveryId: '123e4567-e89b-42d3-a456-426614174601',
    workerId: 'worker-ha-credential',
    previousCredentialId: 'worker_ha_previous',
    credentialId: 'worker_ha_current',
    sessionId: '018f0000-0000-7000-8000-000000000061',
    principal: null,
  };
  let entropyCalls = 0;
  try {
    const clock = await adminDatabase.pool.query(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
              AS "nowMs"`,
    );
    const operationAtMs = Number(clock.rows[0].nowMs);
    fixture.principal = {
      subject: { type: 'user', id: 'usr_ha_credential_admin' },
      authenticationId: 'session:ha-credential-admin',
      authenticatedAtMs: operationAtMs - 1_000,
      expiresAtMs: operationAtMs + 3_600_000,
      assurance: 'multi_factor',
    };
    const authority = new PostgresWorkerCredentialAdministrationRepository(
      adminDatabase.pool,
    );
    const previousAtMs = operationAtMs - 1_000;
    const previousMutationId = '123e4567-e89b-42d3-a456-426614174600';
    const previousResult = await authority.append({
      expectedCurrentVersion: 0,
      credential: {
        credentialId: fixture.previousCredentialId,
        version: 1,
        state: 'active',
        workerId: fixture.workerId,
        secretDigest: 'a'.repeat(64),
        createdAtMs: previousAtMs,
        notBeforeAtMs: previousAtMs,
        expiresAtMs: operationAtMs + 3_600_000,
      },
      mutation: {
        mutationId: previousMutationId,
        operation: 'issue',
        credentialId: fixture.previousCredentialId,
        credentialVersion: 1,
        expectedPreviousVersion: 0,
        changedBy: fixture.principal.subject,
        createdAtMs: previousAtMs,
      },
      audit: {
        eventId: previousMutationId,
        requestId: 'request-ha-credential-previous',
        operationId: 'worker_credential.issue',
        projectId: null,
        subject: fixture.principal.subject,
        authenticationId: fixture.principal.authenticationId,
        outcome: 'allowed',
        reasons: ['worker_credential_admin'],
        fence: null,
        occurredAtMs: previousAtMs,
      },
    });
    assert.equal(previousResult.status, 'created');

    const request = {
      mutationId: fixture.deliveryId,
      requestId: 'request-ha-credential-current',
      expectedCurrentVersion: 0,
      credentialId: fixture.credentialId,
      workerId: fixture.workerId,
      principal: fixture.principal,
      notBeforeAtMs: operationAtMs,
      expiresAtMs: operationAtMs + 3_600_000,
      previousCredentialId: fixture.previousCredentialId,
      deploymentTargetDigest: 'd'.repeat(64),
      deploymentGeneration: 'ha-secret-generation-2',
    };
    const issuerOptions = {
      now: () => operationAtMs,
      randomBytes(size) {
        entropyCalls += 1;
        return Buffer.alloc(size, 7);
      },
    };

    const v1Fault = credentialCommitFaultEvidence();
    const v1Pool = credentialCommitFaultPool(
      ADMIN_USER,
      ADMIN_PASSWORD,
      primaryPort,
      'ql3-ha-credential-v1-response-loss',
      v1Fault,
    );
    faultPools.push(v1Pool.pool);
    const v1Issuer = createRecoverableWorkerCredentialIssuer(
      new PostgresWorkerCredentialAdministrationRepository(
        v1Pool.repositoryPool,
      ),
      adapter,
      WORKER_CREDENTIAL_PEPPER,
      issuerOptions,
    );
    await assert.rejects(
      v1Issuer.issue(request),
      (error) => error?.code === 'WORKER_CREDENTIAL_DELIVERY_UNAVAILABLE',
      'v1 credential commit response loss must be surfaced as unavailable',
    );
    assertCredentialFault(v1Fault);
    const replicatedV1 = await waitFor(async () => {
      const facts = await credentialDeliveryFacts(
        standbyDatabase.pool,
        fixture,
      );
      return JSON.stringify(facts.deliveryVersions) === '[1]' ? facts : null;
    }, 'credential delivery v1 WAL replay');

    const v2Fault = credentialCommitFaultEvidence();
    const v2Pool = credentialCommitFaultPool(
      ADMIN_USER,
      ADMIN_PASSWORD,
      primaryPort,
      'ql3-ha-credential-v2-response-loss',
      v2Fault,
    );
    faultPools.push(v2Pool.pool);
    const v2Issuer = createRecoverableWorkerCredentialIssuer(
      new PostgresWorkerCredentialAdministrationRepository(
        v2Pool.repositoryPool,
      ),
      adapter,
      WORKER_CREDENTIAL_PEPPER,
      issuerOptions,
    );
    await assert.rejects(
      v2Issuer.issue(request),
      (error) => error?.code === 'WORKER_CREDENTIAL_DELIVERY_UNAVAILABLE',
      'v2 publication ledger response loss must be surfaced as unavailable',
    );
    assertCredentialFault(v2Fault);
    const replicatedV2 = await waitFor(async () => {
      const facts = await credentialDeliveryFacts(
        standbyDatabase.pool,
        fixture,
      );
      return JSON.stringify(facts.deliveryVersions) === '[1,2]' ? facts : null;
    }, 'credential delivery v2 WAL replay');
    const replayedIssue = await createRecoverableWorkerCredentialIssuer(
      authority,
      adapter,
      WORKER_CREDENTIAL_PEPPER,
      issuerOptions,
    ).issue(request);
    assert.equal(replayedIssue.status, 'existing');
    assert.equal(replayedIssue.delivery.state, 'published');
    assert.equal(entropyCalls, 1);
    assert.equal(adapter.facts().stages, 1);
    assert.equal(adapter.facts().publishes, 1);

    const sessions = new PostgresWorkerSessionRepository(ingressDatabase.pool);
    const capabilitiesJson =
      '{"architecture":"arm64","executors":["remote-worker"]}';
    const capabilitiesHash = createHash('sha256')
      .update(capabilitiesJson)
      .digest('hex');
    const registered = await sessions.register({
      workerId: fixture.workerId,
      sessionId: fixture.sessionId,
      capabilitiesJson,
      capabilitiesHash,
      maxConcurrentRuns: 2,
      availableSlots: 2,
      leaseDurationMs: 60_000,
    });
    const v3Fault = credentialCommitFaultEvidence();
    const v3Pool = credentialCommitFaultPool(
      WORKER_INGRESS_USER,
      WORKER_INGRESS_PASSWORD,
      primaryPort,
      'ql3-ha-credential-v3-response-loss',
      v3Fault,
    );
    faultPools.push(v3Pool.pool);
    const faultedSessions = new PostgresWorkerSessionRepository(
      v3Pool.repositoryPool,
    );
    await assert.rejects(
      faultedSessions.heartbeatAuthenticated(
        {
          workerId: fixture.workerId,
          sessionId: fixture.sessionId,
          generation: registered.worker.generation,
          expectedVersion: registered.worker.version,
          availableSlots: 2,
          leaseDurationMs: 60_000,
        },
        {
          workerId: fixture.workerId,
          credentialId: fixture.credentialId,
          credentialVersion: 1,
        },
      ),
      (error) => error?.code === 'ECONNRESET',
      'v3 authenticated observation response loss must reach the ingress caller',
    );
    assertCredentialFault(v3Fault);
    const replicatedV3 = await waitFor(async () => {
      const facts = await credentialDeliveryFacts(
        standbyDatabase.pool,
        fixture,
      );
      return JSON.stringify(facts.deliveryVersions) === '[1,2,3]' &&
        facts.sessionVersion === 1
        ? facts
        : null;
    }, 'credential delivery v3 WAL replay');

    const v4Fault = credentialCommitFaultEvidence();
    const v4Pool = credentialCommitFaultPool(
      ADMIN_USER,
      ADMIN_PASSWORD,
      primaryPort,
      'ql3-ha-credential-v4-response-loss',
      v4Fault,
    );
    faultPools.push(v4Pool.pool);
    const faultedRecovery = createWorkerCredentialDeliveryRecoveryService(
      new PostgresWorkerCredentialAdministrationRepository(
        v4Pool.repositoryPool,
      ),
      adapter,
      WORKER_CREDENTIAL_PEPPER,
      fixture.principal,
    );
    await assert.rejects(
      faultedRecovery.recoverPage({ limit: 1 }),
      (error) => error?.code === 'WORKER_CREDENTIAL_DELIVERY_UNAVAILABLE',
      'v4 previous-credential revoke response loss must be surfaced as unavailable',
    );
    assertCredentialFault(v4Fault);
    const replicatedV4 = await waitFor(async () => {
      const facts = await credentialDeliveryFacts(
        standbyDatabase.pool,
        fixture,
      );
      return JSON.stringify(facts.deliveryVersions) === '[1,2,3,4]'
        ? facts
        : null;
    }, 'credential delivery v4 WAL replay');
    assert.deepEqual(replicatedV4.deliveryStates, [
      'credential_committed',
      'published',
      'observed',
      'previous_revoked',
    ]);
    assert.deepEqual(replicatedV4.previousCredentialStates, [
      'active',
      'revoked',
    ]);
    assert.equal(replicatedV4.credentialRows, 3);
    assert.equal(replicatedV4.mutationRows, 3);
    assert.equal(replicatedV4.auditRows, 3);
    assert.equal(replicatedV4.secretPersistedInPostgres, false);
    const replayedRecovery =
      await createWorkerCredentialDeliveryRecoveryService(
        authority,
        adapter,
        WORKER_CREDENTIAL_PEPPER,
        fixture.principal,
      ).recoverPage({ limit: 1 });
    assert.deepEqual(replayedRecovery.outcomes, []);

    const adapterFacts = adapter.facts();
    assert.deepEqual(adapterFacts, {
      stages: 1,
      publishes: 1,
      discards: 0,
      publicationDigest: 'e'.repeat(64),
      stagedSecretRetained: true,
    });
    const duplicateLedgerVersions =
      replicatedV4.deliveryVersions.length -
      new Set(replicatedV4.deliveryVersions).size;
    assert.equal(duplicateLedgerVersions, 0);
    return {
      fixture,
      report: {
        deliveryId: fixture.deliveryId,
        workerId: fixture.workerId,
        roles: {
          administration: ADMIN_USER,
          workerIngress: WORKER_INGRESS_USER,
        },
        v1CredentialCommit: {
          clientObservedFailure: true,
          ...v1Fault,
          replicatedVersions: replicatedV1.deliveryVersions,
        },
        v2PublicationLedger: {
          clientObservedFailure: true,
          ...v2Fault,
          replayStatus: replayedIssue.status,
          entropyCalls,
          stages: adapterFacts.stages,
          publishes: adapterFacts.publishes,
          replicatedVersions: replicatedV2.deliveryVersions,
        },
        v3AuthenticatedObservation: {
          clientObservedFailure: true,
          ...v3Fault,
          sessionVersion: replicatedV3.sessionVersion,
          replicatedVersions: replicatedV3.deliveryVersions,
        },
        v4PreviousRevoke: {
          clientObservedFailure: true,
          ...v4Fault,
          recoveryCandidatesAfterReplay: replayedRecovery.outcomes.length,
          replicatedVersions: replicatedV4.deliveryVersions,
          previousCredentialStates: replicatedV4.previousCredentialStates,
        },
        duplicateLedgerVersions,
        secretPersistedInPostgres: replicatedV4.secretPersistedInPostgres,
        replicatedBeforePromotion: true,
        survivedPromotion: false,
        faultScope:
          'PostgresClient boundary after driver-confirmed COMMIT plus backend self-termination; not a raw-wire packet-loss fixture',
      },
    };
  } finally {
    adapter.dispose();
    for (const pool of faultPools) await pool.end().catch(() => {});
    await ingressDatabase.close().catch(() => {});
    await adminDatabase.close().catch(() => {});
  }
}

function runtimeCommitFaultPool(port, applicationName, evidence) {
  return credentialCommitFaultPool(
    RUNTIME_USER,
    RUNTIME_PASSWORD,
    port,
    applicationName,
    evidence,
  );
}

async function runDomainCommitResponseLossFacts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       completion_run.status AS "completionRunStatus",
       completion_run.version AS "completionRunVersion",
       completion_run.event_sequence AS "completionEventSequence",
       completion_attempt.status AS "completionAttemptStatus",
       completion_attempt.lease_version AS "completionAttemptLeaseVersion",
       completion_attempt.callback_sequence AS "completionCallbackSequence",
       completion_attempt.callback_token_hash AS "completionCallbackDigest",
       completion_attempt.log_artifact_id AS "completionArtifactId",
       completion_lease.status AS "completionLeaseStatus",
       completion_lease.version AS "completionLeaseVersion",
       (
         SELECT count(*)::integer FROM "ql3"."run_events"
          WHERE run_id = $1
       ) AS "completionEventCount",
       (
         SELECT count(DISTINCT dedupe_key)::integer
           FROM "ql3"."run_events"
          WHERE run_id = $1
       ) AS "completionDedupeCount",
       cancellation_run.status AS "cancellationRunStatus",
       cancellation_run.version AS "cancellationRunVersion",
       cancellation_run.event_sequence AS "cancellationEventSequence",
       cancellation_run.cancel_reason AS "cancellationReason",
       cancellation_attempt.status AS "cancellationAttemptStatus",
       (
         SELECT array_agg(type ORDER BY sequence)
           FROM "ql3"."run_events"
          WHERE run_id = $2
       ) AS "cancellationEventTypes",
       (
         SELECT count(*)::integer FROM "ql3"."run_events"
          WHERE run_id = $2
       ) AS "cancellationEventCount",
       (
         SELECT count(DISTINCT dedupe_key)::integer
           FROM "ql3"."run_events"
          WHERE run_id = $2
       ) AS "cancellationDedupeCount"
     FROM "ql3"."runs" AS completion_run
     JOIN "ql3"."run_attempts" AS completion_attempt
       ON completion_attempt.id = $3
     JOIN "ql3"."run_dispatch_leases" AS completion_lease
       ON completion_lease.attempt_id = completion_attempt.id
     JOIN "ql3"."runs" AS cancellation_run
       ON cancellation_run.id = $2
     JOIN "ql3"."run_attempts" AS cancellation_attempt
       ON cancellation_attempt.id = $4
     WHERE completion_run.id = $1`,
    [
      fixture.completion.runId,
      fixture.cancellation.runId,
      fixture.completion.attemptId,
      fixture.cancellation.attemptId,
    ],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

function assertDomainCommitResponseLossFacts(facts, fixture) {
  assert.deepEqual(facts, {
    completionRunStatus: 'succeeded',
    completionRunVersion: 5,
    completionEventSequence: 2,
    completionAttemptStatus: 'succeeded',
    completionAttemptLeaseVersion: 5,
    completionCallbackSequence: 1,
    completionCallbackDigest: fixture.completion.callbackTokenDigest,
    completionArtifactId: fixture.completion.artifact.logArtifactId,
    completionLeaseStatus: 'completed',
    completionLeaseVersion: 5,
    completionEventCount: 2,
    completionDedupeCount: 2,
    cancellationRunStatus: 'cancelled',
    cancellationRunVersion: 4,
    cancellationEventSequence: 3,
    cancellationReason: 'user',
    cancellationAttemptStatus: 'cancelled',
    cancellationEventTypes: [
      'run.cancel_requested',
      'attempt.cancelled',
      'run.cancelled',
    ],
    cancellationEventCount: 3,
    cancellationDedupeCount: 3,
  });
}

async function runDomainCommitResponseLossMatrix(options) {
  const { primaryPort, primaryDatabase, standbyDatabase } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-domain-replay',
  )();
  const faultPools = [];
  const fixture = {
    projectId: 'ha-domain-project',
    completion: {
      runId: 'ha-completion-run',
      attemptId: 'ha-completion-attempt',
      workerId: 'ha-completion-worker',
      workerSessionId: '018f0000-0000-7000-8000-000000000071',
      workerGeneration: 1,
      offerId: 'ha-completion-offer',
      leaseGeneration: 1,
      leaseToken: 'ha_completion_lease_capability_000000000001',
      expectedLeaseVersion: 4,
      callbackSequence: 1,
      callbackTokenDigest: 'c'.repeat(64),
      artifact: {
        logArtifactId: `wlog-${'d'.repeat(30)}`,
        byteLength: 37,
        sha256: 'e'.repeat(64),
        truncated: false,
      },
      attemptEventId: '018f0000-0000-7000-8000-000000000072',
      runEventId: '018f0000-0000-7000-8000-000000000073',
    },
    cancellation: {
      runId: 'ha-cancellation-run',
      attemptId: 'ha-cancellation-attempt',
      mutationId: 'ha-cancellation-mutation',
      eventId: '018f0000-0000-7000-8000-000000000074',
      subject: { type: 'user', id: 'ha-cancellation-user' },
      policyFence: { projectVersion: 2, bindingVersion: 3 },
    },
  };
  try {
    const clock = await primaryDatabase.pool.query(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
              AS "nowMs"`,
    );
    const nowMs = Number(clock.rows[0].nowMs);
    const completionCreatedAtMs = nowMs - 2_000;
    const completionStartedAtMs = nowMs - 1_000;
    const completionFinishedAtMs = nowMs - 500;
    const leaseExpiresAtMs = nowMs + 5 * 60_000;
    const leaseTokenDigest = createHash('sha256')
      .update(fixture.completion.leaseToken)
      .digest('hex');
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES ($1, 'HA Domain Transactions', 'ha-domain-transactions',
         'active', 2, $2, $2)`,
      [fixture.projectId, completionCreatedAtMs],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."project_role_bindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES ($1, 'user', $2, 3, 'active', 'operator',
         'ha-domain-binding-v3', 'user', 'ha-domain-owner', $3)`,
      [
        fixture.projectId,
        fixture.cancellation.subject.id,
        completionCreatedAtMs,
      ],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."worker_sessions" (
         worker_id, session_id, generation, status, version,
         capabilities_json, capabilities_hash, max_concurrent_runs,
         available_slots, registered_at_ms, last_heartbeat_at_ms,
         lease_expires_at_ms, updated_at_ms
       ) VALUES ($1, $2, 1, 'online', 0, '{}', $3, 1, 1,
         $4, $4, $5, $4)`,
      [
        fixture.completion.workerId,
        fixture.completion.workerSessionId,
        createHash('sha256').update('{}').digest('hex'),
        completionCreatedAtMs,
        leaseExpiresAtMs,
      ],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, created_at_ms,
         queued_at_ms, version, event_sequence
       ) VALUES
         ($1, $3, 'ha-completion-task', 'v1', 'manual', 'api', 'runtime',
          'dispatching', $4, $4, 3, 0),
         ($2, $3, 'ha-cancellation-task', 'v1', 'manual', 'api', 'runtime',
          'queued', $4, $4, 1, 0)`,
      [
        fixture.completion.runId,
        fixture.cancellation.runId,
        fixture.projectId,
        completionCreatedAtMs,
      ],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."run_attempts" (
         id, run_id, attempt, status, executor_type, worker_id,
         callback_sequence, created_at_ms, worker_session_id,
         worker_generation, lease_generation, lease_version,
         lease_token_digest, offer_id
       ) VALUES
         ($1, $3, 1, 'starting', 'remote_worker', $5, 0, $7, $6,
          1, 1, 4, $8, $9),
         ($2, $4, 1, 'claimed', 'remote_worker', NULL, 0, $7, NULL,
          NULL, NULL, NULL, NULL, NULL)`,
      [
        fixture.completion.attemptId,
        fixture.cancellation.attemptId,
        fixture.completion.runId,
        fixture.cancellation.runId,
        fixture.completion.workerId,
        fixture.completion.workerSessionId,
        completionCreatedAtMs,
        leaseTokenDigest,
        fixture.completion.offerId,
      ],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."run_dispatch_leases" (
         attempt_id, run_id, status, version, lease_generation,
         worker_id, worker_session_id, worker_generation,
         lease_token_digest, offer_id, acquired_at_ms, renewed_at_ms,
         expires_at_ms, updated_at_ms
       ) VALUES ($1, $2, 'leased', 4, 1, $3, $4, 1, $5, $6,
         $7, $7, $8, $7)`,
      [
        fixture.completion.attemptId,
        fixture.completion.runId,
        fixture.completion.workerId,
        fixture.completion.workerSessionId,
        leaseTokenDigest,
        fixture.completion.offerId,
        completionCreatedAtMs,
        leaseExpiresAtMs,
      ],
    );

    const completionCommand = {
      workerId: fixture.completion.workerId,
      workerSessionId: fixture.completion.workerSessionId,
      workerGeneration: fixture.completion.workerGeneration,
      projectId: fixture.projectId,
      runId: fixture.completion.runId,
      attemptId: fixture.completion.attemptId,
      offerId: fixture.completion.offerId,
      leaseGeneration: fixture.completion.leaseGeneration,
      leaseToken: fixture.completion.leaseToken,
      expectedLeaseVersion: fixture.completion.expectedLeaseVersion,
      callbackSequence: fixture.completion.callbackSequence,
      callbackTokenDigest: fixture.completion.callbackTokenDigest,
      result: {
        outcome: 'succeeded',
        startedAtMs: completionStartedAtMs,
        finishedAtMs: completionFinishedAtMs,
        exitCode: 0,
      },
      artifact: fixture.completion.artifact,
      attemptEventId: fixture.completion.attemptEventId,
      runEventId: fixture.completion.runEventId,
    };
    const completionFault = credentialCommitFaultEvidence();
    const completionFaultPool = runtimeCommitFaultPool(
      primaryPort,
      'ql3-ha-completion-commit-response-loss',
      completionFault,
    );
    faultPools.push(completionFaultPool.pool);
    await assert.rejects(
      new PostgresRemoteWorkerCompletionRepository(
        completionFaultPool.repositoryPool,
      ).complete(completionCommand),
      (error) => error?.code === 'REMOTE_WORKER_COMPLETION_UNAVAILABLE',
      'completion must expose unavailable after its committed response is lost',
    );
    assertCredentialFault(completionFault);
    const completionReplay = await new PostgresRemoteWorkerCompletionRepository(
      runtimeDatabase.pool,
    ).complete(completionCommand);
    assert.equal(completionReplay.status, 'already_completed');

    const cancellationCommand = {
      projectId: fixture.projectId,
      runId: fixture.cancellation.runId,
      mutationId: fixture.cancellation.mutationId,
      eventId: fixture.cancellation.eventId,
      subject: fixture.cancellation.subject,
      policyFence: fixture.cancellation.policyFence,
    };
    const cancellationIntentFault = credentialCommitFaultEvidence();
    const cancellationIntentFaultPool = runtimeCommitFaultPool(
      primaryPort,
      'ql3-ha-cancellation-intent-commit-response-loss',
      cancellationIntentFault,
    );
    faultPools.push(cancellationIntentFaultPool.pool);
    await assert.rejects(
      new PostgresClusterRunCancellationRepository(
        cancellationIntentFaultPool.repositoryPool,
      ).requestUserCancellation(cancellationCommand),
      (error) => error?.code === 'CLUSTER_RUN_CANCELLATION_UNAVAILABLE',
      'cancellation intent must expose unavailable after committed response loss',
    );
    assertCredentialFault(cancellationIntentFault);
    const cancellationReplay =
      await new PostgresClusterRunCancellationRepository(
        runtimeDatabase.pool,
      ).requestUserCancellation(cancellationCommand);
    assert.equal(cancellationReplay.status, 'already_requested');

    const cancellationConvergenceFault = credentialCommitFaultEvidence();
    const cancellationConvergenceFaultPool = runtimeCommitFaultPool(
      primaryPort,
      'ql3-ha-cancellation-convergence-commit-response-loss',
      cancellationConvergenceFault,
    );
    faultPools.push(cancellationConvergenceFaultPool.pool);
    await assert.rejects(
      new PostgresClusterRunCancellationConvergenceRepository(
        cancellationConvergenceFaultPool.repositoryPool,
      ).convergePage({ limit: 1 }),
      (error) =>
        error?.code === 'CLUSTER_RUN_CANCELLATION_CONVERGENCE_UNAVAILABLE',
      'cancellation convergence must expose unavailable after committed response loss',
    );
    assertCredentialFault(cancellationConvergenceFault);
    const convergenceReplay =
      await new PostgresClusterRunCancellationConvergenceRepository(
        runtimeDatabase.pool,
      ).convergePage({ limit: 1 });
    assert.deepEqual(convergenceReplay, {
      scanned: 0,
      settledRuns: 0,
      settledAttempts: 0,
      blocked: 0,
      hasMore: false,
    });

    const replicatedFacts = await waitFor(async () => {
      try {
        const facts = await runDomainCommitResponseLossFacts(
          standbyDatabase.pool,
          fixture,
        );
        assertDomainCommitResponseLossFacts(facts, fixture);
        return facts;
      } catch {
        return null;
      }
    }, 'completion and cancellation COMMIT-response-loss WAL replay');
    return {
      fixture,
      report: {
        completion: {
          clientObservedFailure: true,
          ...completionFault,
          replayStatus: completionReplay.status,
          eventCount: replicatedFacts.completionEventCount,
          duplicateEvents:
            replicatedFacts.completionEventCount -
            replicatedFacts.completionDedupeCount,
        },
        cancellationIntent: {
          clientObservedFailure: true,
          ...cancellationIntentFault,
          replayStatus: cancellationReplay.status,
        },
        cancellationConvergence: {
          clientObservedFailure: true,
          ...cancellationConvergenceFault,
          replay: convergenceReplay,
          eventCount: replicatedFacts.cancellationEventCount,
          duplicateEvents:
            replicatedFacts.cancellationEventCount -
            replicatedFacts.cancellationDedupeCount,
        },
        replicatedBeforePromotion: true,
        survivedPromotion: false,
        faultScope:
          'PostgresClient boundary after driver-confirmed COMMIT plus backend self-termination; not a raw-wire packet-loss fixture',
      },
    };
  } finally {
    for (const pool of faultPools) await pool.end().catch(() => {});
    await runtimeDatabase.close().catch(() => {});
  }
}

function promoteStandbyAfterPrimaryFence(primaryName, standbyName) {
  const primaryState = docker([
    'inspect',
    primaryName,
    '--format',
    '{{.State.Running}}|{{.State.Status}}',
  ]).stdout;
  if (primaryState !== 'false|exited') {
    const error = new Error(
      `refusing standby promotion before primary fencing: ${primaryState}`,
    );
    error.code = 'QL3_HA_PRIMARY_NOT_FENCED';
    throw error;
  }
  docker([
    'exec',
    '--user',
    'postgres',
    standbyName,
    'pg_ctl',
    'promote',
    '-D',
    POSTGRES_DATA,
    '-w',
    '-t',
    '30',
  ]);
}

async function runManagementQuotaMatrix(options) {
  const occurredAtMs = Number(
    (
      await options.migrationPool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS "observedAtMs"`,
      )
    ).rows[0].observedAtMs,
  );
  await options.migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES (
       'ha-management-quota', 'HA Management Quota',
       'ha-management-quota', 'active', 1, $1, $1
     ) ON CONFLICT (id) DO NOTHING`,
    [occurredAtMs],
  );
  const connectionString = databaseUrl(
    PACKAGE_MANAGER_USER,
    PACKAGE_MANAGER_PASSWORD,
    options.primaryPort,
  );
  const firstDatabase = await databaseOpener(
    'package-manager',
    connectionString,
    'ql3-ha-package-quota-first',
  )();
  const secondDatabase = await databaseOpener(
    'package-manager',
    connectionString,
    'ql3-ha-package-quota-second',
  )();
  try {
    const quotaOptions = {
      windowMs: 60_000,
      limits: { 'plugin-package.inspect': 8 },
    };
    const repositories = [
      new PostgresPluginPackageManagementQuotaRepository(
        firstDatabase.pool,
        quotaOptions,
      ),
      new PostgresPluginPackageManagementQuotaRepository(
        secondDatabase.pool,
        quotaOptions,
      ),
    ];
    const requests = Array.from({ length: 16 }, (_, index) => ({
      projectId: 'ha-management-quota',
      subject: { type: 'user', id: 'ha-concurrent-reviewer' },
      operation: 'plugin-package.inspect',
      idempotencyKey: `ha-inspection-${index + 1}`,
    }));
    const outcomes = await Promise.allSettled(
      requests.map((command, index) =>
        repositories[index % repositories.length].consume(command),
      ),
    );
    const admittedIndexes = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' ? [index] : [],
    );
    const limited = outcomes.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof PluginPackageManagementQuotaExceededError,
    );
    assert.equal(admittedIndexes.length, 8);
    assert.equal(limited.length, 8);
    const replay = await repositories[1].consume(requests[admittedIndexes[0]]);
    assert.equal(replay.remaining, 0);

    const concurrentFacts = await firstDatabase.pool.query(
      `SELECT consumed_count AS "consumedCount",
              jsonb_array_length(receipt_ids) AS "receiptCount"
         FROM "ql3"."plugin_package_management_quota_buckets"
        WHERE project_id = 'ha-management-quota'
          AND subject_type = 'user'
          AND subject_id = 'ha-concurrent-reviewer'
          AND operation = 'plugin-package.inspect'`,
    );
    assert.deepEqual(concurrentFacts.rows, [
      { consumedCount: 8, receiptCount: 8 },
    ]);

    let responseLost = false;
    const responseLossRepository =
      new PostgresPluginPackageManagementQuotaRepository(
        {
          async query(statement, values) {
            const result = await firstDatabase.pool.query(statement, values);
            if (!responseLost && /\bINSERT INTO\b/.test(statement)) {
              responseLost = true;
              const error = new Error(
                'injected management quota autocommit response loss',
              );
              error.code = 'ECONNRESET';
              throw error;
            }
            return result;
          },
        },
        {
          windowMs: 60_000,
          limits: { 'plugin-package.inspect': 2 },
        },
      );
    const responseLossCommand = {
      projectId: 'ha-management-quota',
      subject: { type: 'user', id: 'ha-response-loss-reviewer' },
      operation: 'plugin-package.inspect',
      idempotencyKey: 'ha-response-loss-inspection',
    };
    await assert.rejects(
      responseLossRepository.consume(responseLossCommand),
      PluginPackageManagementUnavailableError,
    );
    const converged = await responseLossRepository.consume(responseLossCommand);
    assert.equal(converged.remaining, 1);
    const responseLossFacts = await firstDatabase.pool.query(
      `SELECT consumed_count AS "consumedCount",
              jsonb_array_length(receipt_ids) AS "receiptCount"
         FROM "ql3"."plugin_package_management_quota_buckets"
        WHERE project_id = 'ha-management-quota'
          AND subject_type = 'user'
          AND subject_id = 'ha-response-loss-reviewer'
          AND operation = 'plugin-package.inspect'`,
    );
    assert.deepEqual(responseLossFacts.rows, [
      { consumedCount: 1, receiptCount: 1 },
    ]);

    const rolloverRepository =
      new PostgresPluginPackageManagementQuotaRepository(firstDatabase.pool, {
        windowMs: 60_000,
        limits: { 'plugin-package.inspect': 2 },
      });
    await rolloverRepository.consume({
      ...responseLossCommand,
      subject: { type: 'user', id: 'ha-window-reviewer' },
      idempotencyKey: 'ha-window-old',
    });
    await firstDatabase.pool.query(
      `UPDATE "ql3"."plugin_package_management_quota_buckets"
          SET window_started_at_ms = 0,
              updated_at_ms = 0
        WHERE project_id = 'ha-management-quota'
          AND subject_type = 'user'
          AND subject_id = 'ha-window-reviewer'
          AND operation = 'plugin-package.inspect'`,
    );
    const rolled = await rolloverRepository.consume({
      ...responseLossCommand,
      subject: { type: 'user', id: 'ha-window-reviewer' },
      idempotencyKey: 'ha-window-new',
    });
    assert.equal(rolled.remaining, 1);
    const rolloverFacts = await firstDatabase.pool.query(
      `SELECT consumed_count AS "consumedCount",
              receipt_ids AS "receiptIds"
         FROM "ql3"."plugin_package_management_quota_buckets"
        WHERE project_id = 'ha-management-quota'
          AND subject_type = 'user'
          AND subject_id = 'ha-window-reviewer'
          AND operation = 'plugin-package.inspect'`,
    );
    assert.deepEqual(rolloverFacts.rows, [
      { consumedCount: 1, receiptIds: ['ha-window-new'] },
    ]);
    return {
      competingInstances: repositories.length,
      concurrentRequests: outcomes.length,
      admitted: admittedIndexes.length,
      limited: limited.length,
      replayConsumedAdditionalUnit: false,
      autocommitResponseLossConverged: responseLost,
      autocommitResponseLossConsumedCount:
        responseLossFacts.rows[0].consumedCount,
      databaseClockWindowReset: true,
      boundedReceiptCount: concurrentFacts.rows[0].receiptCount,
    };
  } finally {
    await Promise.all([firstDatabase.close(), secondDatabase.close()]);
  }
}

async function runWorkerCredentialManagementQuotaMatrix(options) {
  const projectId = 'ha-worker-management-quota';
  const occurredAtMs = Number(
    (
      await options.migrationPool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                AS "observedAtMs"`,
      )
    ).rows[0].observedAtMs,
  );
  await options.migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES (
       $1, 'HA Worker Management Quota', $1, 'active', 1, $2, $2
     ) ON CONFLICT (id) DO NOTHING`,
    [projectId, occurredAtMs],
  );
  const connectionString = databaseUrl(
    WORKER_CREDENTIAL_MANAGER_USER,
    WORKER_CREDENTIAL_MANAGER_PASSWORD,
    options.primaryPort,
  );
  const firstDatabase = await databaseOpener(
    'worker-credential-manager',
    connectionString,
    'ql3-ha-worker-quota-first',
  )();
  const secondDatabase = await databaseOpener(
    'worker-credential-manager',
    connectionString,
    'ql3-ha-worker-quota-second',
  )();
  try {
    const quotaOptions = {
      windowMs: 60_000,
      limits: { 'worker-credential.inspect': 8 },
    };
    const repositories = [
      new PostgresWorkerCredentialManagementQuotaRepository(
        firstDatabase.pool,
        quotaOptions,
      ),
      new PostgresWorkerCredentialManagementQuotaRepository(
        secondDatabase.pool,
        quotaOptions,
      ),
    ];
    const requests = Array.from({ length: 16 }, (_, index) => ({
      projectId,
      subject: { type: 'user', id: 'ha-worker-concurrent-reviewer' },
      operation: 'worker-credential.inspect',
      idempotencyKey: `ha-worker-inspection-${index + 1}`,
    }));
    const outcomes = await Promise.all(
      requests.map((command, index) =>
        repositories[index % repositories.length].consume(command),
      ),
    );
    const admittedIndexes = outcomes.flatMap((outcome, index) =>
      outcome.admitted ? [index] : [],
    );
    assert.equal(admittedIndexes.length, 8);
    assert.equal(outcomes.filter((outcome) => !outcome.admitted).length, 8);
    const replay = await repositories[1].consume(requests[admittedIndexes[0]]);
    assert.equal(replay.admitted, true);

    const concurrentFacts = await firstDatabase.pool.query(
      `SELECT consumed_count AS "consumedCount",
              jsonb_array_length(receipt_ids) AS "receiptCount"
         FROM "ql3"."worker_credential_management_quota_buckets"
        WHERE project_id = $1
          AND subject_type = 'user'
          AND subject_id = 'ha-worker-concurrent-reviewer'
          AND operation = 'worker-credential.inspect'`,
      [projectId],
    );
    assert.deepEqual(concurrentFacts.rows, [
      { consumedCount: 8, receiptCount: 8 },
    ]);

    let responseLost = false;
    const responseLossRepository =
      new PostgresWorkerCredentialManagementQuotaRepository(
        {
          async query(statement, values) {
            const result = await firstDatabase.pool.query(statement, values);
            if (!responseLost && /\bINSERT INTO\b/.test(statement)) {
              responseLost = true;
              const error = new Error(
                'injected Worker management quota autocommit response loss',
              );
              error.code = 'ECONNRESET';
              throw error;
            }
            return result;
          },
        },
        {
          windowMs: 60_000,
          limits: { 'worker-credential.inspect': 2 },
        },
      );
    const responseLossCommand = {
      projectId,
      subject: { type: 'user', id: 'ha-worker-response-loss-reviewer' },
      operation: 'worker-credential.inspect',
      idempotencyKey: 'ha-worker-response-loss-inspection',
    };
    await assert.rejects(
      responseLossRepository.consume(responseLossCommand),
      (error) => error?.code === 'ECONNRESET',
    );
    const converged = await responseLossRepository.consume(responseLossCommand);
    assert.equal(converged.admitted, true);
    const responseLossFacts = await firstDatabase.pool.query(
      `SELECT consumed_count AS "consumedCount",
              jsonb_array_length(receipt_ids) AS "receiptCount"
         FROM "ql3"."worker_credential_management_quota_buckets"
        WHERE project_id = $1
          AND subject_type = 'user'
          AND subject_id = 'ha-worker-response-loss-reviewer'
          AND operation = 'worker-credential.inspect'`,
      [projectId],
    );
    assert.deepEqual(responseLossFacts.rows, [
      { consumedCount: 1, receiptCount: 1 },
    ]);
    return {
      competingInstances: repositories.length,
      concurrentRequests: outcomes.length,
      admitted: admittedIndexes.length,
      limited: outcomes.length - admittedIndexes.length,
      replayConsumedAdditionalUnit: false,
      autocommitResponseLossConverged: responseLost,
      autocommitResponseLossConsumedCount:
        responseLossFacts.rows[0].consumedCount,
      boundedReceiptCount: concurrentFacts.rows[0].receiptCount,
    };
  } finally {
    await Promise.all([firstDatabase.close(), secondDatabase.close()]);
  }
}

async function runIdentityKeysetLedgerMatrix(options) {
  const authority = options.authority ?? 'plugin-package-management';
  assert.ok(
    authority === 'plugin-package-management' ||
      authority === 'worker-credential-management' ||
      authority === 'automation-management' ||
      authority === 'approval-management' ||
      authority === 'run-management',
  );
  const workerAuthority = authority === 'worker-credential-management';
  const automationAuthority = authority === 'automation-management';
  const approvalAuthority = authority === 'approval-management';
  const runAuthority = authority === 'run-management';
  const user = runAuthority
    ? RUN_MANAGER_USER
    : approvalAuthority
    ? APPROVAL_MANAGER_USER
    : automationAuthority
    ? AUTOMATION_MANAGER_USER
    : workerAuthority
    ? WORKER_CREDENTIAL_MANAGER_USER
    : PACKAGE_MANAGER_USER;
  const password = runAuthority
    ? RUN_MANAGER_PASSWORD
    : approvalAuthority
    ? APPROVAL_MANAGER_PASSWORD
    : automationAuthority
    ? AUTOMATION_MANAGER_PASSWORD
    : workerAuthority
    ? WORKER_CREDENTIAL_MANAGER_PASSWORD
    : PACKAGE_MANAGER_PASSWORD;
  const role = runAuthority
    ? 'run-manager'
    : approvalAuthority
    ? 'approval-manager'
    : automationAuthority
    ? 'automation-manager'
    : workerAuthority
    ? 'worker-credential-manager'
    : 'package-manager';
  const applicationPrefix = runAuthority
    ? 'ql3-ha-run-keyset-ledger'
    : approvalAuthority
    ? 'ql3-ha-approval-keyset-ledger'
    : automationAuthority
    ? 'ql3-ha-automation-keyset-ledger'
    : workerAuthority
    ? 'ql3-ha-worker-keyset-ledger'
    : 'ql3-ha-keyset-ledger';
  const keyPrefix = runAuthority
    ? 'ha-run-identity-key'
    : approvalAuthority
    ? 'ha-approval-identity-key'
    : automationAuthority
    ? 'ha-automation-identity-key'
    : workerAuthority
    ? 'ha-worker-identity-key'
    : 'ha-identity-key';
  const issuer = runAuthority
    ? 'https://run-identity.ha.example.test/'
    : approvalAuthority
    ? 'https://approval-identity.ha.example.test/'
    : automationAuthority
    ? 'https://automation-identity.ha.example.test/'
    : workerAuthority
    ? 'https://worker-identity.ha.example.test/'
    : 'https://identity.ha.example.test/';
  const audience = runAuthority
    ? 'qinglong3-run-management'
    : approvalAuthority
    ? 'qinglong3-approval-management'
    : automationAuthority
    ? 'qinglong3-automation-management'
    : workerAuthority
    ? 'qinglong3-worker-credential-management'
    : 'qinglong3-package-management';
  const connectionString = databaseUrl(user, password, options.primaryPort);
  const firstDatabase = await databaseOpener(
    role,
    connectionString,
    `${applicationPrefix}-first`,
  )();
  const secondDatabase = await databaseOpener(
    role,
    connectionString,
    `${applicationPrefix}-second`,
  )();
  const snapshot = (
    generation,
    activeKeyIds,
    revokedKeyIds,
    overrides = {},
  ) => ({
    schemaVersion: 1,
    generation,
    digest: String.fromCharCode(64 + generation).repeat(43),
    issuer,
    audience,
    activeKeyIds,
    revokedKeyIds,
    ...overrides,
  });
  try {
    const first = new PostgresPluginPackageIdentityKeysetLedgerRepository(
      firstDatabase.pool,
      authority,
    );
    const second = new PostgresPluginPackageIdentityKeysetLedgerRepository(
      secondDatabase.pool,
      authority,
    );
    const generationOne = snapshot(1, [`${keyPrefix}-1`], []);
    const generationTwo = snapshot(2, [`${keyPrefix}-2`], [`${keyPrefix}-1`]);
    await first.observe(generationOne);
    await Promise.all([
      first.observe(generationTwo),
      second.observe(generationTwo),
    ]);

    const restartedReplica =
      new PostgresPluginPackageIdentityKeysetLedgerRepository(
        secondDatabase.pool,
        authority,
      );
    await assert.rejects(
      restartedReplica.observe(generationOne),
      PostgresPluginPackageIdentityKeysetLedgerConflictError,
    );
    await assert.rejects(
      restartedReplica.observe({
        ...generationTwo,
        digest: 'Z'.repeat(43),
      }),
      PostgresPluginPackageIdentityKeysetLedgerConflictError,
    );
    await assert.rejects(
      restartedReplica.observe(
        snapshot(3, [`${keyPrefix}-3`], [], {
          digest: 'C'.repeat(43),
        }),
      ),
      PostgresPluginPackageIdentityKeysetLedgerConflictError,
    );

    let responseLost = false;
    const responseLossRepository =
      new PostgresPluginPackageIdentityKeysetLedgerRepository(
        {
          async query() {
            throw new Error('transaction client is required');
          },
          async connect() {
            const client = await firstDatabase.pool.connect();
            return {
              async query(statement, values) {
                const result = await client.query(statement, values);
                if (!responseLost && statement === 'COMMIT') {
                  responseLost = true;
                  const error = new Error(
                    'injected keyset ledger commit response loss',
                  );
                  error.code = 'ECONNRESET';
                  throw error;
                }
                return result;
              },
              release() {
                client.release();
              },
            };
          },
        },
        authority,
      );
    const generationThree = snapshot(
      3,
      [`${keyPrefix}-3`],
      [`${keyPrefix}-1`, `${keyPrefix}-2`],
    );
    await assert.rejects(
      responseLossRepository.observe(generationThree),
      PostgresPluginPackageIdentityKeysetLedgerUnavailableError,
    );
    await second.observe(generationThree);
    const facts = await firstDatabase.pool.query(
      `SELECT generation, digest, issuer, audience,
              active_key_ids AS "activeKeyIds",
              revoked_key_ids AS "revokedKeyIds"
       FROM "ql3"."plugin_package_identity_keyset_ledger"
       WHERE authority = $1`,
      [authority],
    );
    assert.deepEqual(facts.rows, [
      {
        generation: '3',
        digest: 'C'.repeat(43),
        issuer,
        audience,
        activeKeyIds: [`${keyPrefix}-3`],
        revokedKeyIds: [`${keyPrefix}-1`, `${keyPrefix}-2`],
      },
    ]);
    return {
      authority,
      competingInstances: 2,
      generation: Number(facts.rows[0].generation),
      restartRollbackRejected: true,
      sameGenerationRewriteRejected: true,
      implicitRemovalRejected: true,
      commitResponseLossConverged: responseLost,
      trustDomainPinned: true,
      revokedKeyCount: facts.rows[0].revokedKeyIds.length,
    };
  } finally {
    await Promise.all([firstDatabase.close(), secondDatabase.close()]);
  }
}

function toolInvocationArtifactPair() {
  const input = {
    runId: 'ha-tool-artifact-run',
    token: 'ha-tool-secret-must-not-persist',
  };
  const common = {
    projectId: 'ha-tool-artifact',
    actionRef: 'tool-plan:ha-artifact-replication',
    sealedAtMs: 7_000,
  };
  return {
    input: createToolInvocationInputArtifact(
      {
        artifactId: 'ha-tool-input-artifact',
        requestedBy: { type: 'system', id: 'ha-contract' },
        tool: { name: 'ha.compare', version: '1.0.0' },
        input,
        inputDigest: createHash('sha256')
          .update(JSON.stringify(input))
          .digest('hex'),
        invocationActionDigest: 'a'.repeat(64),
        keyId: 'ha-tool-artifact-key',
        key: Buffer.alloc(32, 7),
        ...common,
      },
      () => Buffer.alloc(12, 9),
    ),
    preview: createToolInvocationPreviewArtifact({
      artifactId: 'ha-tool-preview-artifact',
      actionDigest: 'b'.repeat(64),
      redactionContractDigest: 'c'.repeat(64),
      preview: {
        title: 'HA Tool Artifact',
        summary: 'Verifies one encrypted invocation across promotion',
        fields: [
          {
            kind: 'identifier',
            label: 'Run',
            value: input.runId,
          },
          {
            kind: 'redacted',
            label: 'Credential',
            value: null,
          },
        ],
        warnings: [],
      },
      ...common,
    }),
  };
}

async function assertToolInvocationArtifactRoleIsolation(primaryPort, pair) {
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-tool-artifact-runtime-acl',
  )();
  try {
    for (const table of [
      'tool_invocation_input_artifacts',
      'tool_invocation_preview_artifacts',
      'tool_execution_start_artifact_bindings',
    ]) {
      const rowId =
        table === 'tool_invocation_input_artifacts'
          ? pair.input.artifactId
          : table === 'tool_invocation_preview_artifacts'
          ? pair.preview.artifactId
          : 'ha-tool-start-binding';
      const idColumn =
        table === 'tool_execution_start_artifact_bindings'
          ? 'start_id'
          : 'artifact_id';
      const immutableColumn =
        table === 'tool_execution_start_artifact_bindings'
          ? 'bound_at_ms'
          : 'sealed_at_ms';
      await assert.rejects(
        runtimeDatabase.pool.query(
          `UPDATE "ql3"."${table}"
              SET ${immutableColumn} = ${immutableColumn}
            WHERE ${idColumn} = $1`,
          [rowId],
        ),
        (error) => error?.code === '42501',
      );
      await assert.rejects(
        runtimeDatabase.pool.query(
          `DELETE FROM "ql3"."${table}" WHERE ${idColumn} = $1`,
          [rowId],
        ),
        (error) => error?.code === '42501',
      );
    }
  } finally {
    await runtimeDatabase.close();
  }

  const deniedRoles = [
    {
      role: 'admin',
      user: ADMIN_USER,
      password: ADMIN_PASSWORD,
    },
    {
      role: 'package-manager',
      user: PACKAGE_MANAGER_USER,
      password: PACKAGE_MANAGER_PASSWORD,
    },
    {
      role: 'package-executor',
      user: PACKAGE_EXECUTOR_USER,
      password: PACKAGE_EXECUTOR_PASSWORD,
    },
    {
      role: 'worker-ingress',
      user: WORKER_INGRESS_USER,
      password: WORKER_INGRESS_PASSWORD,
    },
  ];
  for (const denied of deniedRoles) {
    const database = await databaseOpener(
      denied.role,
      databaseUrl(denied.user, denied.password, primaryPort),
      `ql3-ha-tool-artifact-${denied.role}-acl`,
    )();
    try {
      for (const table of [
        'tool_invocation_input_artifacts',
        'tool_invocation_preview_artifacts',
        'tool_execution_start_artifact_bindings',
      ]) {
        await assert.rejects(
          database.pool.query(`SELECT 1 FROM "ql3"."${table}" LIMIT 1`),
          (error) => error?.code === '42501',
        );
        await assert.rejects(
          database.pool.query(`INSERT INTO "ql3"."${table}" DEFAULT VALUES`),
          (error) => error?.code === '42501',
        );
      }
    } finally {
      await database.close();
    }
  }
  return deniedRoles.map(({ role }) => role);
}

async function persistToolInvocationArtifactBeforePromotion(options) {
  const { primaryPort, primaryDatabase, standbyDatabase } = options;
  const pair = toolInvocationArtifactPair();
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-tool-artifact-primary',
  )();
  try {
    await runtimeDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         $1, 'HA Tool Artifact', 'ha-tool-artifact', 'active', 1, 1, 1
       )`,
      [pair.input.projectId],
    );
    const repository = new PostgresToolInvocationArtifactRepository(
      runtimeDatabase.pool,
    );
    let inserted;
    try {
      inserted = await repository.put(pair.input, pair.preview);
    } catch (error) {
      const cause = error?.cause;
      throw new Error(
        `Tool invocation Artifact primary write failed${
          cause?.code ? ` sqlstate=${cause.code}` : ''
        }${cause?.constraint ? ` constraint=${cause.constraint}` : ''}${
          cause?.detail ? ` detail=${cause.detail}` : ''
        }`,
        { cause: error },
      );
    }
    assert.deepEqual(inserted, {
      status: 'inserted',
    });
    assert.deepEqual(await repository.put(pair.input, pair.preview), {
      status: 'existing',
    });
    assert.deepEqual(
      await repository.findInput(pair.input.artifactId),
      pair.input,
    );
    assert.deepEqual(
      await repository.findPreview(pair.preview.artifactId),
      pair.preview,
    );
  } finally {
    await runtimeDatabase.close();
  }

  const primaryFacts = await primaryDatabase.pool.query(
    `SELECT
       (SELECT artifact_json::text
          FROM "ql3"."tool_invocation_input_artifacts"
         WHERE artifact_id = $1) AS "inputJson",
       (SELECT artifact_json::text
          FROM "ql3"."tool_invocation_preview_artifacts"
         WHERE artifact_id = $2) AS "previewJson"`,
    [pair.input.artifactId, pair.preview.artifactId],
  );
  assert.equal(primaryFacts.rowCount, 1);
  assert.equal(
    JSON.stringify(primaryFacts.rows[0]).includes(
      'ha-tool-secret-must-not-persist',
    ),
    false,
  );

  await waitFor(async () => {
    const result = await standbyDatabase.pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."tool_invocation_input_artifacts"
           WHERE artifact_id = $1) AS "inputCount",
         (SELECT count(*)::integer
            FROM "ql3"."tool_invocation_preview_artifacts"
           WHERE artifact_id = $2) AS "previewCount",
         (SELECT artifact_json::text
            FROM "ql3"."tool_invocation_input_artifacts"
           WHERE artifact_id = $1) AS "inputJson"`,
      [pair.input.artifactId, pair.preview.artifactId],
    );
    const row = result.rows[0];
    return row?.inputCount === 1 &&
      row?.previewCount === 1 &&
      !row?.inputJson.includes('ha-tool-secret-must-not-persist')
      ? row
      : null;
  }, 'Tool invocation Artifact WAL replay');

  const deniedRoles = await assertToolInvocationArtifactRoleIsolation(
    primaryPort,
    pair,
  );
  return {
    pair,
    report: {
      inputArtifactId: pair.input.artifactId,
      previewArtifactId: pair.preview.artifactId,
      algorithm: pair.input.algorithm,
      exactReplay: true,
      runtimeAppendOnly: true,
      deniedRoles,
      plaintextPersistedInPostgres: false,
      replicatedBeforePromotion: true,
      survivedPromotion: false,
    },
  };
}

async function verifyToolInvocationArtifactAfterPromotion(options) {
  const { promotedPort, promotedDatabase, pair } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-tool-artifact-promoted',
  )();
  try {
    const repository = new PostgresToolInvocationArtifactRepository(
      runtimeDatabase.pool,
    );
    assert.deepEqual(
      await repository.findInput(pair.input.artifactId),
      pair.input,
    );
    assert.deepEqual(
      await repository.findPreview(pair.preview.artifactId),
      pair.preview,
    );
    assert.deepEqual(await repository.put(pair.input, pair.preview), {
      status: 'existing',
    });
  } finally {
    await runtimeDatabase.close();
  }
  const facts = await promotedDatabase.pool.query(
    `SELECT artifact_json::text AS "artifactJson"
       FROM "ql3"."tool_invocation_input_artifacts"
      WHERE artifact_id = $1`,
    [pair.input.artifactId],
  );
  assert.equal(facts.rowCount, 1);
  assert.equal(
    facts.rows[0].artifactJson.includes('ha-tool-secret-must-not-persist'),
    false,
  );
}

function pluginPackageLifecycleAudit(input) {
  return {
    eventId: input.eventId,
    requestId: input.requestId,
    operationId: input.operationId,
    projectId: input.projectId,
    subject: input.subject,
    authenticationId: input.authenticationId,
    outcome: input.outcome,
    reasons: [input.reason],
    fence: { projectVersion: 1, bindingVersion: 1 },
    occurredAtMs: input.occurredAtMs,
  };
}

async function approvePluginPackageLifecycleEvent(options) {
  const { managerPool, executorPool, fixture, impact, ordinal, requestedAtMs } =
    options;
  const requester = { type: 'user', id: 'ha-lifecycle-owner' };
  const reviewer = { type: 'user', id: 'ha-lifecycle-reviewer' };
  const dispatcher = { type: 'system', id: 'ha-lifecycle-dispatcher' };
  const suffix = String(ordinal).padStart(2, '0');
  const requestId = `approval-ha-package-lifecycle-${ordinal}`;
  const dispatchId = `dispatch-ha-package-lifecycle-${ordinal}`;
  const decidedAtMs = requestedAtMs + 1;
  const consumedAtMs = requestedAtMs + 2;
  const occurredAtMs = requestedAtMs + 3;
  const expiresAtMs = requestedAtMs + 60_000;
  const action = {
    permission: 'package.manage',
    actionType: `plugin_package.lifecycle.${impact.action}`,
    actionRef: `lifecycle:${impact.impactDigest}`,
    actionDigest: pluginPackageLifecycleActionDigest(impact),
    previewDigest: impact.impactDigest,
  };
  const request = createApprovalRequest({
    id: requestId,
    projectId: fixture.projectId,
    action,
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: requester,
    requestedAtMs,
    expiresAtMs,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const managerApprovals = new PostgresApprovalRequestRepository(managerPool);
  const created = await managerApprovals.create({
    request,
    audit: pluginPackageLifecycleAudit({
      eventId: `33000000-0000-4000-8000-0000000001${suffix}`,
      requestId: `ha-lifecycle-http-${ordinal}`,
      operationId: 'approval.request',
      projectId: fixture.projectId,
      subject: requester,
      authenticationId: `ha-lifecycle-requester-auth-${ordinal}`,
      outcome: 'approval_required',
      reason: 'package_lifecycle_review',
      occurredAtMs: requestedAtMs,
    }),
  });
  assert.equal(created.status, 'created');
  const decided = await managerApprovals.decide({
    requestId,
    expectedVersion: 1,
    decisionId: `decision-ha-package-lifecycle-${ordinal}`,
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: reviewer,
      authenticationId: `ha-lifecycle-reviewer-auth-${ordinal}`,
      authenticatedAtMs: requestedAtMs,
      expiresAtMs,
      assurance: 'multi_factor',
    },
    decidedAtMs,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
    audit: pluginPackageLifecycleAudit({
      eventId: `33000000-0000-4000-8000-0000000002${suffix}`,
      requestId: `ha-lifecycle-http-${ordinal}`,
      operationId: 'approval.decide',
      projectId: fixture.projectId,
      subject: reviewer,
      authenticationId: `ha-lifecycle-reviewer-auth-${ordinal}`,
      outcome: 'allowed',
      reason: 'package_lifecycle_approved',
      occurredAtMs: decidedAtMs,
    }),
  });
  assert.equal(decided.status, 'decided');
  const consumed = await new PostgresApprovalRequestRepository(
    executorPool,
  ).consume({
    requestId,
    expectedVersion: 2,
    consumptionId: `consume-ha-package-lifecycle-${ordinal}`,
    dispatchId,
    action,
    requestedBy: requester,
    consumedBy: dispatcher,
    consumedAtMs,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
    audit: pluginPackageLifecycleAudit({
      eventId: `33000000-0000-4000-8000-0000000003${suffix}`,
      requestId: `ha-lifecycle-cycle-${ordinal}`,
      operationId: 'approval.consume',
      projectId: fixture.projectId,
      subject: dispatcher,
      authenticationId: `ha-lifecycle-dispatch-auth-${ordinal}`,
      outcome: 'allowed',
      reason: 'package_lifecycle_dispatched',
      occurredAtMs: consumedAtMs,
    }),
  });
  assert.equal(consumed.status, 'consumed');
  return createPluginPackageLifecycleEvent({
    dispatchId: consumed.dispatch.id,
    impact,
    requestedBy: requester,
    approvedBy: reviewer,
    authorizationMode: 'separation_of_duty',
    occurredAtMs,
  });
}

async function pluginPackageStartFenceFacts(options) {
  const { runtimePool, fixture, task, tool } = options;
  const result = await runtimePool.query(
    `SELECT
       "ql3"."plugin_package_run_start_allowed"(
         $1, $2, $3
       ) AS "runAllowed",
       "ql3"."plugin_package_tool_start_allowed"(
         $1, $4, $5::char(64)
       ) AS "toolAllowed"`,
    [
      fixture.projectId,
      task.taskId,
      task.taskRevision,
      tool.definitionRef,
      tool.definitionDigest,
    ],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

function runLifecycleCrashActor(options) {
  const markerPath = path.join(
    options.directory,
    `${options.action}-${options.phase}-crash-marker.json`,
  );
  const environment = {
    ...process.env,
    QL3_LIFECYCLE_CRASH_ACTION: options.action,
    QL3_LIFECYCLE_CRASH_ORDINAL: String(options.ordinal),
    QL3_LIFECYCLE_CRASH_ACTION_REF: options.actionRef,
    QL3_LIFECYCLE_CRASH_PROJECT_ID: options.fixture.projectId,
    QL3_LIFECYCLE_CRASH_PACKAGE_NAME: options.fixture.packageName,
    QL3_LIFECYCLE_CRASH_MANAGER_URL: databaseUrl(
      PACKAGE_MANAGER_USER,
      PACKAGE_MANAGER_PASSWORD,
      options.primaryPort,
    ),
    QL3_LIFECYCLE_CRASH_EXECUTOR_URL: databaseUrl(
      PACKAGE_EXECUTOR_USER,
      PACKAGE_EXECUTOR_PASSWORD,
      options.primaryPort,
    ),
    ...(options.killAfterDurable
      ? {
          QL3_LIFECYCLE_CRASH_KILL_AFTER_DURABLE: 'true',
          QL3_LIFECYCLE_CRASH_MARKER_PATH: markerPath,
        }
      : {}),
  };
  const result = spawnSync(
    process.execPath,
    [LIFECYCLE_CRASH_ACTOR, options.phase],
    {
      encoding: 'utf8',
      env: environment,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `${options.action}/${options.phase}: ${result.error?.message}`,
  );
  if (options.killAfterDurable) {
    assert.equal(
      result.signal,
      'SIGKILL',
      `${options.action}/${options.phase}: status=${
        result.status
      }, stderr=${result.stderr.slice(-CHILD_STDERR_LIMIT)}`,
    );
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.deepEqual(marker, {
      schema: 'qinglong/postgresql-plugin-package-lifecycle-process-crash@v1',
      action: options.action,
      phase: options.phase,
      status: options.expectedDurableStatus,
      pid: marker.pid,
    });
    return marker;
  }
  assert.equal(
    result.status,
    0,
    `${options.action}/${options.phase}: signal=${
      result.signal
    }, stderr=${result.stderr.slice(-CHILD_STDERR_LIMIT)}`,
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'existing');
  return parsed;
}

async function runManagedPluginPackageLifecycleCycle(options) {
  const { action, ordinal, primaryPort, fixture } = options;
  const actionRef = `managed-lifecycle:${action}:${ordinal}`;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ql3-lifecycle-${action}-crash-`),
  );
  const crashWindows = [];
  let planned;
  let executed;
  try {
    for (const [phase, expectedDurableStatus] of [
      ['plan', 'created'],
      ['propose', 'created'],
      ['decide', 'decided'],
      ['execute', 'created'],
    ]) {
      const base = {
        action,
        ordinal,
        primaryPort,
        fixture,
        actionRef,
        phase,
        directory,
        expectedDurableStatus,
      };
      const marker = runLifecycleCrashActor({
        ...base,
        killAfterDurable: true,
      });
      const replay = runLifecycleCrashActor({
        ...base,
        killAfterDurable: false,
      });
      crashWindows.push({
        action,
        phase,
        durableStatus: marker.status,
        replayStatus: replay.status,
      });
      if (phase === 'plan') planned = replay;
      if (phase === 'execute') executed = replay;
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.ok(planned?.plan);
  assert.equal(planned.plan.impact.action, action);
  assert.deepEqual(planned.plan.requestedBy, {
    type: 'user',
    id: 'ha-lifecycle-owner',
  });
  assert.ok(executed?.receipt);
  assert.equal(executed.receipt.action, action);
  return {
    actionRef,
    plan: planned.plan,
    receipt: executed.receipt,
    crashWindows,
  };
}

async function runPluginPackageLifecycleRoundTrip(options) {
  const {
    primaryPort,
    managerPool,
    packagePool,
    runtimePool,
    standbyDatabase,
    fixture,
    task,
    tool,
    snapshots,
  } = options;
  const repository = new PostgresPluginPackageLifecycleRepository(packagePool, {
    registry: fixture.registry,
  });
  const automations = new PostgresPluginPackageAutomationPublicationRepository(
    packagePool,
  );
  const initialAutomation = await automations.findCurrent(
    fixture.projectId,
    fixture.packageName,
  );
  assert.ok(initialAutomation);
  assert.equal(initialAutomation.state, 'active');
  assert.equal(initialAutomation.version, 1);
  const managedDisable = await runManagedPluginPackageLifecycleCycle({
    action: 'disable',
    ordinal: 1,
    primaryPort,
    fixture,
  });
  assert.equal(managedDisable.receipt.lifecycle.disposition, 'disabled');
  const managedEnable = await runManagedPluginPackageLifecycleCycle({
    action: 'enable',
    ordinal: 2,
    primaryPort,
    fixture,
  });
  assert.equal(managedEnable.receipt.lifecycle.disposition, 'active');
  const managedRestoredAutomation = await automations.findCurrent(
    fixture.projectId,
    fixture.packageName,
  );
  assert.equal(managedRestoredAutomation.state, 'active');
  assert.equal(managedRestoredAutomation.version, 3);
  assert.equal(
    managedRestoredAutomation.lifecycleEventDigest,
    managedEnable.receipt.eventDigest,
  );
  const baseTimeMs = Date.now();
  const disableImpact = await repository.plan(
    'disable',
    fixture.projectId,
    fixture.packageName,
  );
  assert.equal(disableImpact.expected.disposition, 'active');
  assert.deepEqual(disableImpact.taskIds, [
    `pkg:${fixture.packageName}:alpha`,
    `pkg:${fixture.packageName}:beta`,
  ]);
  const disableEvent = await approvePluginPackageLifecycleEvent({
    managerPool,
    executorPool: packagePool,
    fixture,
    impact: disableImpact,
    ordinal: 1,
    requestedAtMs: baseTimeMs,
  });
  const commitFault = credentialCommitFaultEvidence();
  const commitFaultPool = credentialCommitFaultPool(
    PACKAGE_EXECUTOR_USER,
    PACKAGE_EXECUTOR_PASSWORD,
    primaryPort,
    'ql3-ha-package-lifecycle-response-loss',
    commitFault,
  );
  let disabled;
  try {
    let authorizationChecks = 0;
    disabled = await new PostgresPluginPackageLifecycleRepository(
      commitFaultPool.repositoryPool,
      { registry: fixture.registry },
    ).transition(disableEvent, () => {
      authorizationChecks += 1;
    });
    assert.equal(disabled.status, 'existing');
    assert.equal(authorizationChecks, 4);
    assertCredentialFault(commitFault);
  } finally {
    await commitFaultPool.pool.end();
  }
  assert.equal(disabled.receipt.lifecycle.disposition, 'disabled');
  assert.equal(disabled.receipt.capability.status, 'withdrawn');
  assert.equal(disabled.receipt.capability.retainedSourceCount, 0);
  const withdrawnAutomation = await automations.findCurrent(
    fixture.projectId,
    fixture.packageName,
  );
  assert.equal(withdrawnAutomation.state, 'withdrawn');
  assert.equal(withdrawnAutomation.version, 4);
  assert.equal(
    withdrawnAutomation.lifecycleEventDigest,
    disableEvent.eventDigest,
  );
  assert.deepEqual(
    withdrawnAutomation.definitions,
    initialAutomation.definitions,
  );
  const disableReplay = await repository.transition(disableEvent, () => {});
  assert.equal(disableReplay.status, 'existing');
  assert.deepEqual(disableReplay.receipt, disabled.receipt);
  assert.deepEqual(
    await pluginPackageStartFenceFacts({
      runtimePool,
      fixture,
      task,
      tool,
    }),
    { runAllowed: false, toolAllowed: false },
  );
  const disabledSnapshot = await snapshots.findCurrent(fixture.projectId);
  assert.ok(disabledSnapshot);
  assert.deepEqual(disabledSnapshot.snapshot.sources, []);
  assert.deepEqual(disabledSnapshot.snapshot.definitions, []);

  const enableImpact = await repository.plan(
    'enable',
    fixture.projectId,
    fixture.packageName,
  );
  assert.equal(enableImpact.expected.disposition, 'disabled');
  assert.equal(enableImpact.expected.eventDigest, disableEvent.eventDigest);
  const enableEvent = await approvePluginPackageLifecycleEvent({
    managerPool,
    executorPool: packagePool,
    fixture,
    impact: enableImpact,
    ordinal: 2,
    requestedAtMs: baseTimeMs + 100,
  });
  let enableAuthorizationChecks = 0;
  const enabled = await repository.transition(enableEvent, () => {
    enableAuthorizationChecks += 1;
  });
  assert.equal(enabled.status, 'created');
  assert.equal(enableAuthorizationChecks, 2);
  assert.equal(enabled.receipt.lifecycle.version, 4);
  assert.equal(enabled.receipt.lifecycle.disposition, 'active');
  assert.equal(enabled.receipt.capability.status, 'restored');
  assert.equal(enabled.receipt.capability.retainedSourceCount, 1);
  const restoredAutomation = await automations.findCurrent(
    fixture.projectId,
    fixture.packageName,
  );
  assert.equal(restoredAutomation.state, 'active');
  assert.equal(restoredAutomation.version, 5);
  assert.equal(
    restoredAutomation.lifecycleEventDigest,
    enableEvent.eventDigest,
  );
  assert.equal(
    restoredAutomation.previousPublicationDigest,
    withdrawnAutomation.publicationDigest,
  );
  assert.deepEqual(
    restoredAutomation.definitions,
    initialAutomation.definitions,
  );
  assert.deepEqual(
    await pluginPackageStartFenceFacts({
      runtimePool,
      fixture,
      task,
      tool,
    }),
    { runAllowed: true, toolAllowed: true },
  );
  const restoredSnapshot = await snapshots.findCurrent(fixture.projectId);
  assert.ok(restoredSnapshot);
  assert.equal(restoredSnapshot.snapshot.sources.length, 1);
  assert.equal(restoredSnapshot.snapshot.definitions.length, 1);

  let runtimeTablesDenied = false;
  try {
    await runtimePool.query(
      `SELECT event_digest
         FROM "ql3"."plugin_package_lifecycle_events"
        LIMIT 1`,
    );
  } catch (error) {
    assert.equal(error?.code, '42501');
    runtimeTablesDenied = true;
  }
  assert.equal(runtimeTablesDenied, true);
  let managerCommitDenied = false;
  try {
    await managerPool.query(
      `SELECT "ql3"."commit_plugin_package_lifecycle"(
         '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 'null'::jsonb
       )`,
    );
  } catch (error) {
    assert.equal(error?.code, '42501');
    managerCommitDenied = true;
  }
  assert.equal(managerCommitDenied, true);

  await waitFor(async () => {
    const result = await standbyDatabase.pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."plugin_package_lifecycle_events"
           WHERE event_digest IN ($1, $2)) AS "eventCount",
         (SELECT count(*)::integer
            FROM "ql3"."plugin_package_lifecycle_receipts"
           WHERE event_digest IN ($1, $2)) AS "receiptCount",
         (SELECT count(*)::integer
            FROM "ql3"."plugin_package_lifecycle_tasks"
           WHERE event_digest IN ($1, $2)) AS "taskCount",
         (SELECT disposition
            FROM "ql3"."plugin_package_lifecycle_heads"
           WHERE project_id = $3 AND package_name = $4) AS disposition,
         (SELECT count(*)::integer
            FROM "ql3"."plugin_package_lifecycle_plans"
           WHERE action_ref IN ($5, $6)) AS "planCount",
         (SELECT count(*)::integer
            FROM "ql3"."plugin_package_automation_publications"
           WHERE project_id = $3 AND package_name = $4)
           AS "automationPublicationCount",
         (SELECT state
            FROM "ql3"."plugin_package_automation_publication_heads"
           WHERE project_id = $3 AND package_name = $4)
           AS "automationState",
         (SELECT version
            FROM "ql3"."plugin_package_automation_publication_heads"
           WHERE project_id = $3 AND package_name = $4)
           AS "automationVersion"`,
      [
        disableEvent.eventDigest,
        enableEvent.eventDigest,
        fixture.projectId,
        fixture.packageName,
        managedDisable.actionRef,
        managedEnable.actionRef,
      ],
    );
    const row = result.rows[0];
    return row?.eventCount === 2 &&
      row?.receiptCount === 2 &&
      row?.taskCount === 4 &&
      row?.disposition === 'active' &&
      row?.planCount === 2 &&
      row?.automationPublicationCount === 5 &&
      row?.automationState === 'active' &&
      row?.automationVersion === 5
      ? row
      : null;
  }, 'Plugin Package lifecycle WAL replay');

  return {
    managedPlans: [managedDisable.plan, managedEnable.plan],
    disableEvent,
    disableReceipt: disabled.receipt,
    enableEvent,
    enableReceipt: enabled.receipt,
    automationPublication: restoredAutomation,
    report: {
      projectId: fixture.projectId,
      packageName: fixture.packageName,
      installationId: enabled.receipt.lifecycle.installationId,
      lockDigest: enabled.receipt.lifecycle.lockDigest,
      disableEventDigest: disableEvent.eventDigest,
      enableEventDigest: enableEvent.eventDigest,
      disableReceiptDigest: disabled.receipt.receiptDigest,
      enableReceiptDigest: enabled.receipt.receiptDigest,
      lifecycleVersion: enabled.receipt.lifecycle.version,
      dispositionBeforeQuarantine: enabled.receipt.lifecycle.disposition,
      taskTransitions:
        disabled.receipt.capability.taskTransitions.length +
        enabled.receipt.capability.taskTransitions.length,
      automationPublicationVersion: restoredAutomation.version,
      automationPublicationState: restoredAutomation.state,
      automationWorkflowCount: restoredAutomation.definitions.workflows.length,
      automationPromptCount: restoredAutomation.definitions.prompts.length,
      automationLifecycleTransitions: 4,
      automationLifecycleChainAtomic: true,
      commitResponseLossConvergedExactlyOnce: true,
      exactReplay: true,
      separationOfDutyApproved: true,
      runStartDeniedWhileDisabled: true,
      toolStartDeniedWhileDisabled: true,
      runStartAllowedAfterRestore: true,
      toolStartAllowedAfterRestore: true,
      runtimeTablesDenied,
      managerCommitDenied,
      managedLifecyclePlans: 2,
      managedLifecycleDisableReceiptDigest:
        managedDisable.receipt.receiptDigest,
      managedLifecycleEnableReceiptDigest: managedEnable.receipt.receiptDigest,
      managerReadsExecutorPlans: true,
      executorReplansBeforeTransition: true,
      managementProcessCrashWindows: [
        ...managedDisable.crashWindows,
        ...managedEnable.crashWindows,
      ],
      managementProcessCrashesConvergedExactlyOnce:
        [...managedDisable.crashWindows, ...managedEnable.crashWindows]
          .length === 8 &&
        [...managedDisable.crashWindows, ...managedEnable.crashWindows].every(
          ({ replayStatus }) => replayStatus === 'existing',
        ),
      replicatedBeforePromotion: true,
      survivedPromotion: false,
    },
  };
}

async function remoteWorkflowCancellationFacts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       run.status AS "runStatus",
       run.cancel_reason AS "cancelReason",
       run.error_code AS "runErrorCode",
       run.event_sequence::integer AS "eventSequence",
       attempt.status AS "attemptStatus",
       attempt.error_code AS "attemptErrorCode",
       attempt.callback_sequence::integer AS "callbackSequence",
       step.status AS "stepStatus",
       lease.status AS "leaseStatus",
       lease.version::integer AS "leaseVersion",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_workflow_admissions"
         WHERE run_id = run.id) AS "workflowAdmissionCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
         WHERE run_id = run.id AND attempt_id = attempt.id)
         AS "workflowTaskAttemptAdmissionCount",
       (SELECT count(*)::integer
          FROM "ql3"."run_events"
         WHERE run_id = run.id) AS "eventCount",
       (SELECT count(*)::integer
          FROM "ql3"."run_events"
         WHERE run_id = run.id AND type = 'run.cancel_requested')
         AS "cancellationEventCount",
       (SELECT count(*)::integer
          FROM "ql3"."run_events"
         WHERE run_id = run.id
           AND type = 'workflow.task_attempt.cancelled')
         AS "attemptCancelledEventCount",
       (SELECT count(*)::integer
          FROM "ql3"."run_events"
         WHERE run_id = run.id AND type = 'workflow.cancelled')
         AS "workflowCancelledEventCount",
       (SELECT count(*)::integer
          FROM "ql3"."step_run_mutations"
         WHERE run_id = run.id) AS "stepMutationCount"
     FROM "ql3"."runs" AS run
     JOIN "ql3"."run_attempts" AS attempt
       ON attempt.id = $2 AND attempt.run_id = run.id
     JOIN "ql3"."step_runs" AS step
       ON step.id = $3 AND step.run_id = run.id
     JOIN "ql3"."run_dispatch_leases" AS lease
       ON lease.attempt_id = attempt.id
    WHERE run.id = $1`,
    [fixture.runId, fixture.attemptId, fixture.stepRunId],
  );
  return result.rows[0] ?? null;
}

function assertRemoteWorkflowCancellationFacts(facts) {
  assert.deepEqual(facts, {
    runStatus: 'cancelled',
    cancelReason: 'user',
    runErrorCode: 'EXECUTION_CANCELLED',
    eventSequence: 8,
    attemptStatus: 'cancelled',
    attemptErrorCode: 'EXECUTION_CANCELLED',
    callbackSequence: 1,
    stepStatus: 'cancelled',
    leaseStatus: 'completed',
    leaseVersion: 6,
    workflowAdmissionCount: 1,
    workflowTaskAttemptAdmissionCount: 1,
    eventCount: 8,
    cancellationEventCount: 1,
    attemptCancelledEventCount: 1,
    workflowCancelledEventCount: 1,
    stepMutationCount: 3,
  });
}

async function runRemoteWorkflowCancellationMatrix(options) {
  const {
    primaryPort,
    runtimePool,
    standbyDatabase,
    publication,
    revision,
    taskSpecSemanticRegistry,
    plannedAtMs,
  } = options;
  const faultPools = [];
  const fixture = {
    projectId: publication.target.projectId,
    runId: 'ha-remote-workflow-cancel-run-001',
    stepRunId: 'ha-remote-workflow-cancel-step-001',
    workerId: 'ha-remote-workflow-cancel-worker',
    workerSessionId: '018f0000-0000-7000-8000-000000000081',
    workerGeneration: 1,
    offerId: 'ha-remote-workflow-cancel-offer',
    leaseGeneration: 1,
    leaseToken: 'ha_remote_workflow_cancel_lease_capability_00000001',
    expectedLeaseVersion: 4,
    callbackSequence: 1,
    callbackTokenDigest: '8'.repeat(64),
    artifact: {
      logArtifactId: `wlog-${'9'.repeat(30)}`,
      byteLength: 41,
      sha256: 'a'.repeat(64),
      truncated: false,
    },
    cancellation: {
      mutationId: 'ha-remote-workflow-cancel-mutation-001',
      eventId: '018f0000-0000-7000-8000-000000000082',
      subject: { type: 'user', id: 'ha-lifecycle-owner' },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    },
  };
  try {
    const plan = createPluginPackageWorkflowExecutionPlan({
      planId: 'ha-remote-workflow-cancel-plan-001',
      runId: fixture.runId,
      workflowId: 'ha-daily',
      stepRunIds: { run: fixture.stepRunId },
      publication,
      revision,
      taskSpecSemanticRegistry,
      plannedAtMs,
    });
    const admissionRepository =
      new PostgresPluginPackageWorkflowAdmissionRepository(runtimePool);
    const admission = await admissionRepository.admit(plan);
    assert.equal(admission.status, 'created');
    const attemptRepository =
      new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
        runtimePool,
      );
    const attemptAdmission = await attemptRepository.admit(
      fixture.runId,
      fixture.stepRunId,
    );
    assert.equal(attemptAdmission.status, 'created');
    assert.equal(attemptAdmission.receipt.executorType, 'remote_worker');
    fixture.attemptId = attemptAdmission.receipt.attemptId;

    const clock = await runtimePool.query(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
              AS "nowMs"`,
    );
    const nowMs = Number(clock.rows[0].nowMs);
    const leaseExpiresAtMs = nowMs + 5 * 60_000;
    const leaseTokenDigest = createHash('sha256')
      .update(fixture.leaseToken)
      .digest('hex');
    await runtimePool.query(
      `INSERT INTO "ql3"."worker_sessions" (
         worker_id, session_id, generation, status, version,
         capabilities_json, capabilities_hash, max_concurrent_runs,
         available_slots, registered_at_ms, last_heartbeat_at_ms,
         lease_expires_at_ms, updated_at_ms
       ) VALUES ($1, $2, $3, 'online', 0, '{}', $4, 1, 1,
         $5, $5, $6, $5)`,
      [
        fixture.workerId,
        fixture.workerSessionId,
        fixture.workerGeneration,
        createHash('sha256').update('{}').digest('hex'),
        nowMs,
        leaseExpiresAtMs,
      ],
    );
    const attemptStarted = await runtimePool.query(
      `UPDATE "ql3"."run_attempts"
          SET status = 'starting', worker_id = $2, worker_session_id = $3,
              worker_generation = $4, lease_generation = $5,
              lease_version = $6, lease_token_digest = $7, offer_id = $8,
              lease_expires_at_ms = $9
        WHERE id = $1 AND run_id = $10 AND step_run_id = $11
          AND status = 'claimed' AND executor_type = 'remote_worker'`,
      [
        fixture.attemptId,
        fixture.workerId,
        fixture.workerSessionId,
        fixture.workerGeneration,
        fixture.leaseGeneration,
        fixture.expectedLeaseVersion,
        leaseTokenDigest,
        fixture.offerId,
        leaseExpiresAtMs,
        fixture.runId,
        fixture.stepRunId,
      ],
    );
    assert.equal(attemptStarted.rowCount, 1);
    await runtimePool.query(
      `INSERT INTO "ql3"."run_dispatch_leases" (
         attempt_id, run_id, status, version, lease_generation,
         worker_id, worker_session_id, worker_generation,
         lease_token_digest, offer_id, acquired_at_ms, renewed_at_ms,
         expires_at_ms, updated_at_ms
       ) VALUES ($1, $2, 'leased', $3, $4, $5, $6, $7, $8, $9,
         $10, $10, $11, $10)`,
      [
        fixture.attemptId,
        fixture.runId,
        fixture.expectedLeaseVersion,
        fixture.leaseGeneration,
        fixture.workerId,
        fixture.workerSessionId,
        fixture.workerGeneration,
        leaseTokenDigest,
        fixture.offerId,
        nowMs,
        leaseExpiresAtMs,
      ],
    );

    const cancellationCommand = {
      projectId: fixture.projectId,
      runId: fixture.runId,
      ...fixture.cancellation,
      workflowTarget: {
        packageName: publication.target.packageName,
        workflowId: 'ha-daily',
      },
    };
    const cancellation = await new PostgresClusterRunCancellationRepository(
      runtimePool,
    ).requestUserCancellation(cancellationCommand);
    assert.equal(cancellation.status, 'accepted');
    const controlCommand = {
      workerId: fixture.workerId,
      workerSessionId: fixture.workerSessionId,
      workerGeneration: fixture.workerGeneration,
      projectId: fixture.projectId,
      runId: fixture.runId,
      attemptId: fixture.attemptId,
      offerId: fixture.offerId,
      leaseGeneration: fixture.leaseGeneration,
      leaseToken: fixture.leaseToken,
      expectedLeaseVersion: fixture.expectedLeaseVersion,
      leaseDurationMs: 60_000,
      timeoutEventId: '018f0000-0000-7000-8000-000000000083',
    };
    const control = await new PostgresRemoteWorkerLeaseControlRepository(
      runtimePool,
    ).control(controlCommand);
    assert.equal(control.status, 'stop_requested');
    assert.equal(control.stop.reason, 'user');
    assert.equal(control.leaseVersion, 5);

    const completionCommand = {
      workerId: fixture.workerId,
      workerSessionId: fixture.workerSessionId,
      workerGeneration: fixture.workerGeneration,
      projectId: fixture.projectId,
      runId: fixture.runId,
      attemptId: fixture.attemptId,
      offerId: fixture.offerId,
      leaseGeneration: fixture.leaseGeneration,
      leaseToken: fixture.leaseToken,
      expectedLeaseVersion: control.leaseVersion,
      callbackSequence: fixture.callbackSequence,
      callbackTokenDigest: fixture.callbackTokenDigest,
      result: {
        outcome: 'succeeded',
        startedAtMs: nowMs,
        finishedAtMs: nowMs,
        exitCode: 0,
      },
      artifact: fixture.artifact,
      attemptEventId: '018f0000-0000-7000-8000-000000000084',
      runEventId: '018f0000-0000-7000-8000-000000000085',
    };
    const completionFault = credentialCommitFaultEvidence();
    const completionFaultPool = runtimeCommitFaultPool(
      primaryPort,
      'ql3-ha-remote-workflow-completion-response-loss',
      completionFault,
    );
    faultPools.push(completionFaultPool.pool);
    await assert.rejects(
      new PostgresRemoteWorkerCompletionRepository(
        completionFaultPool.repositoryPool,
      ).complete(completionCommand),
      (error) => error?.code === 'REMOTE_WORKER_COMPLETION_UNAVAILABLE',
    );
    assertCredentialFault(completionFault);
    const completionReplay = await new PostgresRemoteWorkerCompletionRepository(
      runtimePool,
    ).complete(completionCommand);
    assert.equal(completionReplay.status, 'already_completed');

    const convergenceFault = credentialCommitFaultEvidence();
    const convergenceFaultPool = runtimeCommitFaultPool(
      primaryPort,
      'ql3-ha-remote-workflow-convergence-response-loss',
      convergenceFault,
    );
    faultPools.push(convergenceFaultPool.pool);
    await assert.rejects(
      new PostgresClusterRunCancellationConvergenceRepository(
        convergenceFaultPool.repositoryPool,
      ).convergePage({ limit: 1 }),
      (error) =>
        error?.code === 'CLUSTER_RUN_CANCELLATION_CONVERGENCE_UNAVAILABLE',
    );
    assertCredentialFault(convergenceFault);
    assert.deepEqual(
      await new PostgresClusterRunCancellationConvergenceRepository(
        runtimePool,
      ).convergePage({ limit: 1 }),
      {
        scanned: 0,
        settledRuns: 0,
        settledAttempts: 0,
        blocked: 0,
        hasMore: false,
      },
    );

    const replicatedFacts = await waitFor(
      () => remoteWorkflowCancellationFacts(standbyDatabase.pool, fixture),
      'Remote Workflow cancellation WAL replay',
    );
    assertRemoteWorkflowCancellationFacts(replicatedFacts);
    return {
      plan,
      admissionReceipt: admission.receipt,
      attemptReceipt: attemptAdmission.receipt,
      fixture,
      completionCommand,
      report: {
        projectId: fixture.projectId,
        runId: fixture.runId,
        stepRunId: fixture.stepRunId,
        attemptId: fixture.attemptId,
        workflowTarget: cancellationCommand.workflowTarget,
        workflowTargetBound: true,
        stopRequested: true,
        conclusiveStopObserved: true,
        completionClientObservedFailure: true,
        completionReplayStatus: completionReplay.status,
        completionCommitCompletedBeforeFault:
          completionFault.commitCompletedBeforeFault,
        convergenceClientObservedFailure: true,
        convergenceCommitCompletedBeforeFault:
          convergenceFault.commitCompletedBeforeFault,
        eventCount: replicatedFacts.eventCount,
        stepMutationCount: replicatedFacts.stepMutationCount,
        replicatedBeforePromotion: true,
        replayedAfterPromotion: false,
        survivedPromotion: false,
      },
    };
  } finally {
    await Promise.all(faultPools.map((pool) => pool.end()));
  }
}

async function verifyRemoteWorkflowCancellationAfterPromotion(options) {
  const { promotedPort, promotedDatabase, evidence } = options;
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-remote-workflow-cancellation-promoted',
  )();
  try {
    const completionReplay = await new PostgresRemoteWorkerCompletionRepository(
      runtimeDatabase.pool,
    ).complete(evidence.completionCommand);
    assert.equal(completionReplay.status, 'already_completed');
    assert.deepEqual(
      await new PostgresClusterRunCancellationConvergenceRepository(
        runtimeDatabase.pool,
      ).convergePage({ limit: 1 }),
      {
        scanned: 0,
        settledRuns: 0,
        settledAttempts: 0,
        blocked: 0,
        hasMore: false,
      },
    );
    assertRemoteWorkflowCancellationFacts(
      await remoteWorkflowCancellationFacts(
        promotedDatabase.pool,
        evidence.fixture,
      ),
    );
    evidence.report.replayedAfterPromotion = true;
    evidence.report.survivedPromotion = true;
  } finally {
    await runtimeDatabase.close();
  }
}

async function runPluginPackageQuarantineMatrix(options) {
  const { primaryPort, migrationPool, standbyDatabase } = options;
  const tool = Object.freeze({
    name: 'package-ha-quarantine.read',
    version: '1.0.0',
    description: 'Read one bounded quarantine HA fixture',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'string', maxLength: 32 } },
      required: ['status'],
      additionalProperties: false,
    },
    effect: 'read',
    risk: 'low',
    requiredPermissions: ['run.read'],
    timeoutSeconds: 20,
  });
  const fixture = pluginPackageTaskReconciliationFixture('ha-quarantine', {
    profile: 'cluster-control',
    tools: [tool],
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'ha-daily',
        name: 'HA daily workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'ha-greeting',
        name: 'HA greeting prompt',
        template: 'Hello {{name}}',
        parameters: [{ name: 'name', required: true }],
      },
    ],
  });
  const workflowActor = Object.freeze({
    type: 'api_app',
    id: 'ha-workflow-operator',
  });
  const workflowAuthorizationFence = Object.freeze({
    projectVersion: 1,
    bindingVersion: 1,
  });
  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES
       (
         $1, 'HA Package Quarantine', 'ha-package-quarantine',
         'active', 1, 1, 1
       ),
       (
         'ha-publisher-trust-authority', 'HA Publisher Trust Authority',
         'ha-publisher-trust-authority', 'active', 1, 1, 1
       )`,
    [fixture.projectId],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."identity_subjects" (
       subject_type, subject_id, status, version,
       created_at_ms, updated_at_ms
     ) VALUES
       ('api_app', $1, 'active', 1, 1, 1),
       ('user', 'ha-prompt-operator', 'active', 1, 1, 1)`,
    [workflowActor.id],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."api_credentials" (
       credential_id, version, state, subject_type, subject_id,
       secret_digest, created_at_ms, not_before_at_ms, expires_at_ms,
       pepper_key_id
     ) VALUES
       (
         'ha-workflow-product', 1, 'active', 'api_app', $1,
         $2, 1, 1, 4102444800000, 'legacy-v1'
       ),
       (
         'ha-prompt-product', 1, 'active', 'user', 'ha-prompt-operator',
         $3, 1, 1, 4102444800000, 'legacy-v1'
       )`,
    [workflowActor.id, '7'.repeat(64), '8'.repeat(64)],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES
       (
         'ha-publisher-trust-authority', 'user', 'ha-owner-a', 1,
         'active', 'owner', 'ha-publisher-trust-owner-v1',
         'system', 'ha-contract', 1
       ),
       (
         'ha-publisher-trust-authority', 'user', 'ha-owner-b', 1,
         'active', 'admin', 'ha-publisher-trust-reviewer-v1',
         'system', 'ha-contract', 1
       ),
       (
         $1, 'user', 'ha-lifecycle-owner', 1,
         'active', 'owner', 'ha-package-lifecycle-owner-v1',
         'system', 'ha-contract', 1
       ),
       (
         $1, 'user', 'ha-lifecycle-reviewer', 1,
         'active', 'admin', 'ha-package-lifecycle-reviewer-v1',
         'system', 'ha-contract', 1
       ),
       (
         $1, 'user', 'ha-prompt-operator', 1,
         'active', 'operator', 'ha-prompt-operator-v1',
         'system', 'ha-contract', 1
       ),
       (
         $1, 'api_app', $2, 1,
         'active', 'operator', 'ha-workflow-operator-v1',
         'system', 'ha-contract', 1
       )`,
    [fixture.projectId, workflowActor.id],
  );

  const active = fixture.install.active;
  const proposalAtMs = active.updatedAtMs + 1;
  const executionAtMs = proposalAtMs + 2;
  const { publicKey } = generateKeyPairSync('ed25519');
  const trustSnapshot = createPluginPackagePublisherTrustSnapshot([
    {
      publisher: 'packages.contract.qinglong.dev',
      keyId: 'contract-key-1',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      notBeforeMs: 0,
      notAfterMs: 100_000,
    },
  ]);
  const trustDatabase = await databaseOpener(
    'package-manager',
    databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, primaryPort),
    'ql3-ha-publisher-trust-initializer',
  )();
  try {
    const observed =
      await new PostgresPluginPackagePublisherTrustAuthorityRepository(
        trustDatabase.pool,
      ).observeSnapshot({
        authorityId: 'cluster',
        observedBy: 'ha-package-manager',
        observedAtMs: active.updatedAtMs,
        snapshot: trustSnapshot,
      });
    assert.equal(observed.status, 'created');
  } finally {
    await trustDatabase.close();
  }

  const packageDatabase = await databaseOpener(
    'package-executor',
    databaseUrl(PACKAGE_EXECUTOR_USER, PACKAGE_EXECUTOR_PASSWORD, primaryPort),
    'ql3-ha-package-quarantine-primary',
  )();
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-package-quarantine-runtime-primary',
  )();
  const commitFault = credentialCommitFaultEvidence();
  const commitFaultPool = credentialCommitFaultPool(
    PACKAGE_EXECUTOR_USER,
    PACKAGE_EXECUTOR_PASSWORD,
    primaryPort,
    'ql3-ha-package-quarantine-response-loss',
    commitFault,
  );
  try {
    const provenanceRepository =
      new PostgresPluginPackagePublisherProvenanceRepository(
        packageDatabase.pool,
      );
    const installationInventoryRepository =
      new PostgresPluginPackageInstallRepository(packageDatabase.pool);
    const installRepository = publisherProvenanceInstallRepository(
      installationInventoryRepository,
      provenanceRepository,
    );
    const materializedRepository =
      new PostgresPluginPackageMaterializedRevisionRepository(
        packageDatabase.pool,
        fixture.registry,
      );
    const automationRepository =
      new PostgresPluginPackageAutomationPublicationRepository(
        packageDatabase.pool,
      );
    const automationStartGuard =
      new PostgresPluginPackageAutomationPublicationRepository(
        runtimeDatabase.pool,
      );
    const reconciliationRepository =
      new PostgresPluginPackageTaskReconciliationRepository(
        packageDatabase.pool,
        fixture.registry,
      );
    const snapshotRepository =
      new PostgresProjectToolDefinitionSnapshotRepository(packageDatabase.pool);
    await activateInstall(installRepository, fixture);
    await materializedRepository.publish(fixture.revision);
    assert.deepEqual(await automationRepository.listPendingPage({ limit: 1 }), {
      candidates: [
        {
          projectId: fixture.projectId,
          packageName: fixture.packageName,
        },
      ],
      truncated: false,
    });
    const initialAutomationPublication =
      createInitialPluginPackageAutomationPublication(
        fixture.revision,
        fixture.registry,
        active.updatedAtMs,
      );
    assert.equal(
      (await automationRepository.publish(initialAutomationPublication)).status,
      'created',
    );
    assert.deepEqual(await automationRepository.listPendingPage({ limit: 1 }), {
      candidates: [],
      truncated: false,
    });
    const reconciliation = await reconciliationRepository.reconcile(
      fixture.revision,
      {
        async findActiveResourceGeneration() {
          return fixture.revision.generation;
        },
      },
    );
    assert.equal(reconciliation.status, 'created');
    const workflowPlan = createPluginPackageWorkflowExecutionPlan({
      planId: '018f0000-0000-4000-8000-000000000091',
      runId: 'ha-workflow-admission-run-001',
      workflowId: 'ha-daily',
      stepRunIds: {
        run: 'ha-workflow-admission-step-run-001',
      },
      publication: initialAutomationPublication,
      revision: fixture.revision,
      taskSpecSemanticRegistry: fixture.registry,
      plannedAtMs: active.updatedAtMs + 1,
    });
    const authorizedWorkflowAdmissionRepository =
      new PostgresAuthorizedPluginPackageWorkflowAdmissionRepository(
        runtimeDatabase.pool,
      );
    const workflowAdmissionRepository =
      new PostgresPluginPackageWorkflowAdmissionRepository(
        runtimeDatabase.pool,
      );
    const workflowAuthorizedAdmission = Object.freeze({
      plan: workflowPlan,
      actor: workflowActor,
      fence: workflowAuthorizationFence,
      audit: Object.freeze({
        eventId: workflowPlan.planId,
        requestId: workflowPlan.planId,
        operationId: 'workflow.start',
        projectId: fixture.projectId,
        subject: workflowActor,
        authenticationId: 'api_credential:ha-workflow-product:1',
        outcome: 'allowed',
        reasons: Object.freeze(['project_policy_allowed']),
        fence: workflowAuthorizationFence,
        occurredAtMs: workflowPlan.plannedAtMs,
      }),
    });
    const workflowAdmissionPrivileges = await runtimeDatabase.pool.query(
      `SELECT current_user AS "currentUser",
              session_user AS "sessionUser",
              has_table_privilege(
                current_user,
                'ql3.plugin_package_workflow_admissions',
                'SELECT'
              ) AS "admissionSelect",
              has_table_privilege(
                current_user,
                'ql3.plugin_package_workflow_admissions',
                'INSERT'
              ) AS "admissionInsert",
              has_table_privilege(
                current_user,
                'ql3.plugin_package_workflow_admission_steps',
                'SELECT'
              ) AS "stepSelect",
              has_table_privilege(
                current_user,
                'ql3.plugin_package_workflow_admission_steps',
                'INSERT'
              ) AS "stepInsert"`,
    );
    assert.deepEqual(workflowAdmissionPrivileges.rows, [
      {
        currentUser: RUNTIME_USER,
        sessionUser: RUNTIME_USER,
        admissionSelect: true,
        admissionInsert: true,
        stepSelect: true,
        stepInsert: true,
      },
    ]);
    const workflowAdmission =
      await authorizedWorkflowAdmissionRepository.admitAuthorized(
        workflowAuthorizedAdmission,
      );
    assert.equal(workflowAdmission.status, 'created');
    assert.deepEqual(
      await authorizedWorkflowAdmissionRepository.admitAuthorized(
        workflowAuthorizedAdmission,
      ),
      {
        status: 'existing',
        receipt: workflowAdmission.receipt,
      },
    );
    const workflowRunInspections =
      new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
        runtimeDatabase.pool,
      );
    const workflowRunInspection =
      await workflowRunInspections.inspectRunAuthorized({
        projectId: fixture.projectId,
        packageName: fixture.packageName,
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000092',
          requestId: 'ha-workflow-run-inspection-primary',
          operationId: 'workflow.run.read',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 3,
        },
      });
    assert.equal(workflowRunInspection.found, true);
    assert.equal(workflowRunInspection.run.status, 'running');
    assert.equal(workflowRunInspection.stepCount, 1);
    assert.equal(workflowRunInspection.stepStatusCounts.ready, 1);
    assert.equal(
      Object.values(workflowRunInspection.stepStatusCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      workflowRunInspection.stepCount,
    );
    const maskedWorkflowRunInspection =
      await workflowRunInspections.inspectRunAuthorized({
        projectId: fixture.projectId,
        packageName: 'missing-package',
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000093',
          requestId: 'ha-workflow-run-inspection-masked',
          operationId: 'workflow.run.read',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 4,
        },
      });
    assert.equal(maskedWorkflowRunInspection.found, false);
    const workflowRunLists =
      new PostgresAuthorizedPluginPackageWorkflowRunListRepository(
        runtimeDatabase.pool,
      );
    const workflowRunList = await workflowRunLists.listRunsAuthorized({
      projectId: fixture.projectId,
      packageName: fixture.packageName,
      workflowId: workflowPlan.target.workflowId,
      limit: 1,
      after: null,
      actor: workflowActor,
      fence: workflowAuthorizationFence,
      audit: {
        eventId: '018f0000-0000-4000-8000-000000000101',
        requestId: 'ha-workflow-run-list-primary',
        operationId: 'workflow.run.list',
        projectId: fixture.projectId,
        subject: workflowActor,
        authenticationId: 'api_credential:ha-workflow-product:1',
        outcome: 'allowed',
        reasons: ['project_policy_allowed'],
        fence: workflowAuthorizationFence,
        occurredAtMs: workflowPlan.plannedAtMs + 9,
      },
    });
    assert.equal(workflowRunList.runs.length, 1);
    assert.equal(workflowRunList.runs[0].runId, workflowPlan.runId);
    assert.equal(workflowRunList.truncated, false);
    assert.equal(workflowRunList.next, null);
    assert.deepEqual(Object.keys(workflowRunList.runs[0]).sort(), [
      'admittedAtMs',
      'cancelReason',
      'cancelRequestedAtMs',
      'eventSequence',
      'finishedAtMs',
      'queuedAtMs',
      'runId',
      'startedAtMs',
      'status',
      'stepCount',
      'version',
    ]);
    for (const forbidden of [
      'planDigest',
      'receiptDigest',
      'definitionDigest',
      'inputRef',
      'errorSummary',
      'leaseOwner',
    ]) {
      assert.equal(JSON.stringify(workflowRunList).includes(forbidden), false);
    }
    const maskedWorkflowRunList = await workflowRunLists.listRunsAuthorized({
      projectId: fixture.projectId,
      packageName: 'missing-package',
      workflowId: workflowPlan.target.workflowId,
      limit: 1,
      after: null,
      actor: workflowActor,
      fence: workflowAuthorizationFence,
      audit: {
        eventId: '018f0000-0000-4000-8000-000000000102',
        requestId: 'ha-workflow-run-list-masked',
        operationId: 'workflow.run.list',
        projectId: fixture.projectId,
        subject: workflowActor,
        authenticationId: 'api_credential:ha-workflow-product:1',
        outcome: 'allowed',
        reasons: ['project_policy_allowed'],
        fence: workflowAuthorizationFence,
        occurredAtMs: workflowPlan.plannedAtMs + 10,
      },
    });
    assert.deepEqual(maskedWorkflowRunList.runs, []);
    assert.equal(maskedWorkflowRunList.truncated, false);
    assert.equal(maskedWorkflowRunList.next, null);
    const workflowStepRunLists =
      new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(
        runtimeDatabase.pool,
      );
    const workflowStepRunList =
      await workflowStepRunLists.listStepRunsAuthorized({
        projectId: fixture.projectId,
        packageName: fixture.packageName,
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        limit: 1,
        after: null,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000095',
          requestId: 'ha-workflow-step-list-primary',
          operationId: 'workflow.step.list',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 5,
        },
      });
    assert.equal(workflowStepRunList.found, true);
    assert.equal(workflowStepRunList.stepRuns.length, 1);
    assert.equal(workflowStepRunList.stepRuns[0].stepKey, 'run');
    assert.equal(workflowStepRunList.stepRuns[0].status, 'ready');
    assert.equal(workflowStepRunList.truncated, false);
    assert.equal(workflowStepRunList.next, null);
    for (const forbidden of [
      'definitionRef',
      'definitionDigest',
      'inputRef',
      'outputRef',
      'approvalRequestId',
      'errorSummary',
      'lastMutationId',
      'stepRunDigest',
    ]) {
      assert.equal(
        JSON.stringify(workflowStepRunList).includes(forbidden),
        false,
      );
    }
    const maskedWorkflowStepRunList =
      await workflowStepRunLists.listStepRunsAuthorized({
        projectId: fixture.projectId,
        packageName: 'missing-package',
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        limit: 1,
        after: null,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000096',
          requestId: 'ha-workflow-step-list-masked',
          operationId: 'workflow.step.list',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 6,
        },
      });
    assert.equal(maskedWorkflowStepRunList.found, false);
    const workflowRunEventLists =
      new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
        runtimeDatabase.pool,
      );
    const workflowRunEventList =
      await workflowRunEventLists.listRunEventsAuthorized({
        projectId: fixture.projectId,
        packageName: fixture.packageName,
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        limit: 64,
        afterSequence: 0,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000098',
          requestId: 'ha-workflow-event-list-primary',
          operationId: 'workflow.event.list',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 7,
        },
      });
    assert.equal(workflowRunEventList.found, true);
    assert.ok(workflowRunEventList.events.length > 0);
    assert.equal(workflowRunEventList.truncated, false);
    assert.equal(workflowRunEventList.nextAfterSequence, null);
    assert.equal(
      workflowRunEventList.events.at(-1).sequence,
      workflowRunEventList.headSequence,
    );
    assert.deepEqual(Object.keys(workflowRunEventList.events[0]).sort(), [
      'createdAtMs',
      'id',
      'sequence',
      'stepRunId',
      'type',
    ]);
    for (const forbidden of [
      'payload',
      'dedupeKey',
      'actorId',
      'attemptId',
      'errorSummary',
      'inputRef',
      'outputRef',
    ]) {
      assert.equal(
        JSON.stringify(workflowRunEventList).includes(forbidden),
        false,
      );
    }
    const maskedWorkflowRunEventList =
      await workflowRunEventLists.listRunEventsAuthorized({
        projectId: fixture.projectId,
        packageName: 'missing-package',
        workflowId: workflowPlan.target.workflowId,
        runId: workflowPlan.runId,
        limit: 64,
        afterSequence: 0,
        actor: workflowActor,
        fence: workflowAuthorizationFence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000099',
          requestId: 'ha-workflow-event-list-masked',
          operationId: 'workflow.event.list',
          projectId: fixture.projectId,
          subject: workflowActor,
          authenticationId: 'api_credential:ha-workflow-product:1',
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: workflowAuthorizationFence,
          occurredAtMs: workflowPlan.plannedAtMs + 8,
        },
      });
    assert.equal(maskedWorkflowRunEventList.found, false);
    const workflowTaskAttemptPlan = createPluginPackageWorkflowExecutionPlan({
      planId: 'ha-wta-plan-001',
      runId: 'ha-wta-run-001',
      workflowId: 'ha-daily',
      stepRunIds: {
        run: 'ha-wta-step-001',
      },
      publication: initialAutomationPublication,
      revision: fixture.revision,
      taskSpecSemanticRegistry: fixture.registry,
      plannedAtMs: active.updatedAtMs + 2,
    });
    const workflowTaskAttemptWorkflow = await workflowAdmissionRepository.admit(
      workflowTaskAttemptPlan,
    );
    assert.equal(workflowTaskAttemptWorkflow.status, 'created');
    const workflowTaskAttemptRepository =
      new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
        runtimeDatabase.pool,
      );
    const workflowTaskAttemptStep = workflowTaskAttemptPlan.steps.find(
      ({ stepKey }) => stepKey === 'run',
    );
    assert.ok(workflowTaskAttemptStep);
    const workflowTaskAttempt = await workflowTaskAttemptRepository.admit(
      workflowTaskAttemptPlan.runId,
      workflowTaskAttemptStep.stepRunId,
    );
    assert.equal(workflowTaskAttempt.status, 'created');
    assert.equal(workflowTaskAttempt.receipt.executorType, 'remote_worker');
    assert.deepEqual(
      await workflowTaskAttemptRepository.admit(
        workflowTaskAttemptPlan.runId,
        workflowTaskAttemptStep.stepRunId,
      ),
      {
        status: 'existing',
        receipt: workflowTaskAttempt.receipt,
      },
    );
    const remoteWorkflowCancellation =
      await runRemoteWorkflowCancellationMatrix({
        primaryPort,
        runtimePool: runtimeDatabase.pool,
        standbyDatabase,
        publication: initialAutomationPublication,
        revision: fixture.revision,
        taskSpecSemanticRegistry: fixture.registry,
        plannedAtMs: active.updatedAtMs + 3,
      });
    const workflowStepRepository = new PostgresStepRunRepository(
      runtimeDatabase.pool,
    );
    const workflowStep = await workflowStepRepository.findByRunAndStepKey(
      workflowPlan.runId,
      'run',
    );
    assert.ok(workflowStep);
    const workflowStepRunning = await workflowStepRepository.apply(
      transitionStepRunMutation(
        workflowStep,
        {
          expectedVersion: workflowStep.version,
          expectedDigest: workflowStep.stepRunDigest,
          mutationId: 'ha-wf-step-running-mutation-001',
          to: 'running',
          atMs: workflowPlan.plannedAtMs + 1,
        },
        {
          expectedRunVersion: workflowAdmission.receipt.finalRunVersion,
          expectedRunEventSequence:
            workflowAdmission.receipt.finalRunEventSequence,
          eventId: 'ha-wf-step-running-event-001',
          dedupeKey: 'ha-wf-step-running-event-001',
          actor: { type: 'executor' },
        },
      ),
    );
    assert.equal(workflowStepRunning.status, 'applied');
    const workflowStepSucceeded = await workflowStepRepository.apply(
      transitionStepRunMutation(
        workflowStepRunning.stepRun,
        {
          expectedVersion: workflowStepRunning.stepRun.version,
          expectedDigest: workflowStepRunning.stepRun.stepRunDigest,
          mutationId: 'ha-wf-step-success-mutation-001',
          to: 'succeeded',
          atMs: workflowPlan.plannedAtMs + 2,
        },
        {
          expectedRunVersion: workflowStepRunning.runVersion,
          expectedRunEventSequence: workflowStepRunning.runEventSequence,
          eventId: 'ha-wf-step-success-event-001',
          dedupeKey: 'ha-wf-step-success-event-001',
          actor: { type: 'executor' },
        },
      ),
    );
    assert.equal(workflowStepSucceeded.status, 'applied');
    const workflowFrontierRepository =
      new PostgresPluginPackageWorkflowFrontierRepository(runtimeDatabase.pool);
    assert.deepEqual(
      await workflowFrontierRepository.listCandidates({ limit: 1 }),
      {
        candidates: [
          {
            runId: workflowPlan.runId,
            planDigest: workflowPlan.planDigest,
            admittedAtMs: workflowPlan.plannedAtMs,
          },
        ],
        truncated: false,
      },
    );
    const workflowTerminal = await workflowFrontierRepository.advance(
      workflowPlan.runId,
    );
    assert.equal(workflowTerminal.status, 'terminal');
    assert.equal(workflowTerminal.stepMutationCount, 0);
    assert.equal(workflowTerminal.terminalStatus, 'succeeded');
    assert.equal(workflowTerminal.runVersion, 5);
    assert.equal(
      (await workflowFrontierRepository.advance(workflowPlan.runId)).status,
      'settled',
    );
    assert.deepEqual(
      await workflowFrontierRepository.listCandidates({ limit: 1 }),
      { candidates: [], truncated: false },
    );
    assert.deepEqual(
      await authorizedWorkflowAdmissionRepository.admitAuthorized(
        workflowAuthorizedAdmission,
      ),
      {
        status: 'existing',
        receipt: workflowAdmission.receipt,
      },
    );
    const publication =
      await new ProjectToolDefinitionSnapshotPublicationCoordinator({
        source: snapshotRepository,
        materializedRepository,
        repository: snapshotRepository,
        taskSpecSemanticRegistry: fixture.registry,
        pageSize: 4,
      }).publishCurrent(fixture.projectId);
    assert.equal(publication.status, 'created');
    assert.equal(publication.record.snapshot.sources.length, 1);
    assert.equal(publication.record.snapshot.definitions.length, 1);

    const taskItem = reconciliation.receipt.items.find(({ taskId }) =>
      taskId.endsWith(':alpha'),
    );
    assert.ok(taskItem);
    const taskRevision = `qltd:v1:${taskItem.revision}:${taskItem.contentDigest}`;
    const definition = publication.record.snapshot.definitions[0];
    const definitionRef = `tool:${definition.definition.name}@${definition.definition.version}`;
    const fenceBefore = await runtimeDatabase.pool.query(
      `SELECT
         "ql3"."plugin_package_run_start_allowed"(
           $1, $2, $3
         ) AS "runAllowed",
         "ql3"."plugin_package_tool_start_allowed"(
           $1, $4, $5::char(64)
         ) AS "toolAllowed"`,
      [
        fixture.projectId,
        taskItem.taskId,
        taskRevision,
        definitionRef,
        definition.definitionDigest,
      ],
    );
    assert.deepEqual(fenceBefore.rows, [
      { runAllowed: true, toolAllowed: true },
    ]);

    const lifecycleManagerDatabase = await databaseOpener(
      'package-manager',
      databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, primaryPort),
      'ql3-ha-package-lifecycle-manager',
    )();
    let lifecycle;
    try {
      lifecycle = await runPluginPackageLifecycleRoundTrip({
        primaryPort,
        managerPool: lifecycleManagerDatabase.pool,
        packagePool: packageDatabase.pool,
        runtimePool: runtimeDatabase.pool,
        standbyDatabase,
        fixture,
        task: {
          taskId: taskItem.taskId,
          taskRevision,
        },
        tool: {
          definitionRef,
          definitionDigest: definition.definitionDigest,
        },
        snapshots: snapshotRepository,
      });
    } finally {
      await lifecycleManagerDatabase.close();
    }
    assert.equal(
      await automationStartGuard.isStartAllowed(
        fixture.projectId,
        fixture.packageName,
        initialAutomationPublication.publicationDigest,
      ),
      false,
    );
    assert.equal(
      await automationStartGuard.isStartAllowed(
        fixture.projectId,
        fixture.packageName,
        lifecycle.automationPublication.publicationDigest,
      ),
      true,
    );
    const aiMaintenanceDatabase = await databaseOpener(
      'ai-maintenance',
      databaseUrl(AI_MAINTENANCE_USER, AI_MAINTENANCE_PASSWORD, primaryPort),
      'ql3-ha-ai-prompt-output-maintenance',
    )();
    let promptExecution;
    try {
      promptExecution = await runPluginPackagePromptHaEvidence({
        runtimePool: runtimeDatabase.pool,
        maintenancePool: aiMaintenanceDatabase.pool,
        auditPool: migrationPool,
        standbyPool: standbyDatabase.pool,
        publication: lifecycle.automationPublication,
      });
    } finally {
      await aiMaintenanceDatabase.close();
    }
    const fencedWorkflowPlan = createPluginPackageWorkflowExecutionPlan({
      planId: 'ha-workflow-admission-plan-fenced',
      runId: 'ha-workflow-admission-run-fenced',
      workflowId: 'ha-daily',
      stepRunIds: {
        run: 'ha-workflow-admission-step-run-fenced',
      },
      publication: lifecycle.automationPublication,
      revision: fixture.revision,
      taskSpecSemanticRegistry: fixture.registry,
      plannedAtMs: active.updatedAtMs + 2,
    });

    const managerDatabase = await databaseOpener(
      'package-manager',
      databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, primaryPort),
      'ql3-ha-publisher-trust-manager',
    )();
    let proposal;
    let approval;
    try {
      const management =
        createClusterPluginPackagePublisherTrustManagementService({
          pool: managerDatabase.pool,
          authorityProjectId: 'ha-publisher-trust-authority',
          trustAuthorityId: 'cluster',
          now: () => proposalAtMs,
        });
      const proposed = await management.propose({
        actionRef:
          'publisher-revoke:packages.contract.qinglong.dev:contract-key-1',
        approvalRequestId: 'approval-ha-publisher-revocation',
        proposalAuditEventId: '31000000-0000-4000-8000-000000000001',
        approvalAuditEventId: '31000000-0000-4000-8000-000000000002',
        publisher: 'packages.contract.qinglong.dev',
        keyId: 'contract-key-1',
        authorizationMode: 'dual_control',
        reasonCode: 'confirmed_key_compromise',
        requestedAtMs: proposalAtMs,
        principal: {
          subject: { type: 'user', id: 'ha-owner-a' },
          authenticationId: 'ha-publisher-proposer-auth',
          authenticatedAtMs: proposalAtMs - 1,
          expiresAtMs: proposalAtMs + 60_000,
          assurance: 'multi_factor',
        },
      });
      assert.equal(proposed.proposalStatus, 'created');
      assert.equal(proposed.approvalStatus, 'created');
      proposal = proposed.proposal;
      const decided = await new PostgresApprovalRequestRepository(
        managerDatabase.pool,
      ).decide({
        requestId: proposed.approvalRequest.id,
        expectedVersion: proposed.approvalRequest.version,
        decisionId: 'decision-ha-publisher-revocation',
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: {
          subject: { type: 'user', id: 'ha-owner-b' },
          authenticationId: 'ha-publisher-reviewer-auth',
          authenticatedAtMs: proposalAtMs,
          expiresAtMs: proposalAtMs + 60_000,
          assurance: 'multi_factor',
        },
        decidedAtMs: proposalAtMs + 1,
        authorizationFence: {
          projectVersion: 1,
          bindingVersion: 1,
        },
        audit: {
          eventId: '31000000-0000-4000-8000-000000000003',
          requestId: proposed.approvalRequest.id,
          operationId: 'approval.decide',
          projectId: 'ha-publisher-trust-authority',
          subject: { type: 'user', id: 'ha-owner-b' },
          authenticationId: 'ha-publisher-reviewer-auth',
          outcome: 'allowed',
          reasons: ['publisher_revocation_review'],
          fence: { projectVersion: 1, bindingVersion: 1 },
          occurredAtMs: proposalAtMs + 1,
        },
      });
      assert.equal(decided.status, 'decided');
      approval = decided.request;
    } finally {
      await managerDatabase.close();
    }
    const executor = await runClusterPluginPackageExecutorProcess({
      environment: {
        QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'true',
        QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'ha_package_executor',
        QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE: '4',
        QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE: '4',
        QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '2',
        QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS: '600000',
        QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '16',
        QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES: '16',
        QL3_POSTGRES_PACKAGE_EXECUTOR_URL: databaseUrl(
          PACKAGE_EXECUTOR_USER,
          PACKAGE_EXECUTOR_PASSWORD,
          primaryPort,
        ),
        QL3_POSTGRES_TLS_MODE: 'disable',
        QL3_POSTGRES_ALLOW_INSECURE: 'true',
      },
      openDatabase: async () => ({
        pool: packageDatabase.pool,
        close: async () => undefined,
      }),
      now: () => executionAtMs,
    });
    assert.equal(executor.status, 'completed');
    assert.equal(executor.batches[0].approvals.consumed, 1);
    assert.equal(executor.batches[0].dispatch.succeeded, 1);
    assert.equal(executor.batches.at(-1).dispatch.scanned, 0);
    const storedRevocation = await migrationPool.query(
      `SELECT receipt.receipt_json AS "receipt",
              impact.impact_json AS "impact",
              head.generation AS "trustGeneration"
         FROM "ql3"."plugin_package_publisher_revocation_receipts"
           AS receipt
         JOIN "ql3"."plugin_package_publisher_revocation_impacts" AS impact
           ON impact.revocation_receipt_digest = receipt.receipt_digest
         JOIN "ql3"."plugin_package_publisher_trust_heads" AS head
           ON head.authority_id = 'cluster'
        WHERE receipt.publisher = 'packages.contract.qinglong.dev'
          AND receipt.key_id = 'contract-key-1'`,
    );
    assert.equal(storedRevocation.rowCount, 1);
    assert.equal(storedRevocation.rows[0].trustGeneration, 2);
    const revocationReceipt = storedRevocation.rows[0].receipt;
    const revocation = {
      status: 'created',
      impact: storedRevocation.rows[0].impact,
    };
    assert.equal(revocationReceipt.mutationId.startsWith('pprd-'), true);
    assert.equal(revocationReceipt.receiptDigest.length, 64);
    assert.equal(
      revocationReceipt.previousTrustDigest,
      trustSnapshot.snapshotDigest,
    );
    assert.equal(
      revocationReceipt.currentTrustDigest,
      proposal.actionInput.currentTrustDigest,
    );
    assert.equal(approval.state, 'approved');
    assert.equal(revocation.impact.items.length, 1);
    assert.equal(
      revocation.impact.items[0].installationId,
      active.installationId,
    );
    assert.equal(
      await automationStartGuard.isStartAllowed(
        fixture.projectId,
        fixture.packageName,
        lifecycle.automationPublication.publicationDigest,
      ),
      false,
    );
    await assert.rejects(
      workflowAdmissionRepository.admit(fencedWorkflowPlan),
      PluginPackageWorkflowAdmissionNotAllowedError,
    );
    assert.deepEqual(await workflowAdmissionRepository.admit(workflowPlan), {
      status: 'existing',
      receipt: workflowAdmission.receipt,
    });
    const fenceAfterReceipt = await runtimeDatabase.pool.query(
      `SELECT
         "ql3"."plugin_package_run_start_allowed"(
           $1, $2, $3
         ) AS "runAllowed",
         "ql3"."plugin_package_tool_start_allowed"(
           $1, $4, $5::char(64)
         ) AS "toolAllowed"`,
      [
        fixture.projectId,
        taskItem.taskId,
        taskRevision,
        definitionRef,
        definition.definitionDigest,
      ],
    );
    assert.deepEqual(fenceAfterReceipt.rows, [
      { runAllowed: false, toolAllowed: false },
    ]);
    assert.deepEqual(
      await snapshotRepository.listActiveSourcePage({
        projectId: fixture.projectId,
        limit: 4,
      }),
      { sources: [], truncated: false },
    );
    const pendingAfterReceipt = await snapshotRepository.listPendingProjectPage(
      { limit: 16 },
    );
    assert.equal(
      pendingAfterReceipt.projectIds.includes(fixture.projectId),
      false,
    );
    const event = createPluginPackageQuarantineEvent({
      mutationId: pluginPackageQuarantineMutationId(
        revocationReceipt.receiptDigest,
        {
          projectId: active.projectId,
          packageName: active.packageName,
          installationId: active.installationId,
          lockDigest: active.lockDigest,
          installState: active.state,
          installVersion: active.version,
          installRecordDigest: active.recordDigest,
          activeLockDigest: active.activeLockDigest,
        },
      ),
      revocationReceiptDigest: revocationReceipt.receiptDigest,
      impactDigest: revocation.impact.impactDigest,
      target: {
        projectId: active.projectId,
        packageName: active.packageName,
        installationId: active.installationId,
        lockDigest: active.lockDigest,
        installState: active.state,
        installVersion: active.version,
        installRecordDigest: active.recordDigest,
        activeLockDigest: active.activeLockDigest,
      },
      proposer: { type: 'user', id: 'ha-owner-a' },
      confirmer: { type: 'user', id: 'ha-owner-b' },
      authorizationMode: 'dual_control',
      reasonCode: 'confirmed_key_compromise',
      occurredAtMs: revocationReceipt.revokedAtMs,
    });
    const quarantineRepository = new PostgresPluginPackageQuarantineRepository(
      packageDatabase.pool,
      { registry: fixture.registry },
    );
    assert.deepEqual(
      await quarantineRepository.findTargetsByLockDigest(active.lockDigest),
      [event.target],
    );

    let authorizationChecks = 0;
    const responseLossResult =
      await new PostgresPluginPackageQuarantineRepository(
        commitFaultPool.repositoryPool,
        { registry: fixture.registry },
      ).quarantine(event, () => {
        authorizationChecks += 1;
      });
    assert.equal(responseLossResult.status, 'existing');
    assert.equal(authorizationChecks, 4);
    assertCredentialFault(commitFault);
    assert.equal(responseLossResult.receipt.capability.status, 'withdrawn');
    assert.equal(
      responseLossResult.receipt.capability.taskWithdrawals.length,
      2,
    );
    assert.equal(responseLossResult.receipt.capability.retainedSourceCount, 0);
    const replay = await quarantineRepository.quarantine(event, () => {});
    assert.equal(replay.status, 'existing');
    assert.deepEqual(replay.receipt, responseLossResult.receipt);
    const currentInstallation =
      await installationInventoryRepository.findCurrent(
        fixture.projectId,
        fixture.packageName,
      );
    assert.ok(currentInstallation);
    assert.equal(
      currentInstallation.record.installationId,
      active.installationId,
    );
    assert.equal(currentInstallation.record.lockDigest, active.lockDigest);
    assert.deepEqual(currentInstallation.quarantine, {
      eventDigest: event.eventDigest,
      reasonCode: event.reasonCode,
      authorizationMode: event.authorizationMode,
      occurredAtMs: event.occurredAtMs,
      capabilityStatus: responseLossResult.receipt.capability.status,
      receiptDigest: responseLossResult.receipt.receiptDigest,
      committedAtMs: responseLossResult.receipt.committedAtMs,
    });
    const currentInstallationPage =
      await installationInventoryRepository.listCurrentPage({
        projectId: fixture.projectId,
        limit: 1,
      });
    assert.deepEqual(currentInstallationPage, {
      items: [currentInstallation],
      truncated: false,
    });

    let runtimeTablesDenied = false;
    try {
      await runtimeDatabase.pool.query(
        `SELECT event_digest
           FROM "ql3"."plugin_package_quarantine_events"
          LIMIT 1`,
      );
    } catch (error) {
      assert.equal(error?.code, '42501');
      runtimeTablesDenied = true;
    }
    assert.equal(runtimeTablesDenied, true);
    const fenceAfter = await runtimeDatabase.pool.query(
      `SELECT
         "ql3"."plugin_package_run_start_allowed"(
           $1, $2, $3
         ) AS "runAllowed",
         "ql3"."plugin_package_tool_start_allowed"(
           $1, $4, $5::char(64)
         ) AS "toolAllowed"`,
      [
        fixture.projectId,
        taskItem.taskId,
        taskRevision,
        definitionRef,
        definition.definitionDigest,
      ],
    );
    assert.deepEqual(fenceAfter.rows, [
      { runAllowed: false, toolAllowed: false },
    ]);
    assert.equal(
      await automationStartGuard.isStartAllowed(
        fixture.projectId,
        fixture.packageName,
        lifecycle.automationPublication.publicationDigest,
      ),
      false,
    );
    const currentSnapshot = await snapshotRepository.findCurrent(
      fixture.projectId,
    );
    assert.ok(currentSnapshot);
    assert.equal(
      currentSnapshot.snapshot.snapshotDigest,
      responseLossResult.receipt.capability.currentToolSnapshotDigest,
    );
    assert.deepEqual(currentSnapshot.snapshot.sources, []);
    assert.deepEqual(currentSnapshot.snapshot.definitions, []);

    await waitFor(async () => {
      const result = await standbyDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_quarantine_events"
             WHERE event_digest = $1) AS "eventCount",
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_withdrawal_receipts"
             WHERE event_digest = $1) AS "receiptCount",
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_withdrawal_tasks"
             WHERE event_digest = $1) AS "taskCount",
           (SELECT count(*)::integer
              FROM "ql3"."task_definitions" AS head
              JOIN "ql3"."task_definition_revisions" AS revision
                ON revision.project_id = head.project_id
               AND revision.task_id = head.task_id
               AND revision.revision = head.current_revision
             WHERE head.project_id = $2 AND revision.enabled = false)
             AS "disabledTasks",
           (SELECT count(*)::integer
              FROM "ql3"."project_tool_definition_snapshot_sources"
             WHERE project_id = $2 AND active_vector_digest = $3)
             AS "retainedSources",
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_workflow_admissions"
             WHERE plan_digest = $4) AS "workflowAdmissions",
           (SELECT count(*)::integer
              FROM "ql3"."run_events"
             WHERE run_id = $5) AS "workflowEvents",
           (SELECT count(*)::integer
              FROM "ql3"."step_run_mutations"
             WHERE run_id = $5) AS "workflowStepMutations",
           (SELECT count(*)::integer
              FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
             WHERE receipt_digest = $6) AS "workflowTaskAttempts",
           (SELECT count(*)::integer
              FROM "ql3"."run_attempts"
             WHERE id = $7 AND run_id = $8
               AND step_run_id = $9
               AND status = 'claimed'
               AND executor_type = 'remote_worker')
             AS "workflowTaskClaimedAttempts",
           (SELECT count(*)::integer
              FROM "ql3"."security_audit_events"
             WHERE event_id = $10::uuid
               AND operation_id = 'workflow.start'
               AND outcome = 'allowed') AS "workflowMutationAudits",
           (SELECT count(*)::integer
              FROM "ql3"."security_audit_events"
             WHERE operation_id = 'workflow.run.read'
               AND request_id IN (
                 'ha-workflow-run-inspection-primary',
                 'ha-workflow-run-inspection-masked'
               )
               AND outcome = 'allowed') AS "workflowReadAudits"`,
        [
          event.eventDigest,
          fixture.projectId,
          responseLossResult.receipt.capability.currentActiveVectorDigest,
          workflowPlan.planDigest,
          workflowPlan.runId,
          workflowTaskAttempt.receipt.receiptDigest,
          workflowTaskAttempt.receipt.attemptId,
          workflowTaskAttemptPlan.runId,
          workflowTaskAttemptStep.stepRunId,
          workflowPlan.planId,
        ],
      );
      const row = result.rows[0];
      return row?.eventCount === 1 &&
        row?.receiptCount === 1 &&
        row?.taskCount === 2 &&
        row?.disabledTasks === 2 &&
        row?.retainedSources === 0 &&
        row?.workflowAdmissions === 1 &&
        row?.workflowEvents === 5 &&
        row?.workflowStepMutations === 3 &&
        row?.workflowTaskAttempts === 1 &&
        row?.workflowTaskClaimedAttempts === 1 &&
        row?.workflowMutationAudits === 1 &&
        row?.workflowReadAudits === 2
        ? row
        : null;
    }, 'Plugin Package quarantine WAL replay');

    return {
      lifecycle,
      promptExecution,
      workflowAdmission: {
        plan: workflowPlan,
        receipt: workflowAdmission.receipt,
        authorizedAdmission: workflowAuthorizedAdmission,
      },
      workflowTaskAttempt: {
        plan: workflowTaskAttemptPlan,
        receipt: workflowTaskAttempt.receipt,
        report: {
          projectId: fixture.projectId,
          packageName: fixture.packageName,
          runId: workflowTaskAttemptPlan.runId,
          stepRunId: workflowTaskAttemptStep.stepRunId,
          attemptId: workflowTaskAttempt.receipt.attemptId,
          receiptDigest: workflowTaskAttempt.receipt.receiptDigest,
          executorType: workflowTaskAttempt.receipt.executorType,
          createdAtomically: true,
          exactReplay: true,
          replicatedBeforePromotion: true,
          runtimeOnly: false,
          survivedPromotion: false,
        },
      },
      remoteWorkflowCancellation,
      event,
      receipt: responseLossResult.receipt,
      task: {
        taskId: taskItem.taskId,
        taskRevision,
      },
      tool: {
        definitionRef,
        definitionDigest: definition.definitionDigest,
      },
      report: {
        projectId: fixture.projectId,
        packageName: fixture.packageName,
        installationId: active.installationId,
        lockDigest: active.lockDigest,
        eventDigest: event.eventDigest,
        receiptDigest: responseLossResult.receipt.receiptDigest,
        revocationReceiptDigest: revocationReceipt.receiptDigest,
        impactDigest: revocation.impact.impactDigest,
        impactItems: revocation.impact.items.length,
        proposalDigest: proposal.proposalDigest,
        trustGeneration: 2,
        approvedActionExecuted: true,
        runStartAllowedAfterRevocationReceipt: false,
        toolStartAllowedAfterRevocationReceipt: false,
        automationStartAllowedBeforeRevocationReceipt: true,
        automationStartAllowedAfterRevocationReceipt: false,
        automationStartAllowedAfterQuarantine: false,
        taskWithdrawals:
          responseLossResult.receipt.capability.taskWithdrawals.length,
        retainedSources:
          responseLossResult.receipt.capability.retainedSourceCount,
        runStartAllowedBeforeQuarantine: true,
        runStartAllowedAfterQuarantine: false,
        toolStartAllowedBeforeQuarantine: true,
        toolStartAllowedAfterQuarantine: false,
        automationRecoverySourceConverged: true,
        automationStartGuardRuntimeOnly: false,
        automationStartFenceSurvivedPromotion: false,
        workflowAdmissionCreatedAtomically: true,
        workflowAuthorizedAdmissionAtomic: true,
        workflowAdmissionExactReplay: true,
        workflowAdmissionFencedAfterRevocation: true,
        workflowAdmissionRuntimeOnly: false,
        workflowAdmissionSurvivedPromotion: false,
        workflowAuthorizedAdmissionSurvivedPromotion: false,
        workflowRunInspectionAtomic: true,
        workflowRunInspectionMasksCrossTarget: true,
        workflowRunInspectionSurvivedPromotion: false,
        workflowRunListAtomic: true,
        workflowRunListMasksCrossTarget: true,
        workflowRunListSurvivedPromotion: false,
        workflowStepRunListAtomic: true,
        workflowStepRunListMasksCrossTarget: true,
        workflowStepRunListSurvivedPromotion: false,
        workflowRunEventListAtomic: true,
        workflowRunEventListMasksCrossTarget: true,
        workflowRunEventListSurvivedPromotion: false,
        workflowFrontierTerminalizedAtomically: true,
        workflowFrontierExactReplay: true,
        workflowFrontierSurvivedPromotion: false,
        runtimeTablesDenied,
        commitResponseLossConvergedExactlyOnce: true,
        inventoryAvailabilityBeforePromotion: 'quarantined',
        inventoryListedBeforePromotion: true,
        inventorySurvivedPromotion: false,
        replicatedBeforePromotion: true,
        survivedPromotion: false,
      },
    };
  } finally {
    await Promise.all([
      packageDatabase.close(),
      runtimeDatabase.close(),
      commitFaultPool.pool.end(),
    ]);
  }
}

async function runPublisherTrustTransitionMatrix(options) {
  const { primaryPort, migrationPool, standbyDatabase } = options;
  const authorityProjectId = 'ha-publisher-trust-transition';
  const trustAuthorityId = 'ha-publisher-trust-transition';
  const publisher = 'ha.publisher.qinglong.dev';
  const requester = { type: 'user', id: 'ha-trust-transition-owner' };
  const reviewer = { type: 'user', id: 'ha-trust-transition-reviewer' };
  const fence = { projectVersion: 1, bindingVersion: 1 };
  const baseTimeMs = Date.now();
  const oldPair = generateKeyPairSync('ed25519');
  const newPair = generateKeyPairSync('ed25519');
  const oldDefinition = {
    publisher,
    keyId: 'ha-key-old',
    publicKeyPem: oldPair.publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: baseTimeMs - 1_000,
    notAfterMs: baseTimeMs + 3_600_000,
  };
  const newDefinition = {
    publisher,
    keyId: 'ha-key-new',
    publicKeyPem: newPair.publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: baseTimeMs - 1_000,
    notAfterMs: baseTimeMs + 3_600_000,
  };
  const initialSnapshot = createPluginPackagePublisherTrustSnapshot([
    oldDefinition,
  ]);
  const overlapMaterialSnapshot = createPluginPackagePublisherTrustSnapshot([
    oldDefinition,
    newDefinition,
  ]);

  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, $1, $1, 'active', 1, $2, $2)`,
    [authorityProjectId, baseTimeMs],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES
       ($1, 'user', $2, 1, 'active', 'owner',
        'ha-trust-transition-owner-v1', 'system', 'ha-contract', $4),
       ($1, 'user', $3, 1, 'active', 'admin',
        'ha-trust-transition-reviewer-v1', 'system', 'ha-contract', $4)`,
    [authorityProjectId, requester.id, reviewer.id, baseTimeMs],
  );

  const managerDatabase = await databaseOpener(
    'package-manager',
    databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, primaryPort),
    'ql3-ha-trust-transition-manager',
  )();
  const executorDatabase = await databaseOpener(
    'package-executor',
    databaseUrl(PACKAGE_EXECUTOR_USER, PACKAGE_EXECUTOR_PASSWORD, primaryPort),
    'ql3-ha-trust-transition-executor',
  )();
  try {
    const observed =
      await new PostgresPluginPackagePublisherTrustAuthorityRepository(
        managerDatabase.pool,
      ).observeSnapshot({
        authorityId: trustAuthorityId,
        observedBy: 'ha-package-manager',
        observedAtMs: baseTimeMs,
        snapshot: initialSnapshot,
      });
    assert.equal(observed.status, 'created');

    const approveAndExecute = async ({
      ordinal,
      mode,
      keyId,
      materialSnapshot,
      requestedAtMs,
    }) => {
      const actionRef = `publisher-trust-${mode}:${publisher}:${keyId}`;
      const approvalRequestId = `approval-ha-trust-transition-${ordinal}`;
      const management =
        createClusterPluginPackagePublisherTrustManagementService({
          pool: managerDatabase.pool,
          authorityProjectId,
          trustAuthorityId,
          ...(materialSnapshot ? { materialSnapshot } : {}),
          now: () => requestedAtMs,
        });
      const proposed = await management.proposeTransition({
        actionRef,
        approvalRequestId,
        proposalAuditEventId: `32000000-0000-4000-8000-0000000000${ordinal}1`,
        approvalAuditEventId: `32000000-0000-4000-8000-0000000000${ordinal}2`,
        mode,
        publisher,
        keyId,
        requestedAtMs,
        principal: {
          subject: requester,
          authenticationId: `ha-trust-owner-auth-${ordinal}`,
          authenticatedAtMs: requestedAtMs - 1,
          expiresAtMs: requestedAtMs + 60_000,
          assurance: 'multi_factor',
        },
      });
      assert.equal(proposed.proposalStatus, 'created');
      assert.equal(proposed.approvalStatus, 'created');
      const decided = await new PostgresApprovalRequestRepository(
        managerDatabase.pool,
      ).decide({
        requestId: proposed.approvalRequest.id,
        expectedVersion: proposed.approvalRequest.version,
        decisionId: `decision-ha-trust-transition-${ordinal}`,
        decision: 'approved',
        reasonCode: 'reviewed',
        principal: {
          subject: reviewer,
          authenticationId: `ha-trust-reviewer-auth-${ordinal}`,
          authenticatedAtMs: requestedAtMs,
          expiresAtMs: requestedAtMs + 60_000,
          assurance: 'multi_factor',
        },
        decidedAtMs: requestedAtMs + 1,
        authorizationFence: fence,
        audit: {
          eventId: `32000000-0000-4000-8000-0000000000${ordinal}3`,
          requestId: proposed.approvalRequest.id,
          operationId: 'approval.decide',
          projectId: authorityProjectId,
          subject: reviewer,
          authenticationId: `ha-trust-reviewer-auth-${ordinal}`,
          outcome: 'allowed',
          reasons: ['publisher_trust_transition_approved'],
          fence,
          occurredAtMs: requestedAtMs + 1,
        },
      });
      assert.equal(decided.status, 'decided');
      const executed = await runClusterPluginPackageExecutorProcess({
        environment: {
          QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED: 'true',
          QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER: 'ha_trust_transition_executor',
          QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE: '4',
          QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE: '4',
          QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES: '2',
          QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS: '600000',
          QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE: '16',
          QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES: '16',
          QL3_POSTGRES_PACKAGE_EXECUTOR_URL: databaseUrl(
            PACKAGE_EXECUTOR_USER,
            PACKAGE_EXECUTOR_PASSWORD,
            primaryPort,
          ),
          QL3_POSTGRES_TLS_MODE: 'disable',
          QL3_POSTGRES_ALLOW_INSECURE: 'true',
        },
        openDatabase: async () => ({
          pool: executorDatabase.pool,
          close: async () => undefined,
        }),
        now: () => requestedAtMs + 2,
      });
      assert.equal(executed.status, 'completed');
      assert.equal(
        executed.batches.reduce(
          (total, batch) => total + batch.trustTransitionApprovals.consumed,
          0,
        ),
        1,
      );
      assert.equal(
        executed.batches.reduce(
          (total, batch) => total + batch.dispatch.succeeded,
          0,
        ),
        1,
      );
      return proposed.proposal;
    };

    const overlapProposal = await approveAndExecute({
      ordinal: 1,
      mode: 'overlap_add',
      keyId: newDefinition.keyId,
      materialSnapshot: overlapMaterialSnapshot,
      requestedAtMs: baseTimeMs + 10,
    });
    const overlapFacts = await executorDatabase.pool.query(
      `SELECT generation::integer AS generation
         FROM "ql3"."plugin_package_publisher_trust_heads"
        WHERE authority_id = $1`,
      [trustAuthorityId],
    );
    assert.deepEqual(overlapFacts.rows, [{ generation: 2 }]);

    const retirementProposal = await approveAndExecute({
      ordinal: 2,
      mode: 'safe_retire',
      keyId: oldDefinition.keyId,
      requestedAtMs: baseTimeMs + 20,
    });
    const finalFacts = await executorDatabase.pool.query(
      `SELECT head.generation::integer AS generation,
              head.effective_trust_digest AS "effectiveTrustDigest",
              (
                SELECT count(*)::integer
                  FROM "ql3"."plugin_package_publisher_trust_transition_proposals"
                 WHERE authority_id = $1
              ) AS "proposalCount",
              (
                SELECT count(*)::integer
                  FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
                 WHERE authority_id = $1
              ) AS "receiptCount",
              (
                SELECT count(*)::integer
                  FROM "ql3"."approved_action_executions" AS execution
                  JOIN "ql3"."approved_action_dispatches" AS dispatch
                    ON dispatch.dispatch_id = execution.dispatch_id
                 WHERE execution.project_id = $2
                   AND dispatch.action_type IN (
                     'plugin_package.publisher_key.overlap_add',
                     'plugin_package.publisher_key.safe_retire'
                   )
                   AND execution.status = 'succeeded'
              ) AS "executionCount"
         FROM "ql3"."plugin_package_publisher_trust_heads" AS head
        WHERE head.authority_id = $1`,
      [trustAuthorityId, authorityProjectId],
    );
    assert.deepEqual(finalFacts.rows, [
      {
        generation: 3,
        effectiveTrustDigest: retirementProposal.actionInput.currentTrustDigest,
        proposalCount: 2,
        receiptCount: 2,
        executionCount: 2,
      },
    ]);
    await waitFor(async () => {
      const result = await standbyDatabase.pool.query(
        `SELECT head.generation::integer AS generation,
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
      const row = result.rows[0];
      return row?.generation === 3 &&
        row?.effectiveTrustDigest ===
          retirementProposal.actionInput.currentTrustDigest &&
        row?.receiptCount === 2
        ? row
        : null;
    }, 'publisher trust transition WAL replay');

    return {
      authorityProjectId,
      trustAuthorityId,
      publisher,
      oldKeyId: oldDefinition.keyId,
      newKeyId: newDefinition.keyId,
      initialTrustDigest: initialSnapshot.snapshotDigest,
      overlapTrustDigest: overlapProposal.actionInput.currentTrustDigest,
      effectiveTrustDigest: retirementProposal.actionInput.currentTrustDigest,
      generations: [1, 2, 3],
      proposalCount: 2,
      receiptCount: 2,
      executionCount: 2,
      oldAndNewMaterialPredistributed: true,
      separationOfDutyApproved: true,
      replicatedBeforePromotion: true,
      survivedPromotion: false,
    };
  } finally {
    await Promise.all([managerDatabase.close(), executorDatabase.close()]);
  }
}

async function verifyPublisherTrustTransitionAfterPromotion(options) {
  const { promotedDatabase, transition } = options;
  const facts = await promotedDatabase.pool.query(
    `SELECT head.generation::integer AS generation,
            head.effective_trust_digest AS "effectiveTrustDigest",
            (
              SELECT count(*)::integer
                FROM "ql3"."plugin_package_publisher_trust_transition_proposals"
               WHERE authority_id = $1
            ) AS "proposalCount",
            (
              SELECT count(*)::integer
                FROM "ql3"."plugin_package_publisher_trust_transition_receipts"
               WHERE authority_id = $1
            ) AS "receiptCount",
            (
              SELECT count(*)::integer
                FROM "ql3"."approved_action_executions" AS execution
                JOIN "ql3"."approved_action_dispatches" AS dispatch
                  ON dispatch.dispatch_id = execution.dispatch_id
               WHERE execution.project_id = $2
                 AND dispatch.action_type IN (
                   'plugin_package.publisher_key.overlap_add',
                   'plugin_package.publisher_key.safe_retire'
                 )
                 AND execution.status = 'succeeded'
            ) AS "executionCount"
       FROM "ql3"."plugin_package_publisher_trust_heads" AS head
      WHERE head.authority_id = $1`,
    [transition.trustAuthorityId, transition.authorityProjectId],
  );
  assert.deepEqual(facts.rows, [
    {
      generation: 3,
      effectiveTrustDigest: transition.effectiveTrustDigest,
      proposalCount: 2,
      receiptCount: 2,
      executionCount: 2,
    },
  ]);
  transition.survivedPromotion = true;
}

async function verifyPluginPackageQuarantineAfterPromotion(options) {
  const { promotedPort, promotedDatabase, quarantine } = options;
  const packageDatabase = await databaseOpener(
    'package-executor',
    databaseUrl(PACKAGE_EXECUTOR_USER, PACKAGE_EXECUTOR_PASSWORD, promotedPort),
    'ql3-ha-package-quarantine-executor-promoted',
  )();
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-package-quarantine-runtime-promoted',
  )();
  try {
    const stored = await new PostgresPluginPackageQuarantineRepository(
      packageDatabase.pool,
    ).findByEventDigest(quarantine.event.eventDigest);
    assert.deepEqual(stored, quarantine.receipt);
    const installationInventoryRepository =
      new PostgresPluginPackageInstallRepository(packageDatabase.pool);
    const currentInstallation =
      await installationInventoryRepository.findCurrent(
        quarantine.report.projectId,
        quarantine.report.packageName,
      );
    assert.ok(currentInstallation);
    assert.equal(
      currentInstallation.record.installationId,
      quarantine.report.installationId,
    );
    assert.equal(
      currentInstallation.quarantine?.eventDigest,
      quarantine.event.eventDigest,
    );
    assert.equal(
      currentInstallation.quarantine?.receiptDigest,
      quarantine.receipt.receiptDigest,
    );
    const currentInstallationPage =
      await installationInventoryRepository.listCurrentPage({
        projectId: quarantine.report.projectId,
        limit: 1,
      });
    assert.deepEqual(currentInstallationPage, {
      items: [currentInstallation],
      truncated: false,
    });
    const fences = await runtimeDatabase.pool.query(
      `SELECT
         "ql3"."plugin_package_run_start_allowed"(
           $1, $2, $3
         ) AS "runAllowed",
         "ql3"."plugin_package_tool_start_allowed"(
           $1, $4, $5::char(64)
         ) AS "toolAllowed"`,
      [
        quarantine.report.projectId,
        quarantine.task.taskId,
        quarantine.task.taskRevision,
        quarantine.tool.definitionRef,
        quarantine.tool.definitionDigest,
      ],
    );
    assert.deepEqual(fences.rows, [{ runAllowed: false, toolAllowed: false }]);
    const automationStartGuard =
      new PostgresPluginPackageAutomationPublicationRepository(
        runtimeDatabase.pool,
      );
    assert.equal(
      await automationStartGuard.isStartAllowed(
        quarantine.report.projectId,
        quarantine.report.packageName,
        quarantine.lifecycle.automationPublication.publicationDigest,
      ),
      false,
    );
    const workflowAdmissions =
      new PostgresAuthorizedPluginPackageWorkflowAdmissionRepository(
        runtimeDatabase.pool,
      );
    assert.deepEqual(
      await new PostgresPluginPackageWorkflowAdmissionRepository(
        runtimeDatabase.pool,
      ).findByRunId(quarantine.workflowAdmission.plan.runId),
      quarantine.workflowAdmission.receipt,
    );
    assert.deepEqual(
      await workflowAdmissions.admitAuthorized(
        quarantine.workflowAdmission.authorizedAdmission,
      ),
      {
        status: 'existing',
        receipt: quarantine.workflowAdmission.receipt,
      },
    );
    const workflowFrontier =
      new PostgresPluginPackageWorkflowFrontierRepository(runtimeDatabase.pool);
    assert.deepEqual(await workflowFrontier.listCandidates({ limit: 1 }), {
      candidates: [],
      truncated: false,
    });
    const settledWorkflow = await workflowFrontier.advance(
      quarantine.workflowAdmission.plan.runId,
    );
    assert.equal(settledWorkflow.status, 'settled');
    assert.equal(settledWorkflow.terminalStatus, 'succeeded');
    const promotedWorkflowRunInspection =
      await new PostgresAuthorizedPluginPackageWorkflowRunInspectionRepository(
        runtimeDatabase.pool,
      ).inspectRunAuthorized({
        projectId: quarantine.workflowAdmission.plan.target.projectId,
        packageName: quarantine.workflowAdmission.plan.target.packageName,
        workflowId: quarantine.workflowAdmission.plan.target.workflowId,
        runId: quarantine.workflowAdmission.plan.runId,
        actor: quarantine.workflowAdmission.authorizedAdmission.actor,
        fence: quarantine.workflowAdmission.authorizedAdmission.fence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000094',
          requestId: 'ha-workflow-run-inspection-promoted',
          operationId: 'workflow.run.read',
          projectId: quarantine.workflowAdmission.plan.target.projectId,
          subject: quarantine.workflowAdmission.authorizedAdmission.actor,
          authenticationId:
            quarantine.workflowAdmission.authorizedAdmission.audit
              .authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: quarantine.workflowAdmission.authorizedAdmission.fence,
          occurredAtMs: quarantine.workflowAdmission.plan.plannedAtMs + 5,
        },
      });
    assert.equal(promotedWorkflowRunInspection.found, true);
    assert.equal(promotedWorkflowRunInspection.run.status, 'succeeded');
    assert.equal(promotedWorkflowRunInspection.stepCount, 1);
    assert.equal(promotedWorkflowRunInspection.stepStatusCounts.succeeded, 1);
    const promotedWorkflowRunList =
      await new PostgresAuthorizedPluginPackageWorkflowRunListRepository(
        runtimeDatabase.pool,
      ).listRunsAuthorized({
        projectId: quarantine.workflowAdmission.plan.target.projectId,
        packageName: quarantine.workflowAdmission.plan.target.packageName,
        workflowId: quarantine.workflowAdmission.plan.target.workflowId,
        limit: 64,
        after: null,
        actor: quarantine.workflowAdmission.authorizedAdmission.actor,
        fence: quarantine.workflowAdmission.authorizedAdmission.fence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000103',
          requestId: 'ha-workflow-run-list-promoted',
          operationId: 'workflow.run.list',
          projectId: quarantine.workflowAdmission.plan.target.projectId,
          subject: quarantine.workflowAdmission.authorizedAdmission.actor,
          authenticationId:
            quarantine.workflowAdmission.authorizedAdmission.audit
              .authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: quarantine.workflowAdmission.authorizedAdmission.fence,
          occurredAtMs: quarantine.workflowAdmission.plan.plannedAtMs + 9,
        },
      });
    assert.ok(promotedWorkflowRunList.runs.length >= 1);
    for (
      let index = 1;
      index < promotedWorkflowRunList.runs.length;
      index += 1
    ) {
      const previous = promotedWorkflowRunList.runs[index - 1];
      const current = promotedWorkflowRunList.runs[index];
      assert.ok(
        previous.admittedAtMs > current.admittedAtMs ||
          (previous.admittedAtMs === current.admittedAtMs &&
            previous.runId > current.runId),
      );
    }
    const promotedWorkflowRun = promotedWorkflowRunList.runs.find(
      (run) => run.runId === quarantine.workflowAdmission.plan.runId,
    );
    assert.ok(promotedWorkflowRun);
    assert.equal(promotedWorkflowRun.status, 'succeeded');
    assert.equal(promotedWorkflowRunList.truncated, false);
    assert.equal(promotedWorkflowRunList.next, null);
    const promotedWorkflowStepRunList =
      await new PostgresAuthorizedPluginPackageWorkflowStepRunListRepository(
        runtimeDatabase.pool,
      ).listStepRunsAuthorized({
        projectId: quarantine.workflowAdmission.plan.target.projectId,
        packageName: quarantine.workflowAdmission.plan.target.packageName,
        workflowId: quarantine.workflowAdmission.plan.target.workflowId,
        runId: quarantine.workflowAdmission.plan.runId,
        limit: 1,
        after: null,
        actor: quarantine.workflowAdmission.authorizedAdmission.actor,
        fence: quarantine.workflowAdmission.authorizedAdmission.fence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000097',
          requestId: 'ha-workflow-step-list-promoted',
          operationId: 'workflow.step.list',
          projectId: quarantine.workflowAdmission.plan.target.projectId,
          subject: quarantine.workflowAdmission.authorizedAdmission.actor,
          authenticationId:
            quarantine.workflowAdmission.authorizedAdmission.audit
              .authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: quarantine.workflowAdmission.authorizedAdmission.fence,
          occurredAtMs: quarantine.workflowAdmission.plan.plannedAtMs + 7,
        },
      });
    assert.equal(promotedWorkflowStepRunList.found, true);
    assert.equal(promotedWorkflowStepRunList.stepRuns.length, 1);
    assert.equal(promotedWorkflowStepRunList.stepRuns[0].status, 'succeeded');
    const promotedWorkflowRunEventList =
      await new PostgresAuthorizedPluginPackageWorkflowRunEventListRepository(
        runtimeDatabase.pool,
      ).listRunEventsAuthorized({
        projectId: quarantine.workflowAdmission.plan.target.projectId,
        packageName: quarantine.workflowAdmission.plan.target.packageName,
        workflowId: quarantine.workflowAdmission.plan.target.workflowId,
        runId: quarantine.workflowAdmission.plan.runId,
        limit: 64,
        afterSequence: 0,
        actor: quarantine.workflowAdmission.authorizedAdmission.actor,
        fence: quarantine.workflowAdmission.authorizedAdmission.fence,
        audit: {
          eventId: '018f0000-0000-4000-8000-000000000100',
          requestId: 'ha-workflow-event-list-promoted',
          operationId: 'workflow.event.list',
          projectId: quarantine.workflowAdmission.plan.target.projectId,
          subject: quarantine.workflowAdmission.authorizedAdmission.actor,
          authenticationId:
            quarantine.workflowAdmission.authorizedAdmission.audit
              .authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: quarantine.workflowAdmission.authorizedAdmission.fence,
          occurredAtMs: quarantine.workflowAdmission.plan.plannedAtMs + 8,
        },
      });
    assert.equal(promotedWorkflowRunEventList.found, true);
    assert.ok(promotedWorkflowRunEventList.events.length > 0);
    assert.equal(promotedWorkflowRunEventList.truncated, false);
    assert.equal(promotedWorkflowRunEventList.nextAfterSequence, null);
    assert.equal(
      promotedWorkflowRunEventList.events.at(-1).sequence,
      promotedWorkflowRunEventList.headSequence,
    );
    const workflowTaskAttempt =
      new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
        runtimeDatabase.pool,
      );
    assert.deepEqual(
      await workflowTaskAttempt.admit(
        quarantine.workflowTaskAttempt.plan.runId,
        quarantine.workflowTaskAttempt.report.stepRunId,
      ),
      {
        status: 'existing',
        receipt: quarantine.workflowTaskAttempt.receipt,
      },
    );
    const workflowTaskAttemptFacts = await runtimeDatabase.pool.query(
      `SELECT run.status AS "runStatus",
              step.status AS "stepStatus",
              attempt.status AS "attemptStatus",
              attempt.executor_type AS "executorType",
              admission.receipt_digest AS "receiptDigest"
         FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
           AS admission
         JOIN "ql3"."runs" AS run
           ON run.id = admission.run_id
         JOIN "ql3"."step_runs" AS step
           ON step.run_id = admission.run_id
          AND step.id = admission.step_run_id
         JOIN "ql3"."run_attempts" AS attempt
           ON attempt.run_id = admission.run_id
          AND attempt.id = admission.attempt_id
        WHERE admission.receipt_digest = $1`,
      [quarantine.workflowTaskAttempt.receipt.receiptDigest],
    );
    assert.deepEqual(workflowTaskAttemptFacts.rows, [
      {
        runStatus: 'running',
        stepStatus: 'ready',
        attemptStatus: 'claimed',
        executorType: 'remote_worker',
        receiptDigest: quarantine.workflowTaskAttempt.receipt.receiptDigest,
      },
    ]);
    let executorAutomationGuardDenied = false;
    try {
      await packageDatabase.pool.query(
        `SELECT "ql3"."plugin_package_automation_start_allowed"(
           $1::varchar, $2::varchar, $3::char(64)
         )`,
        [
          quarantine.report.projectId,
          quarantine.report.packageName,
          quarantine.lifecycle.automationPublication.publicationDigest,
        ],
      );
    } catch (error) {
      assert.equal(error?.code, '42501');
      executorAutomationGuardDenied = true;
    }
    assert.equal(executorAutomationGuardDenied, true);
    let executorWorkflowAdmissionDenied = false;
    try {
      await packageDatabase.pool.query(
        `SELECT plan_digest
           FROM "ql3"."plugin_package_workflow_admissions"
          LIMIT 1`,
      );
    } catch (error) {
      assert.equal(error?.code, '42501');
      executorWorkflowAdmissionDenied = true;
    }
    assert.equal(executorWorkflowAdmissionDenied, true);
    let executorWorkflowTaskAttemptDenied = false;
    try {
      await packageDatabase.pool.query(
        `SELECT receipt_digest
           FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
          LIMIT 1`,
      );
    } catch (error) {
      assert.equal(error?.code, '42501');
      executorWorkflowTaskAttemptDenied = true;
    }
    assert.equal(executorWorkflowTaskAttemptDenied, true);
    quarantine.report.automationStartGuardRuntimeOnly = true;
    quarantine.report.automationStartFenceSurvivedPromotion = true;
    quarantine.report.workflowAdmissionRuntimeOnly = true;
    quarantine.report.workflowAdmissionSurvivedPromotion = true;
    quarantine.report.workflowAuthorizedAdmissionSurvivedPromotion = true;
    quarantine.report.workflowRunInspectionSurvivedPromotion = true;
    quarantine.report.workflowRunListSurvivedPromotion = true;
    quarantine.report.workflowStepRunListSurvivedPromotion = true;
    quarantine.report.workflowRunEventListSurvivedPromotion = true;
    quarantine.report.workflowFrontierSurvivedPromotion = true;
    quarantine.workflowTaskAttempt.report.runtimeOnly = true;
    quarantine.workflowTaskAttempt.report.survivedPromotion = true;
  } finally {
    await Promise.all([packageDatabase.close(), runtimeDatabase.close()]);
  }
  const facts = await promotedDatabase.pool.query(
    `SELECT
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_quarantine_events"
         WHERE event_digest = $1) AS "eventCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_withdrawal_receipts"
         WHERE event_digest = $1) AS "receiptCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_withdrawal_tasks"
         WHERE event_digest = $1) AS "taskCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_publisher_revocation_receipts"
         WHERE receipt_digest = $2) AS "revocationReceiptCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_publisher_revocation_impacts"
         WHERE impact_digest = $3) AS "impactCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_publisher_revocation_impact_items"
         WHERE impact_digest = $3) AS "impactItemCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_publisher_revocation_proposals"
         WHERE proposal_digest = $4) AS "proposalCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_workflow_admissions"
         WHERE plan_digest = $5) AS "workflowAdmissionCount",
       (SELECT count(*)::integer
          FROM "ql3"."run_events"
         WHERE run_id = $6) AS "workflowEventCount",
       (SELECT count(*)::integer
          FROM "ql3"."step_run_mutations"
         WHERE run_id = $6) AS "workflowStepMutationCount",
       (SELECT generation::integer
          FROM "ql3"."plugin_package_publisher_trust_heads"
         WHERE authority_id = 'cluster') AS "trustGeneration",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_publisher_trust_snapshots" AS snapshot
         WHERE snapshot.snapshot_digest IN (
           SELECT receipt.previous_trust_digest
             FROM "ql3"."plugin_package_publisher_revocation_receipts"
               AS receipt
            WHERE receipt.receipt_digest = $2
           UNION
           SELECT receipt.current_trust_digest
             FROM "ql3"."plugin_package_publisher_revocation_receipts"
               AS receipt
            WHERE receipt.receipt_digest = $2
         ))
          AS "trustSnapshotCount"`,
    [
      quarantine.event.eventDigest,
      quarantine.report.revocationReceiptDigest,
      quarantine.report.impactDigest,
      quarantine.report.proposalDigest,
      quarantine.workflowAdmission.plan.planDigest,
      quarantine.workflowAdmission.plan.runId,
    ],
  );
  assert.deepEqual(facts.rows, [
    {
      eventCount: 1,
      receiptCount: 1,
      taskCount: 2,
      revocationReceiptCount: 1,
      impactCount: 1,
      impactItemCount: 1,
      proposalCount: 1,
      workflowAdmissionCount: 1,
      workflowEventCount: 5,
      workflowStepMutationCount: 3,
      trustGeneration: 2,
      trustSnapshotCount: 2,
    },
  ]);
  quarantine.report.inventorySurvivedPromotion = true;
  quarantine.report.survivedPromotion = true;
}

async function verifyPluginPackageLifecycleAfterPromotion(options) {
  const { promotedPort, promotedDatabase, lifecycle } = options;
  const packageDatabase = await databaseOpener(
    'package-executor',
    databaseUrl(PACKAGE_EXECUTOR_USER, PACKAGE_EXECUTOR_PASSWORD, promotedPort),
    'ql3-ha-package-lifecycle-executor-promoted',
  )();
  try {
    const repository = new PostgresPluginPackageLifecycleRepository(
      packageDatabase.pool,
    );
    const plans = new PostgresPluginPackageLifecyclePlanRepository(
      packageDatabase.pool,
    );
    const automations =
      new PostgresPluginPackageAutomationPublicationRepository(
        packageDatabase.pool,
      );
    for (const plan of lifecycle.managedPlans) {
      assert.deepEqual(await plans.findByActionRef(plan.actionRef), plan);
    }
    assert.deepEqual(
      await repository.findByEventDigest(lifecycle.disableEvent.eventDigest),
      lifecycle.disableReceipt,
    );
    assert.deepEqual(
      await repository.findByEventDigest(lifecycle.enableEvent.eventDigest),
      lifecycle.enableReceipt,
    );
    assert.deepEqual(
      await repository.findHead(
        lifecycle.report.projectId,
        lifecycle.report.packageName,
      ),
      lifecycle.enableReceipt.lifecycle,
    );
    assert.deepEqual(
      await automations.findCurrent(
        lifecycle.report.projectId,
        lifecycle.report.packageName,
      ),
      lifecycle.automationPublication,
    );
  } finally {
    await packageDatabase.close();
  }
  const facts = await promotedDatabase.pool.query(
    `SELECT
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_lifecycle_events"
         WHERE event_digest IN ($1, $2)) AS "eventCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_lifecycle_receipts"
         WHERE event_digest IN ($1, $2)) AS "receiptCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_lifecycle_tasks"
         WHERE event_digest IN ($1, $2)) AS "taskCount",
       (SELECT count(*)::integer
          FROM "ql3"."plugin_package_automation_publications"
         WHERE project_id = $3 AND package_name = $4)
         AS "automationPublicationCount",
       (SELECT state
          FROM "ql3"."plugin_package_automation_publication_heads"
         WHERE project_id = $3 AND package_name = $4)
         AS "automationState",
       (SELECT version
          FROM "ql3"."plugin_package_automation_publication_heads"
         WHERE project_id = $3 AND package_name = $4)
         AS "automationVersion",
       head.version,
       head.disposition
      FROM "ql3"."plugin_package_lifecycle_heads" AS head
     WHERE head.project_id = $3 AND head.package_name = $4`,
    [
      lifecycle.disableEvent.eventDigest,
      lifecycle.enableEvent.eventDigest,
      lifecycle.report.projectId,
      lifecycle.report.packageName,
    ],
  );
  assert.deepEqual(facts.rows, [
    {
      eventCount: 2,
      receiptCount: 2,
      taskCount: 4,
      automationPublicationCount: 5,
      automationState: 'active',
      automationVersion: 5,
      version: lifecycle.report.lifecycleVersion,
      disposition: 'active',
    },
  ]);
  lifecycle.report.automationPublicationSurvivedPromotion = true;
  lifecycle.report.survivedPromotion = true;
}

async function runAutomationManagementInspectionMatrix({
  primaryPort,
  migrationPool,
  standbyDatabase,
}) {
  const projectId = 'ha-automation-inspection';
  const actor = Object.freeze({ type: 'user', id: 'ha-automation-reader' });
  const fence = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
  const observed = await migrationPool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "observedAtMs"`,
  );
  const occurredAtMs = Number(observed.rows[0].observedAtMs);
  await migrationPool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, 'HA Automation Inspection', $1, 'active', 1, $2, $2)`,
    [projectId, occurredAtMs],
  );
  await migrationPool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', $2, 1, 'active', 'owner', $3,
               'user', $2, $4)`,
    [projectId, actor.id, '123e4567-e89b-42d3-a456-426614179000', occurredAtMs],
  );
  const database = await databaseOpener(
    'automation-manager',
    databaseUrl(
      AUTOMATION_MANAGER_USER,
      AUTOMATION_MANAGER_PASSWORD,
      primaryPort,
    ),
    'ql3-ha-automation-inspection-primary',
  )();
  const audit = (eventId, requestId, operationId, atMs) =>
    Object.freeze({
      eventId,
      requestId,
      operationId,
      projectId,
      subject: actor,
      authenticationId: 'oidc:ha-automation-inspection',
      outcome: 'allowed',
      reasons: Object.freeze(['role_grant']),
      fence,
      occurredAtMs: atMs,
    });
  try {
    await assertPostgresAutomationManagerSchemaReady(database.pool);
    const tasks = new PostgresTaskDefinitionAdministrationRepository(
      database.pool,
    );
    const triggers = new PostgresTriggerAdministrationRepository(database.pool);
    const task = (
      await tasks.appendAuthorizedTaskDefinitionRevision({
        command: {
          projectId,
          taskId: 'ha-inspection-task',
          expectedRevision: null,
          mutationId: '123e4567-e89b-42d3-a456-426614179001',
          name: 'HA inspection secret-bearing name',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: {
                kind: 'argv',
                file: '/bin/echo',
                args: ['ha-inspection-private-input'],
              },
            },
          },
          labels: { evidence: 'private-label' },
          enabled: true,
          occurredAtMs: occurredAtMs + 1,
        },
        actor,
        fence,
        audit: audit(
          '123e4567-e89b-42d3-a456-426614179001',
          'ha-automation-task-create',
          'task.create',
          occurredAtMs + 1,
        ),
      })
    ).definition;
    const trigger = (
      await triggers.appendAuthorizedTriggerRevision({
        command: {
          projectId,
          triggerId: 'ha-inspection-trigger',
          expectedRevision: null,
          mutationId: '123e4567-e89b-42d3-a456-426614179002',
          taskId: task.taskId,
          taskRevision: task.revision,
          taskContentDigest: task.contentDigest,
          spec: {
            schema: 'qinglong/cron@v1',
            config: {
              expression: '0 3 * * *',
              timezone: 'UTC',
              misfirePolicy: 'skip',
            },
          },
          enabled: false,
          occurredAtMs: occurredAtMs + 2,
        },
        actor,
        fence,
        audit: audit(
          '123e4567-e89b-42d3-a456-426614179002',
          'ha-automation-trigger-create',
          'trigger.create',
          occurredAtMs + 2,
        ),
      })
    ).trigger;
    const inspectedTask = await tasks.findAuthorizedCurrentTaskDefinition({
      projectId,
      taskId: task.taskId,
      actor,
      fence,
      audit: audit(
        '123e4567-e89b-42d3-a456-426614179003',
        'ha-automation-task-inspect',
        'task.read',
        occurredAtMs + 3,
      ),
    });
    const taskPage = await tasks.listAuthorizedTaskDefinitions({
      projectId,
      limit: 1,
      actor,
      fence,
      audit: audit(
        '123e4567-e89b-42d3-a456-426614179004',
        'ha-automation-task-list',
        'task.read',
        occurredAtMs + 4,
      ),
    });
    const inspectedTrigger = await triggers.findAuthorizedCurrentTrigger({
      projectId,
      triggerId: trigger.triggerId,
      actor,
      fence,
      audit: audit(
        '123e4567-e89b-42d3-a456-426614179005',
        'ha-automation-trigger-inspect',
        'trigger.read',
        occurredAtMs + 5,
      ),
    });
    const triggerPage = await triggers.listAuthorizedTriggers({
      projectId,
      limit: 1,
      actor,
      fence,
      audit: audit(
        '123e4567-e89b-42d3-a456-426614179006',
        'ha-automation-trigger-list',
        'trigger.read',
        occurredAtMs + 6,
      ),
    });
    assert.equal(inspectedTask?.contentDigest, task.contentDigest);
    assert.deepEqual(
      taskPage.definitions.map(({ taskId }) => taskId),
      [task.taskId],
    );
    assert.equal(taskPage.truncated, false);
    assert.equal(inspectedTrigger?.contentDigest, trigger.contentDigest);
    assert.deepEqual(
      triggerPage.triggers.map(({ triggerId }) => triggerId),
      [trigger.triggerId],
    );
    assert.equal(triggerPage.truncated, false);
    const facts = await migrationPool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."security_audit_events"
           WHERE project_id = $1 AND outcome = 'allowed') AS "auditCount",
         (SELECT current_revision
            FROM "ql3"."task_definitions"
           WHERE project_id = $1 AND task_id = $2) AS "taskRevision",
         (SELECT current_revision
            FROM "ql3"."triggers"
           WHERE project_id = $1 AND trigger_id = $3) AS "triggerRevision"`,
      [projectId, task.taskId, trigger.triggerId],
    );
    assert.deepEqual(facts.rows, [
      { auditCount: 6, taskRevision: 1, triggerRevision: 1 },
    ]);
    await waitFor(async () => {
      try {
        const replay = await standbyDatabase.pool.query(
          `SELECT
             (SELECT count(*)::integer
                FROM "ql3"."security_audit_events"
               WHERE project_id = $1) AS "auditCount",
             (SELECT current_revision
                FROM "ql3"."task_definitions"
               WHERE project_id = $1 AND task_id = $2) AS "taskRevision",
             (SELECT current_revision
                FROM "ql3"."triggers"
               WHERE project_id = $1 AND trigger_id = $3) AS "triggerRevision"`,
          [projectId, task.taskId, trigger.triggerId],
        );
        return replay.rows[0]?.auditCount === 6 &&
          replay.rows[0]?.taskRevision === 1 &&
          replay.rows[0]?.triggerRevision === 1
          ? replay.rows[0]
          : null;
      } catch {
        return null;
      }
    }, 'automation management inspection WAL replay');
    return {
      projectId,
      actor,
      fence,
      taskId: task.taskId,
      taskContentDigest: task.contentDigest,
      triggerId: trigger.triggerId,
      triggerContentDigest: trigger.contentDigest,
      beforePromotion: facts.rows[0],
      replicatedBeforePromotion: true,
      survivedPromotion: false,
    };
  } finally {
    await database.close();
  }
}

async function verifyAutomationManagementInspectionAfterPromotion({
  database,
  report,
}) {
  const tasks = new PostgresTaskDefinitionAdministrationRepository(
    database.pool,
  );
  const triggers = new PostgresTriggerAdministrationRepository(database.pool);
  const audit = (eventId, requestId, operationId, occurredAtMs) => ({
    eventId,
    requestId,
    operationId,
    projectId: report.projectId,
    subject: report.actor,
    authenticationId: 'oidc:ha-automation-inspection-promoted',
    outcome: 'allowed',
    reasons: ['role_grant'],
    fence: report.fence,
    occurredAtMs,
  });
  const clock = await database.pool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "observedAtMs"`,
  );
  const occurredAtMs = Number(clock.rows[0].observedAtMs);
  const task = await tasks.findAuthorizedCurrentTaskDefinition({
    projectId: report.projectId,
    taskId: report.taskId,
    actor: report.actor,
    fence: report.fence,
    audit: audit(
      '123e4567-e89b-42d3-a456-426614179007',
      'ha-automation-task-inspect-promoted',
      'task.read',
      occurredAtMs,
    ),
  });
  const taskPage = await tasks.listAuthorizedTaskDefinitions({
    projectId: report.projectId,
    limit: 1,
    actor: report.actor,
    fence: report.fence,
    audit: audit(
      '123e4567-e89b-42d3-a456-426614179008',
      'ha-automation-task-list-promoted',
      'task.read',
      occurredAtMs + 1,
    ),
  });
  const trigger = await triggers.findAuthorizedCurrentTrigger({
    projectId: report.projectId,
    triggerId: report.triggerId,
    actor: report.actor,
    fence: report.fence,
    audit: audit(
      '123e4567-e89b-42d3-a456-426614179009',
      'ha-automation-trigger-inspect-promoted',
      'trigger.read',
      occurredAtMs + 2,
    ),
  });
  const triggerPage = await triggers.listAuthorizedTriggers({
    projectId: report.projectId,
    limit: 1,
    actor: report.actor,
    fence: report.fence,
    audit: audit(
      '123e4567-e89b-42d3-a456-426614179010',
      'ha-automation-trigger-list-promoted',
      'trigger.read',
      occurredAtMs + 3,
    ),
  });
  assert.equal(task?.contentDigest, report.taskContentDigest);
  assert.deepEqual(
    taskPage.definitions.map(({ taskId }) => taskId),
    [report.taskId],
  );
  assert.equal(trigger?.contentDigest, report.triggerContentDigest);
  assert.deepEqual(
    triggerPage.triggers.map(({ triggerId }) => triggerId),
    [report.triggerId],
  );
  const facts = await database.pool.query(
    `SELECT
       count(*) FILTER (
         WHERE event_id IN (
           '123e4567-e89b-42d3-a456-426614179007',
           '123e4567-e89b-42d3-a456-426614179008',
           '123e4567-e89b-42d3-a456-426614179009',
           '123e4567-e89b-42d3-a456-426614179010'
         )
       )::integer AS "successfulReadAuditCount",
       count(*) FILTER (
         WHERE event_id = '123e4567-e89b-42d3-a456-426614179017'
       )::integer AS "degradedReadAuditCount",
       count(*)::integer AS "auditCount"
     FROM "ql3"."security_audit_events"
     WHERE project_id = $1 AND outcome = 'allowed'`,
    [report.projectId],
  );
  assert.equal(facts.rows[0]?.successfulReadAuditCount, 4);
  assert.ok(
    facts.rows[0]?.degradedReadAuditCount === 0 ||
      facts.rows[0]?.degradedReadAuditCount === 1,
  );
  assert.equal(
    facts.rows[0]?.auditCount,
    10 + facts.rows[0].degradedReadAuditCount,
  );
  report.afterPromotion = {
    auditCount: facts.rows[0].auditCount,
    successfulReadAuditCount: facts.rows[0].successfulReadAuditCount,
    degradedReadAuditCount: facts.rows[0].degradedReadAuditCount,
    taskRevision: task.revision,
    triggerRevision: trigger.revision,
  };
  report.survivedPromotion = true;
}

async function assertAutomationManagementInspectionFailsClosed({
  database,
  report,
}) {
  const tasks = new PostgresTaskDefinitionAdministrationRepository(
    database.pool,
  );
  const clock = await database.pool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
            AS "observedAtMs"`,
  );
  const occurredAtMs = Number(clock.rows[0].observedAtMs);
  await assert.rejects(
    tasks.findAuthorizedCurrentTaskDefinition({
      projectId: report.projectId,
      taskId: report.taskId,
      actor: report.actor,
      fence: report.fence,
      audit: {
        eventId: '123e4567-e89b-42d3-a456-426614179017',
        requestId: 'ha-automation-task-inspect-degraded',
        operationId: 'task.read',
        projectId: report.projectId,
        subject: report.actor,
        authenticationId: 'oidc:ha-automation-inspection-degraded',
        outcome: 'allowed',
        reasons: ['role_grant'],
        fence: report.fence,
        occurredAtMs,
      },
    }),
    (error) => error?.code === 'TASK_DEFINITION_UNAVAILABLE',
  );
  report.failedClosedWithoutSynchronousStandby = true;
}

async function persistRunAttemptLogRetentionClaimBeforePromotion({
  primaryPort,
  primaryDatabase,
  standbyDatabase,
}) {
  const fixture = Object.freeze({
    projectId: 'ha-log-retention-project',
    runId: 'ha-log-retention-run',
    attemptId: 'ha-log-retention-attempt',
    logArtifactId: `wlog-${'f'.repeat(30)}`,
    ownerId: 'ha-log-retention-primary',
    token: 'ha-log-retention-primary-token-0001',
    retentionMs: 60_000,
    leaseMs: 5_000,
  });
  const clock = await primaryDatabase.pool.query(
    `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
            AS "observedAtMs"`,
  );
  const observedAtMs = Number(clock.rows[0].observedAtMs);
  const finishedAtMs = observedAtMs - 120_000;
  await primaryDatabase.pool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, 'HA Log Retention', 'ha-log-retention', 'active', 1, $2, $2)`,
    [fixture.projectId, finishedAtMs],
  );
  await primaryDatabase.pool.query(
    `INSERT INTO "ql3"."runs" (
       id, project_id, task_id, task_revision, trigger_type,
       execution_origin, execution_owner, status, created_at_ms,
       queued_at_ms, started_at_ms, finished_at_ms, version, event_sequence
     ) VALUES ($1, $2, 'ha-log-retention-task', 'v1', 'manual', 'api',
       'runtime', 'succeeded', $3, $3, $3, $3, 3, 0)`,
    [fixture.runId, fixture.projectId, finishedAtMs],
  );
  await primaryDatabase.pool.query(
    `INSERT INTO "ql3"."run_attempts" (
       id, run_id, attempt, status, executor_type, log_artifact_id,
       callback_sequence, created_at_ms, started_at_ms, finished_at_ms,
       exit_code
     ) VALUES ($1, $2, 1, 'succeeded', 'remote_worker', $3, 0,
       $4, $4, $4, 0)`,
    [fixture.attemptId, fixture.runId, fixture.logArtifactId, finishedAtMs],
  );

  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
    'ql3-ha-log-retention-primary',
  )();
  let claim;
  try {
    const repository = new PostgresRunAttemptLogRetentionClaimRepository(
      runtimeDatabase.pool,
      () => fixture.token,
    );
    const page = await repository.claim({
      ownerId: fixture.ownerId,
      retentionMs: fixture.retentionMs,
      limit: 1,
      leaseMs: fixture.leaseMs,
    });
    assert.equal(page.claims.length, 1);
    claim = page.claims[0];
    assert.deepEqual(claim.candidate, {
      projectId: fixture.projectId,
      runId: fixture.runId,
      attemptId: fixture.attemptId,
      logArtifactId: fixture.logArtifactId,
      executorType: 'remote_worker',
      finishedAtMs,
    });
    assert.equal(claim.ownerId, fixture.ownerId);
    assert.equal(claim.token, fixture.token);
    assert.equal(claim.version, 1);
    assert.equal(claim.failureCount, 0);
    assert.equal(claim.expiresAtMs - claim.observedAtMs, fixture.leaseMs);
  } finally {
    await runtimeDatabase.close();
  }

  const replicated = await waitFor(async () => {
    const result = await standbyDatabase.pool.query(
      `SELECT claim_owner AS "ownerId", claim_token AS token,
              claim_version AS version, claim_expires_at_ms::text AS "expiresAtMs",
              (SELECT count(*)::integer
                 FROM "ql3"."run_attempt_log_artifact_tombstones"
                WHERE attempt_id = $1) AS "tombstoneCount"
         FROM "ql3"."run_attempt_log_retention_controls"
        WHERE attempt_id = $1`,
      [fixture.attemptId],
    );
    return result.rowCount === 1 ? result.rows[0] : null;
  }, 'Run Attempt log retention claim remote apply');
  assert.deepEqual(replicated, {
    ownerId: fixture.ownerId,
    token: fixture.token,
    version: 1,
    expiresAtMs: String(claim.expiresAtMs),
    tombstoneCount: 0,
  });

  return {
    fixture,
    claim,
    report: {
      replicatedBeforePromotion: true,
      initialOwnerId: claim.ownerId,
      initialClaimVersion: claim.version,
      initialClaimExpiresAtMs: claim.expiresAtMs,
      initialTombstoneCount: replicated.tombstoneCount,
    },
  };
}

async function verifyRunAttemptLogRetentionAfterPromotion({
  promotedPort,
  promotedDatabase,
  evidence,
}) {
  const runtimeDatabase = await databaseOpener(
    'runtime',
    databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, promotedPort),
    'ql3-ha-log-retention-promoted',
  )();
  try {
    const expired = await waitFor(async () => {
      const result = await promotedDatabase.pool.query(
        `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
                AS "observedAtMs"`,
      );
      return Number(result.rows[0].observedAtMs) >= evidence.claim.expiresAtMs
        ? result.rows[0]
        : null;
    }, 'Run Attempt log retention lease expiry');
    const oldRepository = new PostgresRunAttemptLogRetentionClaimRepository(
      runtimeDatabase.pool,
    );
    const staleRecord = createRunAttemptLogRetirementRecord({
      ...evidence.claim.candidate,
      eligibleAtMs: evidence.claim.eligibleAtMs,
      retiredAtMs: Math.max(
        Number(expired.observedAtMs),
        evidence.claim.eligibleAtMs,
      ),
      disposition: 'already_absent',
      byteLength: 0,
      truncation: { truncated: 'unknown' },
    });
    assert.equal(
      await oldRepository.settle(evidence.claim, {
        status: 'retired',
        record: staleRecord,
      }),
      'fenced',
    );

    const promotedToken = 'ha-log-retention-promoted-token-0002';
    const promotedOwnerId = 'ha-log-retention-promoted';
    const promotedRepository =
      new PostgresRunAttemptLogRetentionClaimRepository(
        runtimeDatabase.pool,
        () => promotedToken,
      );
    const page = await promotedRepository.claim({
      ownerId: promotedOwnerId,
      retentionMs: evidence.fixture.retentionMs,
      limit: 1,
      leaseMs: evidence.fixture.leaseMs,
    });
    assert.equal(page.claims.length, 1);
    const promotedClaim = page.claims[0];
    assert.deepEqual(promotedClaim.candidate, evidence.claim.candidate);
    assert.equal(promotedClaim.ownerId, promotedOwnerId);
    assert.equal(promotedClaim.token, promotedToken);
    assert.equal(promotedClaim.version, evidence.claim.version + 1);
    assert.ok(promotedClaim.observedAtMs >= evidence.claim.expiresAtMs);

    const record = createRunAttemptLogRetirementRecord({
      ...promotedClaim.candidate,
      eligibleAtMs: promotedClaim.eligibleAtMs,
      retiredAtMs: Math.max(
        promotedClaim.observedAtMs,
        promotedClaim.eligibleAtMs,
      ),
      disposition: 'already_absent',
      byteLength: 0,
      truncation: { truncated: 'unknown' },
    });
    assert.equal(
      await promotedRepository.settle(promotedClaim, {
        status: 'retired',
        record,
      }),
      'settled',
    );
    assert.deepEqual(
      await promotedRepository.inspect({
        projectId: evidence.fixture.projectId,
        runId: evidence.fixture.runId,
        attemptId: evidence.fixture.attemptId,
        logArtifactId: evidence.fixture.logArtifactId,
      }),
      { status: 'retired', record },
    );
    const durable = await promotedDatabase.pool.query(
      `SELECT
         (SELECT count(*)::integer
            FROM "ql3"."run_attempt_log_retention_controls"
           WHERE attempt_id = $1) AS "controlCount",
         (SELECT count(*)::integer
            FROM "ql3"."run_attempt_log_artifact_tombstones"
           WHERE attempt_id = $1 AND record_digest = $2) AS "tombstoneCount"`,
      [evidence.fixture.attemptId, record.recordDigest],
    );
    assert.deepEqual(durable.rows, [{ controlCount: 0, tombstoneCount: 1 }]);
    return {
      ...evidence.report,
      stalePrimarySettlementFenced: true,
      promotedOwnerId,
      promotedClaimVersion: promotedClaim.version,
      promotedClaimObservedAtMs: promotedClaim.observedAtMs,
      controlCountAfterSettlement: durable.rows[0].controlCount,
      tombstoneCountAfterSettlement: durable.rows[0].tombstoneCount,
      tombstoneDisposition: record.disposition,
      recordDigest: record.recordDigest,
      survivedPromotion: true,
    };
  } finally {
    await runtimeDatabase.close();
  }
}

async function manualRunRetryFacts(pool, fixture) {
  const result = await pool.query(
    `SELECT
       (SELECT status FROM "ql3"."runs" WHERE id = $1) AS "sourceStatus",
       (SELECT count(*)::integer FROM "ql3"."runs"
         WHERE project_id = $2 AND trigger_type = 'run_manual_retry'
           AND retry_of_run_id = $1) AS "retryRunCount",
       (SELECT count(*)::integer FROM "ql3"."run_attempts" AS attempt
          JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
         WHERE run.project_id = $2
           AND run.trigger_type = 'run_manual_retry'
           AND attempt.executor_type = 'remote_worker') AS "attemptCount",
       (SELECT count(*)::integer FROM "ql3"."run_events" AS event
          JOIN "ql3"."runs" AS run ON run.id = event.run_id
         WHERE run.project_id = $2
           AND run.trigger_type = 'run_manual_retry') AS "eventCount",
       (SELECT count(*)::integer FROM "ql3"."security_audit_events"
         WHERE project_id = $2 AND operation_id = 'run.retry'
           AND outcome = 'allowed') AS "allowedAuditCount",
       (SELECT count(*)::integer FROM "ql3"."run_retry_policies" AS policy
          JOIN "ql3"."runs" AS run ON run.id = policy.run_id
         WHERE run.project_id = $2
           AND run.trigger_type = 'run_manual_retry') AS "retryPolicyCount"`,
    [fixture.sourceRunId, fixture.projectId],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function runManualRunRetryHaEvidence(options) {
  const { primaryPort, primaryDatabase, standbyDatabase } = options;
  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const fixture = Object.freeze({
    projectId: `ha-manual-retry-${suffix}`,
    actorId: `ha-manual-retry-operator-${suffix}`,
    taskId: `ha-manual-retry-task-${suffix}`,
    sourceRunId: randomUUID(),
    sourceAttemptId: randomUUID(),
  });
  const clock = await primaryDatabase.pool.query(
    `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
            AS "nowMs"`,
  );
  const nowMs = Number(clock.rows[0].nowMs);
  await primaryDatabase.pool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, 'HA manual Run retry', $1, 'active', 1, $2, $2)`,
    [fixture.projectId, nowMs],
  );
  await primaryDatabase.pool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', $2, 1, 'active', 'operator', $3,
               'system', 'ha-contract', $4)`,
    [
      fixture.projectId,
      fixture.actorId,
      `ha-manual-retry-binding-${suffix}`,
      nowMs,
    ],
  );
  const task = (
    await new PostgresTaskDefinitionRepository(
      primaryDatabase.pool,
    ).appendTaskDefinitionRevision({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      expectedRevision: null,
      mutationId: randomUUID(),
      name: 'HA manual Run retry source',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: {
          command: {
            kind: 'argv',
            file: '/bin/echo',
            args: ['manual-retry-ha'],
          },
        },
      },
      labels: {},
      enabled: true,
      occurredAtMs: nowMs,
    })
  ).definition;
  const firstRuntime = await databaseOpener(
    'run-manager',
    databaseUrl(RUN_MANAGER_USER, RUN_MANAGER_PASSWORD, primaryPort),
    'ql3-ha-manual-run-retry-a',
  )();
  const secondRuntime = await databaseOpener(
    'run-manager',
    databaseUrl(RUN_MANAGER_USER, RUN_MANAGER_PASSWORD, primaryPort),
    'ql3-ha-manual-run-retry-b',
  )();
  try {
    const source = await new PostgresTaskStartRepository(
      primaryDatabase.pool,
    ).startTask({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      mutationId: randomUUID(),
      expectedRevision: task.revision,
      expectedContentDigest: task.contentDigest,
      runId: fixture.sourceRunId,
      attemptId: fixture.sourceAttemptId,
      createdEventId: randomUUID(),
      queuedEventId: randomUUID(),
      subject: { type: 'user', id: fixture.actorId },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    });
    await primaryDatabase.pool.query('BEGIN');
    try {
      await primaryDatabase.pool.query(
        `UPDATE "ql3"."runs"
            SET status = 'failed', version = 3, event_sequence = 3,
                finished_at_ms = $2, error_code = 'HA_SOURCE_FAILURE',
                error_summary = 'terminal source for manual retry'
          WHERE id = $1`,
        [fixture.sourceRunId, nowMs + 1],
      );
      await primaryDatabase.pool.query(
        `UPDATE "ql3"."run_attempts"
            SET status = 'failed', finished_at_ms = $2,
                error_code = 'HA_SOURCE_FAILURE',
                error_summary = 'terminal source for manual retry'
          WHERE id = $1`,
        [fixture.sourceAttemptId, nowMs + 1],
      );
      await primaryDatabase.pool.query(
        `INSERT INTO "ql3"."run_events" (
           id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
           attempt_id, payload, created_at_ms
         ) VALUES ($1, $2, 3, 'run.failed', $3, 'executor', 'ha-contract',
                   $4, $5::jsonb, $6)`,
        [
          randomUUID(),
          fixture.sourceRunId,
          `ha-manual-retry-source-failed-${suffix}`,
          fixture.sourceAttemptId,
          JSON.stringify({
            from_status: 'queued',
            to_status: 'failed',
            version: 3,
            error_code: 'HA_SOURCE_FAILURE',
          }),
          nowMs + 1,
        ],
      );
      await primaryDatabase.pool.query('COMMIT');
    } catch (error) {
      await primaryDatabase.pool.query('ROLLBACK');
      throw error;
    }

    const authentication = Object.freeze({
      subject: { type: 'user', id: fixture.actorId },
      authenticationId: `oidc:mfa-${suffix}`,
      authenticatedAtMs: nowMs,
      expiresAtMs: nowMs + 60 * 60_000,
      assurance: 'multi_factor',
    });
    let commandIndex = 0;
    const retryCommand = () => {
      commandIndex += 1;
      return {
        projectId: fixture.projectId,
        sourceRunId: fixture.sourceRunId,
        mutationId: randomUUID(),
        expectedRunVersion: 3,
        expectedRunStatus: 'failed',
        runId: randomUUID(),
        attemptId: randomUUID(),
        createdEventId: randomUUID(),
        queuedEventId: randomUUID(),
        auditEventId: randomUUID(),
        requestId: `ha-manual-retry-${suffix}-${commandIndex}`,
        principal: authentication,
        policyFence: { projectVersion: 1, bindingVersion: 1 },
      };
    };
    const firstRepository = new PostgresRunManualRetryRepository(
      firstRuntime.pool,
    );
    const secondRepository = new PostgresRunManualRetryRepository(
      secondRuntime.pool,
    );
    const replayCommand = retryCommand();
    const exactRace = await Promise.all([
      firstRepository.retryRun(replayCommand),
      secondRepository.retryRun(replayCommand),
    ]);
    assert.deepEqual(exactRace.map(({ status }) => status).sort(), [
      'accepted',
      'existing',
    ]);
    assert.equal(exactRace[0].runId, exactRace[1].runId);
    assert.equal(exactRace[0].attemptId, exactRace[1].attemptId);

    for (
      let index = 1;
      index < CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT - 1;
      index += 1
    ) {
      const repository = index % 2 === 0 ? firstRepository : secondRepository;
      assert.equal(
        (await repository.retryRun(retryCommand())).status,
        'accepted',
      );
    }
    const quotaRace = await Promise.allSettled([
      firstRepository.retryRun(retryCommand()),
      secondRepository.retryRun(retryCommand()),
    ]);
    const accepted = quotaRace.filter(({ status }) => status === 'fulfilled');
    const rejected = quotaRace.filter(({ status }) => status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(accepted[0].value.status, 'accepted');
    assert.equal(
      rejected[0].reason instanceof RunManualRetryRateLimitedError,
      true,
    );
    assert.ok(rejected[0].reason.retryAfterMs > 0);

    const expectedFacts = {
      sourceStatus: 'failed',
      retryRunCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
      attemptCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
      eventCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT * 2,
      allowedAuditCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
      retryPolicyCount: 0,
    };
    assert.deepEqual(
      await manualRunRetryFacts(primaryDatabase.pool, fixture),
      expectedFacts,
    );
    await waitFor(async () => {
      const facts = await manualRunRetryFacts(standbyDatabase.pool, fixture);
      return facts.retryRunCount === CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT
        ? facts
        : null;
    }, 'manual Run retry WAL replay');
    assert.deepEqual(
      await manualRunRetryFacts(standbyDatabase.pool, fixture),
      expectedFacts,
    );
    return {
      fixture,
      report: {
        sourceRunId: source.runId,
        exactConcurrentReplay: true,
        crossReplicaQuotaSerialized: true,
        acceptedRetryRuns: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
        rejectedOverQuota: 1,
        inheritedRetryPolicies: 0,
        allowedAuditEvents: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
        replicatedBeforePromotion: true,
        survivedPromotion: false,
      },
    };
  } finally {
    await Promise.all([firstRuntime.close(), secondRuntime.close()]);
  }
}

async function verifyManualRunRetryAfterPromotion(options) {
  const { promotedPool, evidence } = options;
  assert.deepEqual(await manualRunRetryFacts(promotedPool, evidence.fixture), {
    sourceStatus: 'failed',
    retryRunCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
    attemptCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
    eventCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT * 2,
    allowedAuditCount: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
    retryPolicyCount: 0,
  });
  evidence.report.survivedPromotion = true;
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 24) {
    throw new Error('PostgreSQL HA contract requires Node.js 24 or newer');
  }
  if (!/^postgres:18(?:[.@][A-Za-z0-9_:+./-]+)?$/.test(IMAGE)) {
    throw new Error(
      'QL3_HA_POSTGRES_IMAGE must be an explicit postgres:18 image',
    );
  }
  if (
    process.env.QL3_HA_SKIP_IMAGE_PULL !== undefined &&
    process.env.QL3_HA_SKIP_IMAGE_PULL !== '' &&
    process.env.QL3_HA_SKIP_IMAGE_PULL !== 'true' &&
    process.env.QL3_HA_SKIP_IMAGE_PULL !== 'false'
  ) {
    throw new Error(
      'QL3_HA_SKIP_IMAGE_PULL must be true or false when configured',
    );
  }
  docker(['version', '--format', '{{.Server.Version}}']);
  if (!SKIP_IMAGE_PULL) {
    docker(['pull', IMAGE], { timeoutMs: IMAGE_PULL_TIMEOUT_MS });
  }
  docker(['image', 'inspect', IMAGE]);

  const suffix = `${process.pid}-${randomBytes(3).toString('hex')}`;
  const names = {
    network: `ql3-ha-replication-${suffix}`,
    primaryNetwork: `ql3-ha-primary-client-${suffix}`,
    standbyNetwork: `ql3-ha-standby-client-${suffix}`,
    primary: `ql3-ha-primary-${suffix}`,
    standby: `ql3-ha-standby-${suffix}`,
    primaryVolume: `ql3-ha-primary-data-${suffix}`,
    standbyVolume: `ql3-ha-standby-data-${suffix}`,
    replicationSlot: `ql3_ha_${process.pid}_${randomBytes(2).toString('hex')}`,
    rejoinReplicationSlot: `ql3_ha_rejoin_${process.pid}_${randomBytes(
      2,
    ).toString('hex')}`,
  };
  const resources = {
    network: false,
    primaryNetwork: false,
    standbyNetwork: false,
    primaryVolume: false,
    standbyVolume: false,
    primary: false,
    standby: false,
  };
  const replicas = [];
  let proxy;
  let primaryDatabase;
  let standbyDatabase;
  let promotedDatabase;
  let ambiguousClient;
  let uncommittedClient;
  let partitionClient;
  let schedulerFaultPool;
  let schedulerFailover;
  let credentialDelivery;
  let domainCommitResponseLoss;
  let managementQuota;
  let workerCredentialManagementQuota;
  let identityKeysetLedger;
  let workerCredentialIdentityKeysetLedger;
  let automationIdentityKeysetLedger;
  let approvalIdentityKeysetLedger;
  let runManagementIdentityKeysetLedger;
  let automationManagementInspection;
  let pluginPackageLifecycle;
  let pluginPackageQuarantine;
  let publisherTrustTransition;
  let projectToolSnapshot;
  let toolInvocationArtifact;
  let toolInvocationArtifactPairForPromotion;
  let toolResultKeyRetirement;
  let toolResultKeyFixture;
  let synchronousReplicationBeforePartition;
  let networkPartition;
  let oldPrimaryRejoin;
  let modelInvocationFeaturePromotion;
  let modelProviderCredentialCatalog;
  let modelProviderCredentialTestConnection;
  let runAttemptLogRetentionEvidence;
  let runAttemptLogRetention;
  let manualRunRetry;
  const startedAt = performance.now();
  const timeline = [];
  let report;

  try {
    docker(['network', 'create', names.network]);
    resources.network = true;
    docker(['network', 'create', names.primaryNetwork]);
    resources.primaryNetwork = true;
    docker(['network', 'create', names.standbyNetwork]);
    resources.standbyNetwork = true;
    docker(['volume', 'create', names.primaryVolume]);
    resources.primaryVolume = true;
    docker(['volume', 'create', names.standbyVolume]);
    resources.standbyVolume = true;

    docker([
      'run',
      '--name',
      names.primary,
      '--detach',
      '--network',
      names.primaryNetwork,
      '-e',
      `POSTGRES_DB=${DATABASE}`,
      '-e',
      `POSTGRES_USER=${SUPERUSER}`,
      '-e',
      `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      `PGDATA=${POSTGRES_DATA}`,
      '-v',
      `${names.primaryVolume}:${POSTGRES_VOLUME_ROOT}`,
      '-p',
      '127.0.0.1::5432',
      IMAGE,
      '-c',
      'wal_level=replica',
      '-c',
      'max_wal_senders=10',
      '-c',
      'max_replication_slots=10',
      '-c',
      'wal_keep_size=128MB',
      '-c',
      'hot_standby=on',
      '-c',
      'wal_log_hints=on',
    ]);
    resources.primary = true;
    await waitForPostgres(names.primary);
    docker([
      'network',
      'connect',
      '--alias',
      'primary',
      names.network,
      names.primary,
    ]);
    const primaryPort = mappedPostgresPort(names.primary);
    timeline.push({
      state: 'primary_ready',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    primaryDatabase = await databaseOpener(
      'migration',
      databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, primaryPort),
      'ql3-ha-migration-primary',
    )();
    await primaryDatabase.pool.query(
      `CREATE ROLE ${MIGRATION_USER} LOGIN PASSWORD '${MIGRATION_PASSWORD}'`,
    );
    await provisionRuntimeRole(primaryDatabase);
    await provisionCredentialRoles(primaryDatabase);
    await primaryDatabase.pool.query(
      `ALTER DATABASE ${DATABASE} OWNER TO ${MIGRATION_USER}`,
    );
    const migrationDatabase = await databaseOpener(
      'migration',
      databaseUrl(MIGRATION_USER, MIGRATION_PASSWORD, primaryPort),
      'ql3-ha-reviewed-migration',
    )();
    try {
      await runPostgresMigrations({ pool: migrationDatabase.pool });
      await migratePostgresModelInvocationFeature(migrationDatabase.pool);
      const beforePromotion = await modelInvocationFeatureFacts(
        migrationDatabase.pool,
      );
      assert.deepEqual(beforePromotion.tables, [
        'model_invocation_completions',
        'model_invocation_price_quotes',
        'model_invocation_price_settlements',
        'model_invocation_prompt_admissions',
        'model_invocation_prompt_finalizations',
        'model_invocation_prompt_output_artifact_tombstones',
        'model_invocation_prompt_output_artifacts',
        'model_invocation_prompt_output_key_retirement_completions',
        'model_invocation_prompt_output_key_retirement_preparations',
        'model_invocation_prompt_output_key_rotation_completions',
        'model_invocation_prompt_output_key_rotation_preparations',
        'model_invocation_quota_reservations',
        'model_invocation_quota_settlements',
        'model_invocation_resolutions',
        'model_invocation_starts',
        'model_invocation_usage_ledger',
        'model_price_catalog_authorizations',
        'model_price_catalog_heads',
        'model_price_catalog_publications',
        'model_provider_credential_audits',
        'model_provider_credential_bindings',
        'model_provider_credential_management_identity_keyset_ledger',
        'model_provider_credential_test_executions',
        'model_provider_credential_test_plans',
        'model_provider_credential_test_quota_buckets',
        'model_provider_credential_test_results',
        'model_provider_credential_transitions',
      ]);
      assert.equal(beforePromotion.schemaExists, true);
      assert.deepEqual(
        beforePromotion.history.map(({ migrationId }) => migrationId),
        [
          POSTGRES_MODEL_INVOCATION_MIGRATION_ID,
          POSTGRES_MODEL_INVOCATION_USAGE_MIGRATION_ID,
          POSTGRES_MODEL_INVOCATION_QUOTA_MIGRATION_ID,
          POSTGRES_MODEL_INVOCATION_PRICING_MIGRATION_ID,
          POSTGRES_MODEL_PRICE_CATALOG_MIGRATION_ID,
          POSTGRES_MODEL_PRICE_CATALOG_AUTHORIZATION_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_ADMISSION_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_FINALIZATION_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_TOMBSTONE_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_RETIREMENT_MIGRATION_ID,
          POSTGRES_MODEL_PROVIDER_CREDENTIAL_CATALOG_MIGRATION_ID,
          POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_MIGRATION_ID,
          POSTGRES_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_IDENTITY_MIGRATION_ID,
          POSTGRES_MODEL_PROVIDER_CREDENTIAL_TEST_CONNECTION_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_OUTPUT_KEY_ROTATION_MIGRATION_ID,
          POSTGRES_PLUGIN_PACKAGE_PROMPT_PRODUCT_AUTHORIZATION_MIGRATION_ID,
        ],
      );
      assert.deepEqual(beforePromotion.privileges, {
        startsAppendOnly: true,
        completionsAppendOnly: true,
        resolutionsAppendOnly: true,
        usageLedgerAppendOnly: true,
        quotaReservationsAppendOnly: true,
        quotaSettlementsAppendOnly: true,
        priceQuotesAppendOnly: true,
        priceSettlementsAppendOnly: true,
        catalogRuntimeReadOnly: true,
        catalogAuthorizationRuntimeDenied: true,
        catalogAdminAppendOnly: true,
        catalogAuthorizationAdminAppendOnly: true,
        catalogOtherRolesDenied: true,
        promptAdmissionsAppendOnly: true,
        promptFinalizationsAppendOnly: true,
        promptOutputArtifactAuthoritySplit: true,
        promptOutputTombstoneAuthoritySplit: true,
        promptOutputKeyRetirementAuthoritySplit: true,
        promptOutputKeyRotationAuthoritySplit: true,
        promptSnapshotRuntimeOnly: true,
        migrationHistoryRuntimeReadOnly: true,
        modelProviderCredentialManagementAuthoritySplit: true,
      });
      modelInvocationFeaturePromotion = { beforePromotion };
    } finally {
      await migrationDatabase.close();
    }
    modelProviderCredentialCatalog =
      await runModelProviderCredentialCatalogMatrix({
        primaryPort,
        migrationPool: primaryDatabase.pool,
      });
    timeline.push({
      state: 'model_provider_credential_catalog_verified',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const adminReadinessDatabase = await databaseOpener(
      'admin',
      databaseUrl(ADMIN_USER, ADMIN_PASSWORD, primaryPort),
      'ql3-ha-admin-readiness',
    )();
    const runtimeReadinessDatabase = await databaseOpener(
      'runtime',
      databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
      'ql3-ha-runtime-readiness',
    )();
    const automationManagerReadinessDatabase = await databaseOpener(
      'automation-manager',
      databaseUrl(
        AUTOMATION_MANAGER_USER,
        AUTOMATION_MANAGER_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-automation-manager-readiness',
    )();
    const approvalManagerReadinessDatabase = await databaseOpener(
      'approval-manager',
      databaseUrl(
        APPROVAL_MANAGER_USER,
        APPROVAL_MANAGER_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-approval-manager-readiness',
    )();
    const runManagerReadinessDatabase = await databaseOpener(
      'run-manager',
      databaseUrl(RUN_MANAGER_USER, RUN_MANAGER_PASSWORD, primaryPort),
      'ql3-ha-run-manager-readiness',
    )();
    const packageManagerReadinessDatabase = await databaseOpener(
      'package-manager',
      databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, primaryPort),
      'ql3-ha-package-manager-readiness',
    )();
    const packageExecutorReadinessDatabase = await databaseOpener(
      'package-executor',
      databaseUrl(
        PACKAGE_EXECUTOR_USER,
        PACKAGE_EXECUTOR_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-package-executor-readiness',
    )();
    const workerManagerReadinessDatabase = await databaseOpener(
      'worker-credential-manager',
      databaseUrl(
        WORKER_CREDENTIAL_MANAGER_USER,
        WORKER_CREDENTIAL_MANAGER_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-worker-credential-manager-readiness',
    )();
    const workerExecutorReadinessDatabase = await databaseOpener(
      'worker-credential-executor',
      databaseUrl(
        WORKER_CREDENTIAL_EXECUTOR_USER,
        WORKER_CREDENTIAL_EXECUTOR_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-worker-credential-executor-readiness',
    )();
    try {
      await assertPostgresSchemaReady(runtimeReadinessDatabase.pool);
      await assertPostgresAdminSchemaReady(adminReadinessDatabase.pool);
      await assertPostgresAutomationManagerSchemaReady(
        automationManagerReadinessDatabase.pool,
      );
      await assertPostgresApprovalManagerSchemaReady(
        approvalManagerReadinessDatabase.pool,
      );
      await assertPostgresRunManagerSchemaReady(
        runManagerReadinessDatabase.pool,
      );
      await assertPostgresPackageManagerSchemaReady(
        packageManagerReadinessDatabase.pool,
      );
      await assertPostgresPackageExecutorSchemaReady(
        packageExecutorReadinessDatabase.pool,
      );
      await assertPostgresWorkerCredentialManagerSchemaReady(
        workerManagerReadinessDatabase.pool,
      );
      await assertPostgresWorkerCredentialExecutorSchemaReady(
        workerExecutorReadinessDatabase.pool,
      );
    } finally {
      await Promise.all([
        runtimeReadinessDatabase.close(),
        adminReadinessDatabase.close(),
        automationManagerReadinessDatabase.close(),
        approvalManagerReadinessDatabase.close(),
        runManagerReadinessDatabase.close(),
        packageManagerReadinessDatabase.close(),
        packageExecutorReadinessDatabase.close(),
        workerManagerReadinessDatabase.close(),
        workerExecutorReadinessDatabase.close(),
      ]);
    }
    timeline.push({
      state: 'package_authority_split_readiness_verified',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    managementQuota = await runManagementQuotaMatrix({
      primaryPort,
      migrationPool: primaryDatabase.pool,
    });
    workerCredentialManagementQuota =
      await runWorkerCredentialManagementQuotaMatrix({
        primaryPort,
        migrationPool: primaryDatabase.pool,
      });
    timeline.push({
      state: 'durable_management_quota_verified',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    identityKeysetLedger = await runIdentityKeysetLedgerMatrix({
      primaryPort,
      authority: 'plugin-package-management',
    });
    workerCredentialIdentityKeysetLedger = await runIdentityKeysetLedgerMatrix({
      primaryPort,
      authority: 'worker-credential-management',
    });
    automationIdentityKeysetLedger = await runIdentityKeysetLedgerMatrix({
      primaryPort,
      authority: 'automation-management',
    });
    approvalIdentityKeysetLedger = await runIdentityKeysetLedgerMatrix({
      primaryPort,
      authority: 'approval-management',
    });
    runManagementIdentityKeysetLedger = await runIdentityKeysetLedgerMatrix({
      primaryPort,
      authority: 'run-management',
    });
    timeline.push({
      state: 'durable_identity_keyset_ledger_verified',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await primaryDatabase.pool.query(
      `CREATE ROLE ${REPLICATION_USER} WITH REPLICATION LOGIN`,
    );
    const primaryVersion = await primaryDatabase.pool.query(
      `SELECT current_setting('server_version') AS version,
              current_setting('server_version_num') AS "versionNumber"`,
    );
    const primaryTimeline = await timelineId(primaryDatabase);

    docker([
      'exec',
      names.primary,
      'sh',
      '-c',
      `printf '%s\\n' 'host replication ${REPLICATION_USER} 0.0.0.0/0 trust' >> ${POSTGRES_DATA}/pg_hba.conf`,
    ]);
    await primaryDatabase.pool.query('SELECT pg_reload_conf()');
    docker([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-v',
      `${names.standbyVolume}:${POSTGRES_VOLUME_ROOT}`,
      IMAGE,
      '-c',
      `mkdir -p ${POSTGRES_DATA} && chown -R postgres:postgres ${POSTGRES_DATA}`,
    ]);
    docker([
      'run',
      '--rm',
      '--network',
      names.network,
      '--user',
      'postgres',
      '--entrypoint',
      'pg_basebackup',
      '-v',
      `${names.standbyVolume}:${POSTGRES_VOLUME_ROOT}`,
      IMAGE,
      '-h',
      'primary',
      '-U',
      REPLICATION_USER,
      '-D',
      POSTGRES_DATA,
      '-Fp',
      '-Xs',
      '-P',
      '-R',
      '--checkpoint=fast',
      '-C',
      '-S',
      names.replicationSlot,
    ]);
    docker([
      'create',
      '--name',
      names.standby,
      '--network',
      names.standbyNetwork,
      '-e',
      `PGDATA=${POSTGRES_DATA}`,
      '-v',
      `${names.standbyVolume}:${POSTGRES_VOLUME_ROOT}`,
      '-p',
      '127.0.0.1::5432',
      IMAGE,
      '-c',
      'hot_standby=on',
    ]);
    resources.standby = true;
    docker([
      'network',
      'connect',
      '--alias',
      'standby',
      names.network,
      names.standby,
    ]);
    docker(['start', names.standby]);
    await waitForPostgres(names.standby);
    const standbyPort = mappedPostgresPort(names.standby);
    standbyDatabase = await databaseOpener(
      'migration',
      databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, standbyPort),
      'ql3-ha-migration-standby',
    )();
    await waitFor(async () => {
      const state = await standbyDatabase.pool.query(
        `SELECT pg_is_in_recovery() AS "inRecovery",
                EXISTS (
                  SELECT 1 FROM pg_stat_wal_receiver WHERE status = 'streaming'
                ) AS streaming`,
      );
      return state.rows[0]?.inRecovery === true &&
        state.rows[0]?.streaming === true
        ? state.rows[0]
        : null;
    }, 'physical streaming replication');
    timeline.push({
      state: 'standby_streaming',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await primaryDatabase.pool.query(
      `ALTER SYSTEM SET synchronous_standby_names = '*'`,
    );
    await primaryDatabase.pool.query(
      `ALTER SYSTEM SET synchronous_commit = 'remote_apply'`,
    );
    await primaryDatabase.pool.query('SELECT pg_reload_conf()');
    await primaryDatabase.pool.query(`SET synchronous_commit = 'remote_apply'`);
    synchronousReplicationBeforePartition = await waitFor(async () => {
      const result = await primaryDatabase.pool.query(
        `SELECT application_name AS "applicationName",
                state, sync_state AS "syncState"
           FROM pg_stat_replication
          WHERE state = 'streaming' AND sync_state = 'sync'`,
      );
      return result.rowCount === 1 ? result.rows[0] : null;
    }, 'synchronous standby readiness');
    timeline.push({
      state: 'synchronous_remote_apply_ready',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    manualRunRetry = await runManualRunRetryHaEvidence({
      primaryPort,
      primaryDatabase,
      standbyDatabase,
    });
    timeline.push({
      state: 'manual_run_retry_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    modelProviderCredentialTestConnection =
      await runModelProviderCredentialTestConnectionHaEvidence({
        primaryPort,
        primaryPool: primaryDatabase.pool,
        standbyPool: standbyDatabase.pool,
        credentialCatalog: modelProviderCredentialCatalog,
      });
    timeline.push({
      state: 'model_provider_credential_test_connection_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const toolInvocationArtifactResult =
      await persistToolInvocationArtifactBeforePromotion({
        primaryPort,
        primaryDatabase,
        standbyDatabase,
      });
    toolInvocationArtifact = toolInvocationArtifactResult.report;
    toolInvocationArtifactPairForPromotion = toolInvocationArtifactResult.pair;
    timeline.push({
      state: 'tool_invocation_artifact_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const toolResultRuntimeDatabase = await databaseOpener(
      'runtime',
      databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, primaryPort),
      'ql3-ha-tool-result-primary',
    )();
    const toolResultAdminDatabase = await databaseOpener(
      'admin',
      databaseUrl(ADMIN_USER, ADMIN_PASSWORD, primaryPort),
      'ql3-ha-tool-result-admin-primary',
    )();
    const toolResultCatalogCommitFault = credentialCommitFaultEvidence();
    const toolResultCatalogFaultPool = credentialCommitFaultPool(
      ADMIN_USER,
      ADMIN_PASSWORD,
      primaryPort,
      'ql3-ha-tool-result-catalog-response-loss',
      toolResultCatalogCommitFault,
    );
    const toolResultCompletionCommitFault = credentialCommitFaultEvidence();
    const toolResultCompletionFaultPool = credentialCommitFaultPool(
      RUNTIME_USER,
      RUNTIME_PASSWORD,
      primaryPort,
      'ql3-ha-tool-result-completion-response-loss',
      toolResultCompletionCommitFault,
    );
    const toolResultRekeyCommitFault = credentialCommitFaultEvidence();
    const toolResultRekeyFaultPool = credentialCommitFaultPool(
      ADMIN_USER,
      ADMIN_PASSWORD,
      primaryPort,
      'ql3-ha-tool-result-rekey-response-loss',
      toolResultRekeyCommitFault,
    );
    try {
      const toolResult = await persistNonEmptyToolResultRetirement({
        runtimePool: toolResultRuntimeDatabase.pool,
        adminPool: toolResultAdminDatabase.pool,
        catalogCommitFaultPool: toolResultCatalogFaultPool.repositoryPool,
        catalogCommitFaultEvidence: toolResultCatalogCommitFault,
        completionCommitFaultPool: toolResultCompletionFaultPool.repositoryPool,
        completionCommitFaultEvidence: toolResultCompletionCommitFault,
        rekeyCommitFaultPool: toolResultRekeyFaultPool.repositoryPool,
        rekeyCommitFaultEvidence: toolResultRekeyCommitFault,
        baseTimeMs: Date.now(),
      });
      toolResultKeyRetirement = toolResult.report;
      toolResultKeyFixture = toolResult.fixture;
    } finally {
      await Promise.all([
        toolResultRuntimeDatabase.close(),
        toolResultAdminDatabase.close(),
        toolResultCatalogFaultPool.pool.end(),
        toolResultCompletionFaultPool.pool.end(),
        toolResultRekeyFaultPool.pool.end(),
      ]);
    }
    await waitFor(async () => {
      const facts = await standbyDatabase.pool.query(
        `SELECT
           (SELECT count(*)::integer
              FROM "ql3"."tool_execution_result_key_bindings"
             WHERE start_id = $1) AS "bindingCount",
           (SELECT count(*)::integer
              FROM "ql3"."tool_execution_result_rekey_heads"
             WHERE artifact_id = $2) AS "headCount",
           (SELECT count(*)::integer
              FROM "ql3"."tool_result_key_retirement_receipts"
             WHERE receipt_digest = $3) AS "receiptCount"`,
        [
          toolResultKeyRetirement.startId,
          toolResultKeyRetirement.artifactId,
          toolResultKeyRetirement.retirementReceiptDigest,
        ],
      );
      return facts.rows[0]?.bindingCount === 1 &&
        facts.rows[0]?.headCount === 1 &&
        facts.rows[0]?.receiptCount === 1
        ? facts.rows[0]
        : null;
    }, 'non-empty Tool result rekey WAL replay');
    toolResultKeyRetirement.replicatedBeforePromotion = true;
    timeline.push({
      state: 'tool_result_key_retirement_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    credentialDelivery = await runCredentialDeliveryCommitResponseLossMatrix({
      primaryPort,
      standbyDatabase,
    });
    timeline.push({
      state: 'credential_delivery_v1_v4_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    domainCommitResponseLoss = await runDomainCommitResponseLossMatrix({
      primaryPort,
      primaryDatabase,
      standbyDatabase,
    });
    timeline.push({
      state: 'completion_and_cancellation_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    automationManagementInspection =
      await runAutomationManagementInspectionMatrix({
        primaryPort,
        migrationPool: primaryDatabase.pool,
        standbyDatabase,
      });
    timeline.push({
      state: 'automation_management_inspection_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    const schedulerClock = await primaryDatabase.pool.query(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "observedAtMs"`,
    );
    const schedulerOccurredAtMs =
      Number(schedulerClock.rows[0].observedAtMs) - 2_000;
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'default', 'Default', 'default', 'active', 1, $1, $1
       ) ON CONFLICT (id) DO NOTHING`,
      [schedulerOccurredAtMs],
    );
    const schedulerTask = (
      await new PostgresTaskDefinitionRepository(
        primaryDatabase.pool,
      ).appendTaskDefinitionRevision({
        projectId: 'default',
        taskId: 'ha-scheduler-task',
        expectedRevision: null,
        mutationId: '019f8000-0000-7000-8000-000000000001',
        name: 'HA scheduler claim takeover',
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/bin/echo',
              args: ['ha-scheduler'],
            },
          },
        },
        labels: {},
        enabled: true,
        occurredAtMs: schedulerOccurredAtMs,
      })
    ).definition;
    const schedulerTrigger = (
      await new PostgresTriggerRepository(
        primaryDatabase.pool,
      ).appendTriggerRevision({
        projectId: 'default',
        triggerId: 'ha-scheduler-trigger',
        expectedRevision: null,
        mutationId: '019f8000-0000-7000-8000-000000000002',
        taskId: schedulerTask.taskId,
        taskRevision: schedulerTask.revision,
        taskContentDigest: schedulerTask.contentDigest,
        spec: {
          schema: 'qinglong/cron@v1',
          config: {
            expression: '0 0 1 1 *',
            timezone: 'UTC',
            misfirePolicy: 'skip',
          },
        },
        enabled: true,
        occurredAtMs: schedulerOccurredAtMs + 1,
      })
    ).trigger;
    const ambiguousSchedulerTrigger = (
      await new PostgresTriggerRepository(
        primaryDatabase.pool,
      ).appendTriggerRevision({
        projectId: 'default',
        triggerId: 'ha-scheduler-ambiguous-trigger',
        expectedRevision: null,
        mutationId: '019f8000-0000-7000-8000-000000000003',
        taskId: schedulerTask.taskId,
        taskRevision: schedulerTask.revision,
        taskContentDigest: schedulerTask.contentDigest,
        spec: {
          schema: 'qinglong/cron@v1',
          config: {
            expression: '0 0 1 1 *',
            timezone: 'UTC',
            misfirePolicy: 'skip',
          },
        },
        enabled: true,
        occurredAtMs: schedulerOccurredAtMs + 2,
      })
    ).trigger;
    const primarySchedules = new PostgresClusterScheduleRepository(
      primaryDatabase.pool,
    );
    const ambiguousDueClock = await primaryDatabase.pool.query(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "observedAtMs"`,
    );
    const ambiguousSchedulerDueAtMs = Number(
      ambiguousDueClock.rows[0].observedAtMs,
    );
    await primaryDatabase.pool.query(
      `UPDATE "ql3"."trigger_schedules"
          SET next_fire_at_ms = $1,
              state_version = state_version + 1,
              updated_at_ms = $2
        WHERE project_id = 'default' AND trigger_id = $3`,
      [
        ambiguousSchedulerDueAtMs + 24 * 60 * 60_000,
        ambiguousSchedulerDueAtMs,
        schedulerTrigger.triggerId,
      ],
    );
    await primaryDatabase.pool.query(
      `UPDATE "ql3"."trigger_schedules"
          SET next_fire_at_ms = $1,
              state_version = state_version + 1,
              updated_at_ms = $1
        WHERE project_id = 'default' AND trigger_id = $2`,
      [ambiguousSchedulerDueAtMs, ambiguousSchedulerTrigger.triggerId],
    );
    const schedulerCommitFault = {
      injected: false,
      commitCompletedBeforeFault: false,
      backendTerminationRequested: false,
      backendConnectionRejected: false,
    };
    const schedulerCommitIds = [
      '019f8000-0000-7000-8000-000000000005',
      '019f8000-0000-7000-8000-000000000006',
      '019f8000-0000-7000-8000-000000000007',
      '019f8000-0000-7000-8000-000000000008',
      '019f8000-0000-7000-8000-000000000009',
    ];
    schedulerFaultPool = new RawPostgresPool({
      connectionString: databaseUrl(
        RUNTIME_USER,
        RUNTIME_PASSWORD,
        primaryPort,
      ),
      application_name: 'ql3-ha-scheduler-commit-response-loss',
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    schedulerFaultPool.on('error', () => {
      // The fixture deliberately terminates its only transaction backend.
    });
    const ambiguousScheduler = new ClusterSchedulerCoordinator(
      new PostgresClusterScheduleRepository(
        postCommitResponseLossPool(schedulerFaultPool, schedulerCommitFault),
      ),
      {
        ownerId: 'ql3-ha-scheduler-commit-response-loss',
        claimLeaseMs: SCHEDULER_FAILOVER_LEASE_MS,
        maxClaimsPerCycle: 1,
        misfireGraceMs: 30_000,
        createId() {
          const next = schedulerCommitIds.shift();
          if (!next) throw new Error('scheduler fault IDs exhausted');
          return next;
        },
      },
    );
    await assert.rejects(
      ambiguousScheduler.scheduleOnce(),
      (error) => error?.code === 'CLUSTER_SCHEDULE_UNAVAILABLE',
      'scheduler must expose unavailable after a committed decision loses its response',
    );
    assert.deepEqual(schedulerCommitFault, {
      injected: true,
      commitCompletedBeforeFault: true,
      backendTerminationRequested: true,
      backendConnectionRejected: true,
    });
    assert.equal(schedulerCommitIds.length, 0);
    const replicatedAmbiguousScheduler = await waitFor(async () => {
      const result = await standbyDatabase.pool.query(
        `SELECT schedule.claim_owner AS "claimOwner",
                schedule.claim_token::text AS "claimToken",
                schedule.claim_version::text AS "claimVersion",
                schedule.last_scheduled_at_ms::text AS "lastScheduledAtMs",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."runs" AS run
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "runCount",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."run_attempts" AS attempt
                    JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "attemptCount",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."run_events" AS event
                    JOIN "ql3"."runs" AS run ON run.id = event.run_id
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "eventCount"
           FROM "ql3"."trigger_schedules" AS schedule
          WHERE schedule.project_id = 'default'
            AND schedule.trigger_id = $1`,
        [ambiguousSchedulerTrigger.triggerId, ambiguousSchedulerDueAtMs],
      );
      const row = result.rows[0];
      return row?.claimOwner === null &&
        row?.claimToken === null &&
        row?.lastScheduledAtMs === String(ambiguousSchedulerDueAtMs) &&
        row?.runCount === 1 &&
        row?.attemptCount === 1 &&
        row?.eventCount === 2
        ? row
        : null;
    }, 'scheduler COMMIT-response-loss WAL replay');

    const dueClock = await primaryDatabase.pool.query(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AS "observedAtMs"`,
    );
    const schedulerDueAtMs = Number(dueClock.rows[0].observedAtMs);
    await primaryDatabase.pool.query(
      `UPDATE "ql3"."trigger_schedules"
          SET next_fire_at_ms = $1,
              state_version = state_version + 1,
              updated_at_ms = $1
        WHERE project_id = 'default' AND trigger_id = $2`,
      [schedulerDueAtMs, schedulerTrigger.triggerId],
    );
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'ha-before-promotion', 'HA Before Promotion', 'ha-before-promotion',
         'active', 1, 1, 1
       )`,
    );
    await waitFor(async () => {
      const marker = await standbyDatabase.pool.query(
        `SELECT count(*)::integer AS count
           FROM "ql3"."projects"
          WHERE id = 'ha-before-promotion'`,
      );
      return marker.rows[0]?.count === 1 ? marker.rows[0] : null;
    }, 'pre-promotion marker WAL replay');
    const projectToolSnapshotProjectId = 'ha-tool-snapshot';
    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         $1, 'HA Tool Snapshot', 'ha-tool-snapshot', 'active', 1, 1, 1
       )`,
      [projectToolSnapshotProjectId],
    );
    const projectToolSnapshotDatabase = await databaseOpener(
      'package-executor',
      databaseUrl(
        PACKAGE_EXECUTOR_USER,
        PACKAGE_EXECUTOR_PASSWORD,
        primaryPort,
      ),
      'ql3-ha-tool-snapshot-primary',
    )();
    try {
      const taskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry();
      const snapshotRepository =
        new PostgresProjectToolDefinitionSnapshotRepository(
          projectToolSnapshotDatabase.pool,
        );
      const publication =
        await new ProjectToolDefinitionSnapshotPublicationCoordinator({
          source: snapshotRepository,
          materializedRepository:
            new PostgresPluginPackageMaterializedRevisionRepository(
              projectToolSnapshotDatabase.pool,
              taskSpecSemanticRegistry,
            ),
          repository: snapshotRepository,
          taskSpecSemanticRegistry,
          pageSize: 4,
        }).publishCurrent(projectToolSnapshotProjectId);
      assert.equal(publication.status, 'created');
      assert.deepEqual(publication.record.snapshot.sources, []);
      assert.deepEqual(publication.record.snapshot.definitions, []);
      projectToolSnapshot = {
        projectId: projectToolSnapshotProjectId,
        activeVectorDigest: publication.record.snapshot.activeVectorDigest,
        definitionsDigest: publication.record.snapshot.definitionsDigest,
        snapshotDigest: publication.record.snapshot.snapshotDigest,
        publishedByPackageExecutor: true,
        replicatedBeforePromotion: false,
        survivedPromotion: false,
      };
    } finally {
      await projectToolSnapshotDatabase.close();
    }
    await waitFor(async () => {
      const result = await standbyDatabase.pool.query(
        `SELECT snapshot_digest AS "snapshotDigest"
           FROM "ql3"."project_tool_definition_snapshots"
          WHERE project_id = $1 AND active_vector_digest = $2`,
        [projectToolSnapshot.projectId, projectToolSnapshot.activeVectorDigest],
      );
      return result.rows[0]?.snapshotDigest ===
        projectToolSnapshot.snapshotDigest
        ? result.rows[0]
        : null;
    }, 'Project Tool snapshot WAL replay');
    projectToolSnapshot.replicatedBeforePromotion = true;
    timeline.push({
      state: 'project_tool_snapshot_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    pluginPackageQuarantine = await runPluginPackageQuarantineMatrix({
      primaryPort,
      migrationPool: primaryDatabase.pool,
      standbyDatabase,
    });
    pluginPackageLifecycle = pluginPackageQuarantine.lifecycle;
    timeline.push({
      state: 'plugin_package_lifecycle_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'plugin_package_quarantine_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'workflow_task_attempt_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'remote_workflow_cancellation_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    publisherTrustTransition = await runPublisherTrustTransitionMatrix({
      primaryPort,
      migrationPool: primaryDatabase.pool,
      standbyDatabase,
    });
    timeline.push({
      state: 'publisher_trust_transition_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    ambiguousClient = new RawPostgresClient({
      connectionString: databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, primaryPort),
      application_name: 'ql3-ha-ambiguous-commit-window',
      connectionTimeoutMillis: 2_000,
    });
    ambiguousClient.on('error', () => {
      // This connection is deliberately terminated after COMMIT.
    });
    await ambiguousClient.connect();
    let ambiguousCommitClientRejected = false;
    let ambiguousCommitCompletedBeforeFault = false;
    try {
      await ambiguousClient.query('BEGIN');
      await ambiguousClient.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES (
           'ha-ambiguous-commit', 'HA Ambiguous Commit',
           'ha-ambiguous-commit', 'active', 1, 2, 2
         )`,
      );
      await ambiguousClient.query('COMMIT');
      ambiguousCommitCompletedBeforeFault = true;
      await ambiguousClient.query(
        'SELECT pg_terminate_backend(pg_backend_pid())',
      );
    } catch {
      ambiguousCommitClientRejected = true;
    }
    assert.equal(
      ambiguousCommitClientRejected,
      true,
      'operation must observe failure after its transaction committed',
    );
    assert.equal(
      ambiguousCommitCompletedBeforeFault,
      true,
      'fault injection must not run before COMMIT completed',
    );
    await waitFor(async () => {
      const marker = await standbyDatabase.pool.query(
        `SELECT count(*)::integer AS count
           FROM "ql3"."projects"
          WHERE id = 'ha-ambiguous-commit'`,
      );
      return marker.rows[0]?.count === 1 ? marker.rows[0] : null;
    }, 'ambiguous committed marker WAL replay');

    uncommittedClient = new RawPostgresClient({
      connectionString: databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, primaryPort),
      application_name: 'ql3-ha-uncommitted-window',
      connectionTimeoutMillis: 2_000,
    });
    uncommittedClient.on('error', () => {
      // Fencing the old primary deliberately terminates this transaction.
    });
    await uncommittedClient.connect();
    await uncommittedClient.query('BEGIN');
    await uncommittedClient.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'ha-uncommitted-before-failover', 'HA Uncommitted Before Failover',
         'ha-uncommitted-before-failover', 'active', 1, 3, 3
       )`,
    );
    const abandonedSchedulerClaim =
      await primarySchedules.claimNextClusterSchedule({
        ownerId: 'ql3-ha-scheduler-generation-1',
        claimToken: '019f8000-0000-7000-8000-000000000004',
        leaseMs: SCHEDULER_FAILOVER_LEASE_MS,
      });
    assert.ok(abandonedSchedulerClaim);
    const abandonedDecision = resolveClusterScheduleDecision(
      abandonedSchedulerClaim,
      30_000,
      cronerClusterNextOccurrence,
    );
    assert.equal(abandonedDecision.disposition, 'admit');
    const replicatedSchedulerClaim = await waitFor(async () => {
      const result = await standbyDatabase.pool.query(
        `SELECT claim_owner AS "claimOwner",
                claim_token::text AS "claimToken",
                claim_version::text AS "claimVersion",
                next_fire_at_ms::text AS "nextFireAtMs"
           FROM "ql3"."trigger_schedules"
          WHERE project_id = 'default' AND trigger_id = $1`,
        [schedulerTrigger.triggerId],
      );
      const row = result.rows[0];
      return row?.claimToken === abandonedSchedulerClaim.claimToken
        ? row
        : null;
    }, 'scheduler claim WAL replay');
    assert.equal(
      replicatedSchedulerClaim.claimOwner,
      abandonedSchedulerClaim.claimOwner,
    );
    assert.equal(
      replicatedSchedulerClaim.claimVersion,
      String(abandonedSchedulerClaim.claimVersion),
    );
    assert.equal(
      replicatedSchedulerClaim.nextFireAtMs,
      String(schedulerDueAtMs),
    );

    proxy = await startEndpointProxy(primaryPort);
    const stableDatabaseUrl = databaseUrl(
      RUNTIME_USER,
      RUNTIME_PASSWORD,
      proxy.port,
    );
    const generationOneNames = [
      'ql3-ha-control-a-generation-1',
      'ql3-ha-control-b-generation-1',
    ];
    replicas.push(
      await startReplica({
        databaseUrl: stableDatabaseUrl,
        replicaId: 'ha-control-a-generation-1',
        applicationName: generationOneNames[0],
      }),
    );
    replicas.push(
      await startReplica({
        databaseUrl: stableDatabaseUrl,
        replicaId: 'ha-control-b-generation-1',
        applicationName: generationOneNames[1],
      }),
    );
    assert.deepEqual(
      replicas.map((replica) => replica.ready.availability),
      ['ready', 'ready'],
    );
    const oldBackends = await waitFor(async () => {
      const rows = await backendFacts(primaryDatabase, generationOneNames);
      return rows.length === 2 ? rows : null;
    }, 'two generation-one control backend connections');
    assert.equal(new Set(oldBackends.map((row) => row.backendPid)).size, 2);
    const preFenceSchedulerState = await primaryDatabase.pool.query(
      `SELECT schedule.claim_owner AS "claimOwner",
              schedule.claim_token::text AS "claimToken",
              schedule.claim_version::text AS "claimVersion",
              schedule.claim_expires_at_ms::text AS "claimExpiresAtMs",
              floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
                AS "observedAtMs",
              (
                SELECT count(*)::integer
                  FROM "ql3"."runs" AS run
                 WHERE run.trigger_id = $1
                   AND run.scheduled_for_ms = $2
              ) AS "occurrenceCount"
         FROM "ql3"."trigger_schedules" AS schedule
        WHERE schedule.project_id = 'default'
          AND schedule.trigger_id = $1`,
      [schedulerTrigger.triggerId, schedulerDueAtMs],
    );
    assert.equal(preFenceSchedulerState.rowCount, 1);
    const preFenceClaim = preFenceSchedulerState.rows[0];
    assert.deepEqual(
      {
        claimOwner: preFenceClaim.claimOwner,
        claimToken: preFenceClaim.claimToken,
        claimVersion: preFenceClaim.claimVersion,
        occurrenceCount: preFenceClaim.occurrenceCount,
      },
      {
        claimOwner: abandonedSchedulerClaim.claimOwner,
        claimToken: abandonedSchedulerClaim.claimToken,
        claimVersion: String(abandonedSchedulerClaim.claimVersion),
        occurrenceCount: 0,
      },
    );
    const preFenceClaimRemainingMs =
      Number(preFenceClaim.claimExpiresAtMs) -
      Number(preFenceClaim.observedAtMs);
    assert.ok(
      preFenceClaimRemainingMs >= MIN_PRE_FENCE_CLAIM_REMAINING_MS,
      `scheduler claim must retain at least ${MIN_PRE_FENCE_CLAIM_REMAINING_MS}ms before old-primary fencing; observed ${preFenceClaimRemainingMs}ms`,
    );
    timeline.push({
      state: 'two_control_replicas_ready',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    runAttemptLogRetentionEvidence =
      await persistRunAttemptLogRetentionClaimBeforePromotion({
        primaryPort,
        primaryDatabase,
        standbyDatabase,
      });
    timeline.push({
      state: 'run_attempt_log_retention_claim_replicated',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    await primaryDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'ha-sync-before-partition', 'HA Sync Before Partition',
         'ha-sync-before-partition', 'active', 1, 4, 4
       )`,
    );
    await waitFor(async () => {
      const marker = await standbyDatabase.pool.query(
        `SELECT count(*)::integer AS count
           FROM "ql3"."projects"
          WHERE id = 'ha-sync-before-partition'`,
      );
      return marker.rows[0]?.count === 1 ? marker.rows[0] : null;
    }, 'synchronous commit marker remote apply');
    await standbyDatabase.close();
    standbyDatabase = undefined;
    docker(['network', 'disconnect', '--force', names.network, names.primary]);
    const terminatedWalSenders = await primaryDatabase.pool.query(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_replication`,
    );
    assert.deepEqual(
      terminatedWalSenders.rows,
      [{ terminated: true }],
      'partition fixture must terminate exactly one pre-existing WAL sender',
    );
    const partitionState = await waitFor(async () => {
      const primaryReplication = await primaryDatabase.pool.query(
        `SELECT count(*)::integer AS count FROM pg_stat_replication`,
      );
      const standbyReceiverFacts = JSON.parse(
        docker([
          'exec',
          names.standby,
          'psql',
          '-U',
          SUPERUSER,
          '-d',
          DATABASE,
          '-Atqc',
          `SELECT COALESCE(json_agg(receiver), '[]'::json)::text
             FROM (
               SELECT status, sender_host AS "senderHost",
                      sender_port AS "senderPort"
                 FROM pg_stat_wal_receiver
             ) AS receiver`,
        ]).stdout,
      );
      const standbyStreamingWalReceivers = standbyReceiverFacts.filter(
        (receiver) => receiver.status === 'streaming',
      ).length;
      const replicationNetwork = JSON.parse(
        docker([
          'network',
          'inspect',
          names.network,
          '--format',
          '{{json .Containers}}',
        ]).stdout,
      );
      const attachedContainers = Object.values(replicationNetwork ?? {})
        .map((container) => container?.Name)
        .filter(Boolean);
      if (
        !attachedContainers.includes(names.primary) &&
        primaryReplication.rows[0]?.count === 0
      ) {
        return {
          primaryWalSenders: primaryReplication.rows[0].count,
          standbyStreamingWalReceivers,
          standbyReceiverFacts,
          standbyAttachedToReplicationNetwork: true,
          oldPrimaryAttachedToReplicationNetwork: false,
        };
      }
      throw new Error(
        JSON.stringify({
          primaryWalSenders: primaryReplication.rows[0]?.count,
          standbyReceiverFacts,
          attachedContainers,
        }),
      );
    }, 'physical replication network partition');
    assert.throws(
      () => promoteStandbyAfterPrimaryFence(names.primary, names.standby),
      (error) => error?.code === 'QL3_HA_PRIMARY_NOT_FENCED',
      'promotion guard must reject a still-writable old primary',
    );

    partitionClient = new RawPostgresClient({
      connectionString: databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, primaryPort),
      application_name: 'ql3-ha-partitioned-synchronous-commit',
      connectionTimeoutMillis: 2_000,
    });
    partitionClient.on('error', () => {
      // The fixture deliberately terminates this SyncRep-waiting backend.
    });
    await partitionClient.connect();
    await partitionClient.query(`SET synchronous_commit = 'remote_apply'`);
    const partitionBackend = await partitionClient.query(
      `SELECT pg_backend_pid() AS "backendPid"`,
    );
    const partitionBackendPid = partitionBackend.rows[0]?.backendPid;
    assert.ok(Number.isInteger(partitionBackendPid));
    await partitionClient.query('BEGIN');
    await partitionClient.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'ha-partition-outcome-unknown', 'HA Partition Outcome Unknown',
         'ha-partition-outcome-unknown', 'active', 1, 5, 5
       )`,
    );
    const partitionCommitStartedAt = performance.now();
    const partitionCommitOutcome = partitionClient.query('COMMIT').then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );
    await waitFor(async () => {
      const result = await primaryDatabase.pool.query(
        `SELECT state, wait_event_type AS "waitEventType",
                wait_event AS "waitEvent"
           FROM pg_stat_activity
          WHERE pid = $1`,
        [partitionBackendPid],
      );
      const row = result.rows[0];
      return row?.state === 'active' &&
        row?.waitEventType === 'IPC' &&
        row?.waitEvent === 'SyncRep'
        ? row
        : null;
    }, 'partitioned COMMIT synchronous replication wait');
    await delay(1_500);
    const partitionBackendTermination = await primaryDatabase.pool.query(
      `SELECT pg_terminate_backend($1) AS terminated`,
      [partitionBackendPid],
    );
    assert.deepEqual(partitionBackendTermination.rows, [{ terminated: true }]);
    const partitionCommitResult = await partitionCommitOutcome;
    assert.equal(
      partitionCommitResult.status,
      'rejected',
      'remote_apply COMMIT must not acknowledge while the standby is partitioned',
    );
    const partitionCommitError = partitionCommitResult.error;
    assert.ok(
      partitionCommitError?.code === '57P01' ||
        /connection terminated/i.test(partitionCommitError?.message ?? ''),
      'partitioned COMMIT must fail through connection termination',
    );
    const partitionCommitRejectedMs =
      performance.now() - partitionCommitStartedAt;
    await partitionClient.end().catch(() => {});
    partitionClient = undefined;
    const partitionMarkers = await primaryDatabase.pool.query(
      `SELECT count(*)::integer AS count
         FROM "ql3"."projects"
        WHERE id = 'ha-partition-outcome-unknown'`,
    );
    assert.equal(partitionMarkers.rows[0]?.count, 1);
    const partitionStandbyMarkers = Number(
      docker([
        'exec',
        names.standby,
        'psql',
        '-U',
        SUPERUSER,
        '-d',
        DATABASE,
        '-Atqc',
        `SELECT count(*) FROM "ql3"."projects" WHERE id = 'ha-partition-outcome-unknown'`,
      ]).stdout,
    );
    assert.equal(partitionStandbyMarkers, 0);
    networkPartition = {
      topology: 'dedicated Docker replication network',
      existingWalSenderTerminatedAfterNetworkDetach: true,
      synchronousCommit: 'remote_apply',
      syncStateBeforePartition: synchronousReplicationBeforePartition.syncState,
      ...partitionState,
      promotionRejectedWhileOldPrimaryWritable: true,
      commitClientObservedFailure: true,
      commitErrorCode: partitionCommitError.code ?? 'CONNECTION_TERMINATED',
      clientTimeoutBackendTerminated: true,
      commitRejectedMs: Number(partitionCommitRejectedMs.toFixed(3)),
      locallyCommittedOnFencedPrimary: partitionMarkers.rows[0].count,
      replicatedToPromotionCandidate: partitionStandbyMarkers,
      acknowledgedWriteLost: false,
    };
    timeline.push({
      state: 'replication_partition_and_promotion_guard_verified',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    await primaryDatabase.close();
    primaryDatabase = undefined;
    const failureStartedAt = performance.now();
    docker(['stop', '--timeout', '10', names.primary]);
    const primaryState = docker([
      'inspect',
      names.primary,
      '--format',
      '{{.State.Running}}|{{.State.Status}}',
    ]).stdout;
    assert.equal(primaryState, 'false|exited');
    await assert.rejects(
      uncommittedClient.query('COMMIT'),
      'an uncommitted write must lose its transaction when the old primary is fenced',
    );
    await uncommittedClient.end().catch(() => {});
    uncommittedClient = undefined;
    await ambiguousClient.end().catch(() => {});
    ambiguousClient = undefined;
    const unavailableStatuses = await waitForReplicasUnavailable(replicas);
    const failClosedMs = performance.now() - failureStartedAt;
    for (const replica of replicas) {
      assert.deepEqual(await probe(replica.ready.address, '/readyz'), {
        statusCode: 503,
        body: { status: 'not_ready' },
      });
      assert.deepEqual(await probe(replica.ready.address, '/livez'), {
        statusCode: 200,
        body: { status: 'live' },
      });
    }
    timeline.push({
      state: 'old_primary_fenced_and_admission_withdrawn',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    promoteStandbyAfterPrimaryFence(names.primary, names.standby);
    docker([
      'network',
      'connect',
      '--alias',
      'primary',
      names.network,
      names.primary,
    ]);
    promotedDatabase = await databaseOpener(
      'migration',
      databaseUrl(SUPERUSER, SUPERUSER_PASSWORD, standbyPort),
      'ql3-ha-migration-promoted',
    )();
    await waitFor(async () => {
      const state = await promotedDatabase.pool.query(
        `SELECT pg_is_in_recovery() AS "inRecovery"`,
      );
      return state.rows[0]?.inRecovery === false ? state.rows[0] : null;
    }, 'standby promotion');
    await promotedDatabase.pool.query(
      `ALTER SYSTEM SET synchronous_standby_names = '*'`,
    );
    await promotedDatabase.pool.query(
      `ALTER SYSTEM SET synchronous_commit = 'remote_apply'`,
    );
    await promotedDatabase.pool.query('SELECT pg_reload_conf()');
    const promotionClock = await promotedDatabase.pool.query(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text
              AS "observedAtMs"`,
    );
    const promotedAtMs = Number(promotionClock.rows[0].observedAtMs);
    const promotedTimeline = await timelineId(promotedDatabase);
    assert.ok(promotedTimeline > primaryTimeline);
    const promotedModelInvocationFeature = await modelInvocationFeatureFacts(
      promotedDatabase.pool,
    );
    assert.deepEqual(
      promotedModelInvocationFeature,
      modelInvocationFeaturePromotion.beforePromotion,
    );
    modelInvocationFeaturePromotion.afterPromotion =
      promotedModelInvocationFeature;
    modelInvocationFeaturePromotion.survivedPromotion = true;
    await verifyModelProviderCredentialCatalogAfterPromotion({
      promotedPort: standbyPort,
      promotedPool: promotedDatabase.pool,
      report: modelProviderCredentialCatalog,
    });
    await verifyModelProviderCredentialTestConnectionAfterPromotion({
      promotedPort: standbyPort,
      promotedPool: promotedDatabase.pool,
      report: modelProviderCredentialTestConnection,
    });
    await verifyManualRunRetryAfterPromotion({
      promotedPool: promotedDatabase.pool,
      evidence: manualRunRetry,
    });
    timeline.push({
      state: 'manual_run_retry_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'optional_ai_feature_schema_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const promotedPromptExecution = {
      ...(await pluginPackagePromptFacts(
        promotedDatabase.pool,
        pluginPackageQuarantine.promptExecution.requestId,
      )),
      catalog: await pluginPackagePromptCatalogFacts(
        promotedDatabase.pool,
        pluginPackageQuarantine.promptExecution.beforePromotion.catalog
          .projectId,
        pluginPackageQuarantine.promptExecution.beforePromotion.catalog
          .packageName,
      ),
      audit: await pluginPackagePromptAuditFacts(
        promotedDatabase.pool,
        pluginPackageQuarantine.promptExecution.requestId,
      ),
      keyRotation: await pluginPackagePromptOutputKeyRotationFacts(
        promotedDatabase.pool,
        pluginPackageQuarantine.promptExecution.beforePromotion.keyRotation
          .rotationId,
        pluginPackagePromptOutputKeyRotationForbiddenValues(),
      ),
      keyRetirement: await pluginPackagePromptOutputKeyRetirementFacts(
        promotedDatabase.pool,
        pluginPackageQuarantine.promptExecution.beforePromotion.keyRetirement
          .keyId,
      ),
    };
    assert.deepEqual(
      promotedPromptExecution,
      pluginPackageQuarantine.promptExecution.beforePromotion,
    );
    pluginPackageQuarantine.promptExecution.afterPromotion =
      promotedPromptExecution;
    pluginPackageQuarantine.promptExecution.survivedPromotion = true;
    timeline.push({
      state: 'plugin_package_prompt_execution_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const promotedPackageManagerDatabase = await databaseOpener(
      'package-manager',
      databaseUrl(PACKAGE_MANAGER_USER, PACKAGE_MANAGER_PASSWORD, standbyPort),
      'ql3-ha-package-manager-promoted-readiness',
    )();
    const promotedAutomationManagerDatabase = await databaseOpener(
      'automation-manager',
      databaseUrl(
        AUTOMATION_MANAGER_USER,
        AUTOMATION_MANAGER_PASSWORD,
        standbyPort,
      ),
      'ql3-ha-automation-manager-promoted-readiness',
    )();
    const promotedPackageExecutorDatabase = await databaseOpener(
      'package-executor',
      databaseUrl(
        PACKAGE_EXECUTOR_USER,
        PACKAGE_EXECUTOR_PASSWORD,
        standbyPort,
      ),
      'ql3-ha-package-executor-promoted-readiness',
    )();
    const promotedWorkerManagerDatabase = await databaseOpener(
      'worker-credential-manager',
      databaseUrl(
        WORKER_CREDENTIAL_MANAGER_USER,
        WORKER_CREDENTIAL_MANAGER_PASSWORD,
        standbyPort,
      ),
      'ql3-ha-worker-manager-promoted-readiness',
    )();
    const promotedWorkerExecutorDatabase = await databaseOpener(
      'worker-credential-executor',
      databaseUrl(
        WORKER_CREDENTIAL_EXECUTOR_USER,
        WORKER_CREDENTIAL_EXECUTOR_PASSWORD,
        standbyPort,
      ),
      'ql3-ha-worker-executor-promoted-readiness',
    )();
    try {
      await assertPostgresAutomationManagerSchemaReady(
        promotedAutomationManagerDatabase.pool,
      );
      await assertPostgresPackageManagerSchemaReady(
        promotedPackageManagerDatabase.pool,
      );
      await assertPostgresPackageExecutorSchemaReady(
        promotedPackageExecutorDatabase.pool,
      );
      await assertPostgresWorkerCredentialManagerSchemaReady(
        promotedWorkerManagerDatabase.pool,
      );
      await assertPostgresWorkerCredentialExecutorSchemaReady(
        promotedWorkerExecutorDatabase.pool,
      );
      await assertAutomationManagementInspectionFailsClosed({
        database: promotedAutomationManagerDatabase,
        report: automationManagementInspection,
      });
      const promotedSnapshot =
        await new PostgresProjectToolDefinitionSnapshotRepository(
          promotedPackageExecutorDatabase.pool,
        ).findCurrent(projectToolSnapshot.projectId);
      assert.ok(promotedSnapshot);
      assert.equal(
        promotedSnapshot.snapshot.activeVectorDigest,
        projectToolSnapshot.activeVectorDigest,
      );
      assert.equal(
        promotedSnapshot.snapshot.definitionsDigest,
        projectToolSnapshot.definitionsDigest,
      );
      assert.equal(
        promotedSnapshot.snapshot.snapshotDigest,
        projectToolSnapshot.snapshotDigest,
      );
      assert.deepEqual(promotedSnapshot.snapshot.sources, []);
      assert.deepEqual(promotedSnapshot.snapshot.definitions, []);
      projectToolSnapshot.survivedPromotion = true;
      await verifyToolInvocationArtifactAfterPromotion({
        promotedPort: standbyPort,
        promotedDatabase,
        pair: toolInvocationArtifactPairForPromotion,
      });
      toolInvocationArtifact.survivedPromotion = true;
      const promotedToolResultRuntimeDatabase = await databaseOpener(
        'runtime',
        databaseUrl(RUNTIME_USER, RUNTIME_PASSWORD, standbyPort),
        'ql3-ha-tool-result-runtime-promoted',
      )();
      const promotedToolResultAdminDatabase = await databaseOpener(
        'admin',
        databaseUrl(ADMIN_USER, ADMIN_PASSWORD, standbyPort),
        'ql3-ha-tool-result-admin-promoted',
      )();
      try {
        await verifyPromotedNonEmptyToolResult({
          runtimePool: promotedToolResultRuntimeDatabase.pool,
          adminPool: promotedToolResultAdminDatabase.pool,
          fixture: toolResultKeyFixture,
          report: toolResultKeyRetirement,
        });
      } finally {
        await Promise.all([
          promotedToolResultRuntimeDatabase.close(),
          promotedToolResultAdminDatabase.close(),
        ]);
      }
    } finally {
      await Promise.all([
        promotedPackageManagerDatabase.close(),
        promotedAutomationManagerDatabase.close(),
        promotedPackageExecutorDatabase.close(),
        promotedWorkerManagerDatabase.close(),
        promotedWorkerExecutorDatabase.close(),
      ]);
    }
    timeline.push({
      state: 'package_authority_split_reconnected_after_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state:
        'automation_management_inspection_failed_closed_without_sync_standby',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const promotedPartitionMarkers = await promotedDatabase.pool.query(
      `SELECT count(*)::integer AS count
         FROM "ql3"."projects"
        WHERE id = 'ha-partition-outcome-unknown'`,
    );
    assert.equal(promotedPartitionMarkers.rows[0]?.count, 0);
    networkPartition.promotedPrimaryRows =
      promotedPartitionMarkers.rows[0].count;
    networkPartition.unacknowledgedLocalCommitDiscarded = true;
    const promotedCredentialFacts = await credentialDeliveryFacts(
      promotedDatabase.pool,
      credentialDelivery.fixture,
    );
    assert.deepEqual(promotedCredentialFacts.deliveryVersions, [1, 2, 3, 4]);
    assert.deepEqual(promotedCredentialFacts.deliveryStates, [
      'credential_committed',
      'published',
      'observed',
      'previous_revoked',
    ]);
    assert.deepEqual(promotedCredentialFacts.previousCredentialStates, [
      'active',
      'revoked',
    ]);
    assert.equal(promotedCredentialFacts.credentialRows, 3);
    assert.equal(promotedCredentialFacts.mutationRows, 3);
    assert.equal(promotedCredentialFacts.auditRows, 3);
    assert.equal(promotedCredentialFacts.sessionVersion, 1);
    assert.equal(promotedCredentialFacts.secretPersistedInPostgres, false);
    credentialDelivery.report.survivedPromotion = true;
    credentialDelivery.report.promotedFacts = promotedCredentialFacts;
    const promotedDomainFacts = await runDomainCommitResponseLossFacts(
      promotedDatabase.pool,
      domainCommitResponseLoss.fixture,
    );
    assertDomainCommitResponseLossFacts(
      promotedDomainFacts,
      domainCommitResponseLoss.fixture,
    );
    domainCommitResponseLoss.report.survivedPromotion = true;
    domainCommitResponseLoss.report.promotedFacts = promotedDomainFacts;

    const rejoinSlot = await promotedDatabase.pool.query(
      `SELECT slot_name AS "slotName"
         FROM pg_create_physical_replication_slot($1)`,
      [names.rejoinReplicationSlot],
    );
    assert.deepEqual(rejoinSlot.rows, [
      { slotName: names.rejoinReplicationSlot },
    ]);
    const rewindStartedAt = performance.now();
    const rewind = docker(
      [
        'run',
        '--rm',
        '--network',
        names.network,
        '--user',
        'postgres',
        '--entrypoint',
        'pg_rewind',
        '-v',
        `${names.primaryVolume}:${POSTGRES_VOLUME_ROOT}`,
        IMAGE,
        `--target-pgdata=${POSTGRES_DATA}`,
        '--source-server',
        `host=standby port=5432 user=${SUPERUSER} dbname=${DATABASE} application_name=ql3-ha-pg-rewind`,
        '--write-recovery-conf',
        '--progress',
      ],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
    docker([
      'run',
      '--rm',
      '--user',
      'postgres',
      '--entrypoint',
      'sh',
      '-v',
      `${names.primaryVolume}:${POSTGRES_VOLUME_ROOT}`,
      IMAGE,
      '-c',
      `printf '%s\\n' "primary_conninfo = 'host=standby port=5432 user=${REPLICATION_USER} application_name=ql3-ha-rejoined-primary'" "primary_slot_name = '${names.rejoinReplicationSlot}'" >> ${POSTGRES_DATA}/postgresql.auto.conf`,
    ]);
    docker(['start', names.primary]);
    await waitForPostgres(names.primary);
    const rejoinedStandbyState = await waitFor(async () => {
      const result = docker(
        [
          'exec',
          names.primary,
          'psql',
          '-U',
          SUPERUSER,
          '-d',
          DATABASE,
          '-Atqc',
          `SELECT pg_is_in_recovery(),
                  EXISTS (
                    SELECT 1 FROM pg_stat_wal_receiver
                     WHERE status = 'streaming'
                  )`,
        ],
        { allowFailure: true },
      );
      const [inRecovery, streaming] = result.stdout.split('|');
      return result.status === 0 && inRecovery === 't' && streaming === 't'
        ? { inRecovery: true, streaming: true }
        : null;
    }, 'rewound old primary streaming as standby');
    const promotedSyncState = await waitFor(async () => {
      const result = await promotedDatabase.pool.query(
        `SELECT application_name AS "applicationName",
                state, sync_state AS "syncState"
         FROM pg_stat_replication
          WHERE application_name = 'ql3-ha-rejoined-primary'`,
      );
      return (
        result.rows.find(
          (row) => row.state === 'streaming' && row.syncState === 'sync',
        ) ?? null
      );
    }, 'rewound old primary synchronous replication');
    await promotedDatabase.pool.query(
      `SET synchronous_commit = 'remote_apply'`,
    );
    await promotedDatabase.pool.query(
      `INSERT INTO "ql3"."projects" (
         id, name, slug, status, version, created_at_ms, updated_at_ms
       ) VALUES (
         'ha-after-rejoin', 'HA After Rejoin', 'ha-after-rejoin',
         'active', 1, 6, 6
       )`,
    );
    const rejoinedFacts = await waitFor(async () => {
      const result = docker(
        [
          'exec',
          names.primary,
          'psql',
          '-U',
          SUPERUSER,
          '-d',
          DATABASE,
          '-Atqc',
          `SELECT
             count(*) FILTER (
               WHERE id = 'ha-after-rejoin'
             )::integer,
             count(*) FILTER (
               WHERE id = 'ha-partition-outcome-unknown'
             )::integer
           FROM "ql3"."projects"`,
        ],
        { allowFailure: true },
      );
      const [afterRejoinMarkers, partitionOutcomeUnknownMarkers] = result.stdout
        .split('|')
        .map(Number);
      return result.status === 0 &&
        afterRejoinMarkers === 1 &&
        partitionOutcomeUnknownMarkers === 0
        ? { afterRejoinMarkers, partitionOutcomeUnknownMarkers }
        : null;
    }, 'post-rewind synchronous WAL replay');
    runAttemptLogRetention = await verifyRunAttemptLogRetentionAfterPromotion({
      promotedPort: standbyPort,
      promotedDatabase,
      evidence: runAttemptLogRetentionEvidence,
    });
    timeline.push({
      state: 'run_attempt_log_retention_tombstone_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    const recoveredAutomationManagerDatabase = await databaseOpener(
      'automation-manager',
      databaseUrl(
        AUTOMATION_MANAGER_USER,
        AUTOMATION_MANAGER_PASSWORD,
        standbyPort,
      ),
      'ql3-ha-automation-inspection-recovered',
    )();
    try {
      await assertPostgresAutomationManagerSchemaReady(
        recoveredAutomationManagerDatabase.pool,
      );
      await verifyAutomationManagementInspectionAfterPromotion({
        database: recoveredAutomationManagerDatabase,
        report: automationManagementInspection,
      });
    } finally {
      await recoveredAutomationManagerDatabase.close();
    }
    timeline.push({
      state: 'automation_management_inspection_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await verifyPluginPackageQuarantineAfterPromotion({
      promotedPort: standbyPort,
      promotedDatabase,
      quarantine: pluginPackageQuarantine,
    });
    await verifyRemoteWorkflowCancellationAfterPromotion({
      promotedPort: standbyPort,
      promotedDatabase,
      evidence: pluginPackageQuarantine.remoteWorkflowCancellation,
    });
    await verifyPluginPackagePromptExecutionInspectionAfterPromotion({
      promotedPort: standbyPort,
      promotedPool: promotedDatabase.pool,
      evidence: pluginPackageQuarantine.promptExecution.executionInspection,
    });
    timeline.push({
      state: 'plugin_package_prompt_execution_inspection_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await verifyPluginPackagePromptExecutionOutputAfterPromotion({
      promotedPort: standbyPort,
      evidence: pluginPackageQuarantine.promptExecution.outputRecovery,
    });
    timeline.push({
      state: 'plugin_package_prompt_execution_output_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await verifyPluginPackageLifecycleAfterPromotion({
      promotedPort: standbyPort,
      promotedDatabase,
      lifecycle: pluginPackageLifecycle,
    });
    timeline.push({
      state: 'plugin_package_lifecycle_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'plugin_package_quarantine_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'workflow_task_attempt_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    timeline.push({
      state: 'remote_workflow_cancellation_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    await verifyPublisherTrustTransitionAfterPromotion({
      promotedDatabase,
      transition: publisherTrustTransition,
    });
    timeline.push({
      state: 'publisher_trust_transition_survived_promotion',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });
    oldPrimaryRejoin = {
      method: 'pg_rewind --write-recovery-conf',
      rewindExitStatus: rewind.status,
      rewindCompletedMs: Number(
        (performance.now() - rewindStartedAt).toFixed(3),
      ),
      inRecovery: rejoinedStandbyState.inRecovery,
      streaming: rejoinedStandbyState.streaming,
      synchronousState: promotedSyncState.syncState,
      replicationSlot: names.rejoinReplicationSlot,
      afterRejoinMarkers: rejoinedFacts.afterRejoinMarkers,
      divergentPartitionMarkers: rejoinedFacts.partitionOutcomeUnknownMarkers,
      rejoinedAsWritablePrimary: false,
    };
    proxy.switchTarget(standbyPort);
    assert.deepEqual(
      await replicaStatuses(replicas),
      unavailableStatuses,
      'old activations must remain unavailable after endpoint recovery',
    );
    timeline.push({
      state: 'standby_promoted_old_primary_rejoined_endpoint_switched',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    for (const replica of replicas.splice(0)) await replica.stop();
    const generationTwoNames = [
      'ql3-ha-control-a-generation-2',
      'ql3-ha-control-b-generation-2',
    ];
    const reactivationStartedAt = performance.now();
    replicas.push(
      await startReplica({
        databaseUrl: stableDatabaseUrl,
        replicaId: 'ha-control-a-generation-2',
        applicationName: generationTwoNames[0],
      }),
      await startReplica({
        databaseUrl: stableDatabaseUrl,
        replicaId: 'ha-control-b-generation-2',
        applicationName: generationTwoNames[1],
      }),
    );
    const reactivationMs = performance.now() - reactivationStartedAt;
    const newBackends = await waitFor(async () => {
      const rows = await backendFacts(promotedDatabase, generationTwoNames);
      return rows.length === 2 ? rows : null;
    }, 'two generation-two control backend connections');
    assert.equal(new Set(newBackends.map((row) => row.backendPid)).size, 2);
    for (const replica of replicas) {
      assert.equal(replica.ready.availability, 'ready');
      assert.deepEqual(await probe(replica.ready.address, '/readyz'), {
        statusCode: 200,
        body: { status: 'ready' },
      });
    }

    const schedulerOccurrence = await waitFor(async () => {
      const result = await promotedDatabase.pool.query(
        `SELECT run.id AS "runId",
                run.status,
                run.scheduled_for_ms::text AS "scheduledForMs",
                run.created_at_ms::text AS "createdAtMs",
                attempt.id AS "attemptId",
                attempt.status AS "attemptStatus",
                attempt.executor_type AS "executorType",
                count(event.id)::integer AS "eventCount"
           FROM "ql3"."runs" AS run
           JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
           JOIN "ql3"."run_events" AS event ON event.run_id = run.id
          WHERE run.trigger_id = $1 AND run.scheduled_for_ms = $2
          GROUP BY run.id, run.status, run.scheduled_for_ms, run.created_at_ms,
                   attempt.id, attempt.status, attempt.executor_type`,
        [schedulerTrigger.triggerId, schedulerDueAtMs],
      );
      return result.rows.length === 1 && result.rows[0].eventCount === 2
        ? result.rows[0]
        : null;
    }, 'post-promotion scheduler claim takeover and admission');
    assert.deepEqual(
      {
        status: schedulerOccurrence.status,
        scheduledForMs: schedulerOccurrence.scheduledForMs,
        attemptStatus: schedulerOccurrence.attemptStatus,
        executorType: schedulerOccurrence.executorType,
        eventCount: schedulerOccurrence.eventCount,
      },
      {
        status: 'queued',
        scheduledForMs: String(schedulerDueAtMs),
        attemptStatus: 'claimed',
        executorType: 'remote_worker',
        eventCount: 2,
      },
    );
    assert.ok(
      Number(schedulerOccurrence.createdAtMs) >= promotedAtMs,
      'scheduler occurrence must be admitted after standby promotion',
    );
    assert.ok(
      Number(schedulerOccurrence.createdAtMs) >=
        abandonedSchedulerClaim.claimExpiresAtMs,
      'scheduler occurrence must be admitted only after the abandoned claim expires',
    );
    const schedulerOccurrenceCounts = await promotedDatabase.pool.query(
      `SELECT
         (
           SELECT count(*)::integer
             FROM "ql3"."runs" AS run
            WHERE run.trigger_id = $1
              AND run.scheduled_for_ms = $2
         ) AS "runCount",
         (
           SELECT count(*)::integer
             FROM "ql3"."run_attempts" AS attempt
             JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
            WHERE run.trigger_id = $1
              AND run.scheduled_for_ms = $2
         ) AS "attemptCount",
         (
           SELECT count(*)::integer
             FROM "ql3"."run_events" AS event
             JOIN "ql3"."runs" AS run ON run.id = event.run_id
            WHERE run.trigger_id = $1
              AND run.scheduled_for_ms = $2
         ) AS "eventCount"`,
      [schedulerTrigger.triggerId, schedulerDueAtMs],
    );
    assert.deepEqual(schedulerOccurrenceCounts.rows, [
      { runCount: 1, attemptCount: 1, eventCount: 2 },
    ]);
    const schedulerSchedule = await promotedDatabase.pool.query(
      `SELECT claim_owner AS "claimOwner",
              claim_token::text AS "claimToken",
              claim_version::text AS "claimVersion",
              last_scheduled_at_ms::text AS "lastScheduledAtMs"
         FROM "ql3"."trigger_schedules"
        WHERE project_id = 'default' AND trigger_id = $1`,
      [schedulerTrigger.triggerId],
    );
    assert.equal(schedulerSchedule.rowCount, 1);
    assert.equal(schedulerSchedule.rows[0].claimOwner, null);
    assert.equal(schedulerSchedule.rows[0].claimToken, null);
    assert.ok(
      Number(schedulerSchedule.rows[0].claimVersion) >
        abandonedSchedulerClaim.claimVersion,
    );
    assert.equal(
      schedulerSchedule.rows[0].lastScheduledAtMs,
      String(schedulerDueAtMs),
    );
    schedulerFailover = {
      triggerId: schedulerTrigger.triggerId,
      scheduledForMs: String(schedulerDueAtMs),
      abandonedClaim: {
        ownerId: abandonedSchedulerClaim.claimOwner,
        token: abandonedSchedulerClaim.claimToken,
        version: abandonedSchedulerClaim.claimVersion,
        acquiredAtMs: abandonedSchedulerClaim.claimAcquiredAtMs,
        expiresAtMs: abandonedSchedulerClaim.claimExpiresAtMs,
        replicatedBeforePromotion: true,
        preFenceObservedAtMs: Number(preFenceClaim.observedAtMs),
        preFenceRemainingMs: preFenceClaimRemainingMs,
        occurrenceCountBeforeFence: preFenceClaim.occurrenceCount,
      },
      takeover: {
        promotedAtMs,
        admittedAtMs: Number(schedulerOccurrence.createdAtMs),
        finalClaimVersion: Number(schedulerSchedule.rows[0].claimVersion),
        finalClaimCleared: true,
        runId: schedulerOccurrence.runId,
        attemptId: schedulerOccurrence.attemptId,
        runStatus: schedulerOccurrence.status,
        attemptStatus: schedulerOccurrence.attemptStatus,
        executorType: schedulerOccurrence.executorType,
        runCount: schedulerOccurrenceCounts.rows[0].runCount,
        attemptCount: schedulerOccurrenceCounts.rows[0].attemptCount,
        eventCount: schedulerOccurrenceCounts.rows[0].eventCount,
      },
      duplicateOccurrences: schedulerOccurrenceCounts.rows[0].runCount - 1,
    };
    const schedulerCommitResponseLossFacts = await promotedDatabase.pool.query(
      `SELECT schedule.claim_owner AS "claimOwner",
                schedule.claim_token::text AS "claimToken",
                schedule.claim_version::text AS "claimVersion",
                schedule.last_scheduled_at_ms::text AS "lastScheduledAtMs",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."runs" AS run
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "runCount",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."run_attempts" AS attempt
                    JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "attemptCount",
                (
                  SELECT count(*)::integer
                    FROM "ql3"."run_events" AS event
                    JOIN "ql3"."runs" AS run ON run.id = event.run_id
                   WHERE run.trigger_id = $1
                     AND run.scheduled_for_ms = $2
                ) AS "eventCount"
           FROM "ql3"."trigger_schedules" AS schedule
          WHERE schedule.project_id = 'default'
            AND schedule.trigger_id = $1`,
      [ambiguousSchedulerTrigger.triggerId, ambiguousSchedulerDueAtMs],
    );
    assert.deepEqual(schedulerCommitResponseLossFacts.rows, [
      {
        claimOwner: null,
        claimToken: null,
        claimVersion: replicatedAmbiguousScheduler.claimVersion,
        lastScheduledAtMs: String(ambiguousSchedulerDueAtMs),
        runCount: 1,
        attemptCount: 1,
        eventCount: 2,
      },
    ]);
    const schedulerCommitResponseLoss = {
      triggerId: ambiguousSchedulerTrigger.triggerId,
      scheduledForMs: String(ambiguousSchedulerDueAtMs),
      clientObservedFailure: true,
      commitCompletedBeforeFault:
        schedulerCommitFault.commitCompletedBeforeFault,
      backendTerminationRequested:
        schedulerCommitFault.backendTerminationRequested,
      backendConnectionRejected: schedulerCommitFault.backendConnectionRejected,
      replicatedBeforePromotion: true,
      claimVersion: Number(
        schedulerCommitResponseLossFacts.rows[0].claimVersion,
      ),
      finalClaimCleared: true,
      runCount: schedulerCommitResponseLossFacts.rows[0].runCount,
      attemptCount: schedulerCommitResponseLossFacts.rows[0].attemptCount,
      eventCount: schedulerCommitResponseLossFacts.rows[0].eventCount,
      duplicateOccurrences:
        schedulerCommitResponseLossFacts.rows[0].runCount - 1,
      faultScope:
        'PostgresClient boundary after driver-confirmed COMMIT plus backend self-termination; not a raw-wire packet-loss fixture',
    };

    const promotedRuntime = await databaseOpener(
      'runtime',
      stableDatabaseUrl,
      'ql3-ha-post-promotion-verifier',
    )();
    try {
      await promotedRuntime.pool.query(
        `INSERT INTO "ql3"."projects" (
           id, name, slug, status, version, created_at_ms, updated_at_ms
         ) VALUES (
           'ha-after-promotion', 'HA After Promotion', 'ha-after-promotion',
           'active', 1, 2, 2
         )`,
      );
    } finally {
      await promotedRuntime.close();
    }
    const durableFacts = await promotedDatabase.pool.query(
      `SELECT
         count(*) FILTER (
           WHERE id = 'ha-before-promotion'
         )::integer AS "beforePromotionMarkers",
         count(*) FILTER (
           WHERE id = 'ha-after-promotion'
         )::integer AS "afterPromotionMarkers",
         count(*) FILTER (
           WHERE id = 'ha-ambiguous-commit'
         )::integer AS "ambiguousCommitMarkers",
         count(*) FILTER (
           WHERE id = 'ha-uncommitted-before-failover'
         )::integer AS "uncommittedMarkers",
         count(*) FILTER (
           WHERE id = 'ha-sync-before-partition'
         )::integer AS "synchronousMarkers",
         count(*) FILTER (
           WHERE id = 'ha-partition-outcome-unknown'
         )::integer AS "partitionOutcomeUnknownMarkers",
         count(*) FILTER (
           WHERE id = 'ha-after-rejoin'
         )::integer AS "afterRejoinMarkers"
       FROM "ql3"."projects"`,
    );
    assert.deepEqual(durableFacts.rows, [
      {
        beforePromotionMarkers: 1,
        afterPromotionMarkers: 1,
        ambiguousCommitMarkers: 1,
        uncommittedMarkers: 0,
        synchronousMarkers: 1,
        partitionOutcomeUnknownMarkers: 0,
        afterRejoinMarkers: 1,
      },
    ]);
    const sideEffects = await promotedDatabase.pool.query(
      `SELECT
         (SELECT count(*)::integer FROM "ql3"."runs") AS runs,
         (SELECT count(*)::integer FROM "ql3"."run_events") AS "runEvents",
         (SELECT count(*)::integer
            FROM "ql3"."worker_credential_deliveries") AS "credentialDeliveries"`,
    );
    assert.deepEqual(sideEffects.rows, [
      { runs: 76, runEvents: 170, credentialDeliveries: 4 },
    ]);
    timeline.push({
      state: 'two_fresh_control_replicas_ready',
      atMs: Number((performance.now() - startedAt).toFixed(3)),
    });

    const imageId = docker([
      'inspect',
      names.standby,
      '--format',
      '{{.Image}}',
    ]).stdout;
    const imageArchitecture = docker([
      'image',
      'inspect',
      IMAGE,
      '--format',
      '{{.Architecture}}',
    ]).stdout;
    const repoDigests = JSON.parse(
      docker(['image', 'inspect', IMAGE, '--format', '{{json .RepoDigests}}'])
        .stdout,
    );
    report = {
      schemaVersion: 1,
      fixture: 'qinglong/postgresql-ha-contract@v1',
      postgres: {
        image: IMAGE,
        imageId,
        repoDigests,
        architecture: imageArchitecture,
        version: primaryVersion.rows[0].version,
        versionNumber: Number(primaryVersion.rows[0].versionNumber),
      },
      replication: {
        mode: 'physical-streaming',
        synchronousCommit: 'remote_apply',
        synchronousStandbyBeforePartition:
          synchronousReplicationBeforePartition,
        initialPrimaryTimeline: primaryTimeline,
        promotedPrimaryTimeline: promotedTimeline,
        oldPrimaryFenced: true,
        promotedWritable: true,
        transport:
          'dedicated isolated Docker replication network trust; not production TLS evidence',
      },
      endpoint: {
        kind: 'test-only switchable TCP endpoint',
        address: `${proxy.host}:${proxy.port}`,
        singleWriteTarget: true,
      },
      controlReplicas: {
        beforePromotion: oldBackends,
        afterPromotion: newBackends,
        oldAvailabilityAfterFailure: unavailableStatuses,
        oldActivationsRecoveredInPlace: false,
        freshActivationsReady: 2,
      },
      recovery: {
        failClosedMs: Number(failClosedMs.toFixed(3)),
        freshActivationMs: Number(reactivationMs.toFixed(3)),
      },
      durability: {
        ...durableFacts.rows[0],
        ...sideEffects.rows[0],
        unexpectedDomainSideEffects: 0,
      },
      manualRunRetry: manualRunRetry.report,
      transactionWindows: {
        ambiguousCommit: {
          clientObservedFailure: ambiguousCommitClientRejected,
          commitCompletedBeforeFault: ambiguousCommitCompletedBeforeFault,
          durableRowsAfterPromotion:
            durableFacts.rows[0].ambiguousCommitMarkers,
          transparentReplayAllowed: false,
          fault:
            'backend self-termination after COMMIT before operation return',
          evidenceScope:
            'generic PostgreSQL transaction; not a domain mutation contract',
        },
        writeBeforeCommit: {
          clientCommitRejected: true,
          durableRowsAfterPromotion: durableFacts.rows[0].uncommittedMarkers,
          evidenceScope:
            'generic PostgreSQL transaction; not a domain mutation contract',
        },
      },
      networkPartition,
      oldPrimaryRejoin,
      schedulerFailover,
      schedulerCommitResponseLoss,
      pluginPackageManagementQuota: managementQuota,
      pluginPackageIdentityKeysetLedger: identityKeysetLedger,
      workerCredentialManagementQuota,
      workerCredentialIdentityKeysetLedger,
      automationIdentityKeysetLedger,
      approvalIdentityKeysetLedger,
      runManagementIdentityKeysetLedger,
      automationManagementInspection,
      pluginPackageLifecycle: pluginPackageLifecycle.report,
      pluginPackageQuarantine: pluginPackageQuarantine.report,
      pluginPackagePromptExecution: pluginPackageQuarantine.promptExecution,
      pluginPackageWorkflowTaskAttempt:
        pluginPackageQuarantine.workflowTaskAttempt.report,
      remoteWorkflowCancellation:
        pluginPackageQuarantine.remoteWorkflowCancellation.report,
      pluginPackagePublisherTrustTransition: publisherTrustTransition,
      projectToolDefinitionSnapshot: projectToolSnapshot,
      toolInvocationArtifact,
      toolResultKeyRetirement,
      workerCredentialDeliveryCommitResponseLoss: credentialDelivery.report,
      runDomainCommitResponseLoss: domainCommitResponseLoss.report,
      modelInvocationFeaturePromotion,
      modelProviderCredentialCatalog,
      modelProviderCredentialTestConnection,
      runAttemptLogRetention,
      timeline,
      gates: {
        runAttemptLogRetentionLeaseTakeoverAndTombstoneConverge:
          runAttemptLogRetention.replicatedBeforePromotion &&
          runAttemptLogRetention.stalePrimarySettlementFenced &&
          runAttemptLogRetention.promotedClaimVersion === 2 &&
          runAttemptLogRetention.controlCountAfterSettlement === 0 &&
          runAttemptLogRetention.tombstoneCountAfterSettlement === 1 &&
          runAttemptLogRetention.survivedPromotion,
        packageAuthoritySplitReadinessBeforeAndAfterPromotion: true,
        optionalAiFeatureSchemaSurvivesPromotion: true,
        modelProviderCredentialCatalogSurvivesPromotion:
          modelProviderCredentialCatalog.survivedPromotion,
        modelProviderCredentialManagementIdentityLedgerSurvivesPromotion:
          modelProviderCredentialCatalog.identityKeysetLedger.survivedPromotion,
        modelProviderCredentialTestConnectionExactlyReplays:
          modelProviderCredentialTestConnection.planExactReplay &&
          modelProviderCredentialTestConnection.executionExactReplay &&
          modelProviderCredentialTestConnection.providerCalls === 1,
        modelProviderCredentialTestConnectionCompletionCommitResponseLossConverges:
          modelProviderCredentialTestConnection.completionCommitResponseLoss
            .commitCompletedBeforeFault &&
          modelProviderCredentialTestConnection.completionCommitResponseLoss
            .backendConnectionRejected,
        modelProviderCredentialTestConnectionReplicatesAndSurvivesPromotion:
          modelProviderCredentialTestConnection.replicatedBeforePromotion &&
          modelProviderCredentialTestConnection.survivedPromotion,
        modelProviderCredentialTestConnectionUsesLeastPrivilegeTester:
          modelProviderCredentialTestConnection.testerPoolMaxConnections ===
            1 &&
          modelProviderCredentialTestConnection.testerReadiness
            .leastPrivilege &&
          modelProviderCredentialTestConnection.promotedTesterReadiness
            .leastPrivilege,
        modelProviderCredentialTestConnectionDurableRecordsAreContentFree:
          modelProviderCredentialTestConnection.beforePromotion
            .privateMaterialAbsent &&
          modelProviderCredentialTestConnection.afterPromotion
            .privateMaterialAbsent,
        pluginPackagePromptAdmissionFinalizationExactlyReplays:
          pluginPackageQuarantine.promptExecution.exactReplay &&
          pluginPackageQuarantine.promptExecution.providerCalls === 2,
        pluginPackagePromptAdmissionFinalizationReplicatesBeforePromotion:
          pluginPackageQuarantine.promptExecution.replicatedBeforePromotion,
        pluginPackagePromptAdmissionFinalizationSurvivesPromotion:
          pluginPackageQuarantine.promptExecution.survivedPromotion,
        pluginPackagePromptCatalogReplicatesAndSurvivesPromotion:
          pluginPackageQuarantine.promptExecution.replicatedBeforePromotion &&
          pluginPackageQuarantine.promptExecution.survivedPromotion &&
          pluginPackageQuarantine.promptExecution.afterPromotion.catalog
            .found &&
          pluginPackageQuarantine.promptExecution.afterPromotion.catalog
            .publicationState === 'active' &&
          pluginPackageQuarantine.promptExecution.afterPromotion.catalog
            .templateFieldAbsent &&
          pluginPackageQuarantine.promptExecution.afterPromotion.catalog
            .privatePromptContentAbsent,
        pluginPackagePromptExecutionInspectionIsExactAndContentFree:
          pluginPackageQuarantine.promptExecution.executionInspection
            .beforePromotion.exact.found &&
          !pluginPackageQuarantine.promptExecution.executionInspection
            .beforePromotion.masked.found &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .beforePromotion.allowedAuditCount === 2 &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .beforePromotion.contentFree &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .afterPromotion?.allowedAuditCount === 4 &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .afterPromotion?.contentFree,
        pluginPackagePromptExecutionInspectionReplicatesAndSurvivesPromotion:
          pluginPackageQuarantine.promptExecution.executionInspection
            .replicatedBeforePromotion &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .survivedPromotion &&
          pluginPackageQuarantine.promptExecution.executionInspection
            .afterPromotion?.exact.found &&
          !pluginPackageQuarantine.promptExecution.executionInspection
            .afterPromotion?.masked.found,
        pluginPackagePromptExecutionOutputRecoveryIsExactAndContentFree:
          pluginPackageQuarantine.promptExecution.outputRecovery.exactReplay &&
          pluginPackageQuarantine.promptExecution.outputRecovery
            .crossTargetHidden &&
          pluginPackageQuarantine.promptExecution.outputRecovery.beforePromotion
            .status === 'available' &&
          pluginPackageQuarantine.promptExecution.outputRecovery.beforePromotion
            .outputMatched &&
          pluginPackageQuarantine.promptExecution.outputRecovery.beforePromotion
            .contentFree,
        pluginPackagePromptExecutionOutputRecoveryReplicatesAndSurvivesPromotion:
          pluginPackageQuarantine.promptExecution.outputRecovery
            .replicatedBeforePromotion &&
          pluginPackageQuarantine.promptExecution.outputRecovery
            .survivedPromotion &&
          pluginPackageQuarantine.promptExecution.outputRecovery.afterPromotion
            ?.status === 'available' &&
          pluginPackageQuarantine.promptExecution.outputRecovery.afterPromotion
            ?.outputMatched &&
          pluginPackageQuarantine.promptExecution.outputRecovery.afterPromotion
            ?.contentFree,
        pluginPackagePromptPolicyFenceRejectsRevokedBinding:
          pluginPackageQuarantine.promptExecution
            .policyFenceRejectedAfterRevocation,
        pluginPackagePromptDurableRecordsAreContentFree:
          pluginPackageQuarantine.promptExecution.afterPromotion
            .privatePromptAbsent &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .privateOutputAbsent &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .artifactPlaintextAbsent &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .tombstonePlaintextAbsent,
        pluginPackagePromptOutputArtifactCommitsAtomically:
          pluginPackageQuarantine.promptExecution
            .outputArtifactCommittedAtomicallyBeforeGc,
        pluginPackagePromptOutputGcTombstonesBeforeCiphertextDelete:
          pluginPackageQuarantine.promptExecution.garbageCollected &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .outputArtifactCount === 0 &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .outputTombstoneCount === 1 &&
          pluginPackageQuarantine.promptExecution.afterPromotion
            .outputArtifactId ===
            pluginPackageQuarantine.promptExecution.afterPromotion
              .stepOutputRef,
        pluginPackagePromptOutputExactReplayAfterGc:
          pluginPackageQuarantine.promptExecution.exactReplayAfterGc &&
          pluginPackageQuarantine.promptExecution.providerCalls === 2,
        pluginPackagePromptOutputKeyRetirementIsDurableAndFenced:
          pluginPackageQuarantine.promptExecution.keyRetirementCompleted &&
          pluginPackageQuarantine.promptExecution.keyRetirementExactReplay &&
          pluginPackageQuarantine.promptExecution
            .keyRetirementFenceRejectedLateArtifact &&
          pluginPackageQuarantine.promptExecution.afterPromotion.keyRetirement
            .privateOutputAbsent,
        pluginPackagePromptOutputKeyRotationIsDurableAndRecoverable:
          pluginPackageQuarantine.promptExecution.keyRotationCompleted &&
          pluginPackageQuarantine.promptExecution.keyRotationExactReplay &&
          pluginPackageQuarantine.promptExecution
            .keyRotationMaterialResponseLossConverged &&
          pluginPackageQuarantine.promptExecution.keyRotationMaterialCalls ===
            2 &&
          pluginPackageQuarantine.promptExecution.keyRotationSecretWrites ===
            1 &&
          pluginPackageQuarantine.promptExecution
            .historicalArtifactDecryptAfterRotation &&
          pluginPackageQuarantine.promptExecution.afterPromotion.keyRotation
            .contentFree,
        pluginPackagePromptOutputMaintenanceAuthorityIsLeastPrivilege:
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .maintenanceAuthority &&
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .artifactDeleteOnly &&
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .tombstoneAppendOnly &&
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .keyRetirementAppendOnly &&
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .keyRotationAppendOnly &&
          pluginPackageQuarantine.promptExecution.maintenanceReadiness
            .terminalEvidenceReadOnly,
        durableManagementQuotaConvergedAcrossInstances: true,
        durableIdentityKeysetLedgerSurvivesReplicaRestart: true,
        workerCredentialManagementQuotaConvergedAcrossInstances:
          workerCredentialManagementQuota.competingInstances === 2 &&
          workerCredentialManagementQuota.admitted === 8 &&
          workerCredentialManagementQuota.limited === 8 &&
          workerCredentialManagementQuota.autocommitResponseLossConverged ===
            true,
        workerCredentialIdentityKeysetLedgerSurvivesReplicaRestart:
          workerCredentialIdentityKeysetLedger.competingInstances === 2 &&
          workerCredentialIdentityKeysetLedger.generation === 3 &&
          workerCredentialIdentityKeysetLedger.restartRollbackRejected ===
            true &&
          workerCredentialIdentityKeysetLedger.commitResponseLossConverged ===
            true,
        automationIdentityKeysetLedgerSurvivesReplicaRestart:
          automationIdentityKeysetLedger.competingInstances === 2 &&
          automationIdentityKeysetLedger.generation === 3 &&
          automationIdentityKeysetLedger.restartRollbackRejected === true &&
          automationIdentityKeysetLedger.commitResponseLossConverged === true,
        approvalIdentityKeysetLedgerSurvivesReplicaRestart:
          approvalIdentityKeysetLedger.competingInstances === 2 &&
          approvalIdentityKeysetLedger.generation === 3 &&
          approvalIdentityKeysetLedger.restartRollbackRejected === true &&
          approvalIdentityKeysetLedger.commitResponseLossConverged === true,
        automationManagementInspectionCommitsWithAuditAtomically:
          automationManagementInspection.beforePromotion.auditCount === 6 &&
          automationManagementInspection.beforePromotion.taskRevision === 1 &&
          automationManagementInspection.beforePromotion.triggerRevision === 1,
        automationManagementInspectionReplicatesBeforePromotion:
          automationManagementInspection.replicatedBeforePromotion === true,
        automationManagementInspectionFailsClosedWithoutSynchronousAuditDurability:
          automationManagementInspection.failedClosedWithoutSynchronousStandby ===
          true,
        automationManagementInspectionSurvivesPromotion:
          automationManagementInspection.survivedPromotion === true &&
          automationManagementInspection.afterPromotion
            .successfulReadAuditCount === 4 &&
          automationManagementInspection.afterPromotion.taskRevision === 1 &&
          automationManagementInspection.afterPromotion.triggerRevision === 1,
        pluginPackageLifecycleCommitResponseLossConvergesExactlyOnce: true,
        pluginPackageLifecycleRunAndToolFencesTransitionAtomically: true,
        pluginPackageAutomationPublicationTransitionsAtomically:
          pluginPackageLifecycle.report.automationLifecycleChainAtomic,
        pluginPackageAutomationPublicationSurvivesPromotion:
          pluginPackageLifecycle.report.automationPublicationSurvivedPromotion,
        pluginPackageAutomationRecoverySourceConverges:
          pluginPackageQuarantine.report.automationRecoverySourceConverged,
        pluginPackagePublisherRevocationImmediatelyFencesAutomation:
          pluginPackageQuarantine.report
            .automationStartAllowedBeforeRevocationReceipt &&
          !pluginPackageQuarantine.report
            .automationStartAllowedAfterRevocationReceipt,
        pluginPackageAutomationSecurityFenceSurvivesPromotion:
          pluginPackageQuarantine.report.automationStartFenceSurvivedPromotion,
        pluginPackageAutomationStartGuardIsRuntimeOnly:
          pluginPackageQuarantine.report.automationStartGuardRuntimeOnly,
        pluginPackageWorkflowAdmissionCommitsAtomically:
          pluginPackageQuarantine.report.workflowAdmissionCreatedAtomically,
        pluginPackageWorkflowAuthorizedAdmissionCommitsAtomically:
          pluginPackageQuarantine.report.workflowAuthorizedAdmissionAtomic,
        pluginPackageWorkflowAdmissionExactlyReplays:
          pluginPackageQuarantine.report.workflowAdmissionExactReplay,
        pluginPackageWorkflowAdmissionIsFencedAfterRevocation:
          pluginPackageQuarantine.report.workflowAdmissionFencedAfterRevocation,
        pluginPackageWorkflowAdmissionIsRuntimeOnly:
          pluginPackageQuarantine.report.workflowAdmissionRuntimeOnly,
        pluginPackageWorkflowAdmissionSurvivesPromotion:
          pluginPackageQuarantine.report.workflowAdmissionSurvivedPromotion,
        pluginPackageWorkflowAuthorizedAdmissionSurvivesPromotion:
          pluginPackageQuarantine.report
            .workflowAuthorizedAdmissionSurvivedPromotion,
        pluginPackageWorkflowRunInspectionCommitsAtomically:
          pluginPackageQuarantine.report.workflowRunInspectionAtomic,
        pluginPackageWorkflowRunInspectionMasksCrossTarget:
          pluginPackageQuarantine.report.workflowRunInspectionMasksCrossTarget,
        pluginPackageWorkflowRunInspectionSurvivesPromotion:
          pluginPackageQuarantine.report.workflowRunInspectionSurvivedPromotion,
        pluginPackageWorkflowRunListCommitsAtomically:
          pluginPackageQuarantine.report.workflowRunListAtomic,
        pluginPackageWorkflowRunListMasksCrossTarget:
          pluginPackageQuarantine.report.workflowRunListMasksCrossTarget,
        pluginPackageWorkflowRunListSurvivesPromotion:
          pluginPackageQuarantine.report.workflowRunListSurvivedPromotion,
        pluginPackageWorkflowStepRunListCommitsAtomically:
          pluginPackageQuarantine.report.workflowStepRunListAtomic,
        pluginPackageWorkflowStepRunListMasksCrossTarget:
          pluginPackageQuarantine.report.workflowStepRunListMasksCrossTarget,
        pluginPackageWorkflowStepRunListSurvivesPromotion:
          pluginPackageQuarantine.report.workflowStepRunListSurvivedPromotion,
        pluginPackageWorkflowRunEventListCommitsAtomically:
          pluginPackageQuarantine.report.workflowRunEventListAtomic,
        pluginPackageWorkflowRunEventListMasksCrossTarget:
          pluginPackageQuarantine.report.workflowRunEventListMasksCrossTarget,
        pluginPackageWorkflowRunEventListSurvivesPromotion:
          pluginPackageQuarantine.report.workflowRunEventListSurvivedPromotion,
        pluginPackageWorkflowFrontierTerminalizesAtomically:
          pluginPackageQuarantine.report.workflowFrontierTerminalizedAtomically,
        pluginPackageWorkflowFrontierExactlyReplays:
          pluginPackageQuarantine.report.workflowFrontierExactReplay,
        pluginPackageWorkflowFrontierSurvivesPromotion:
          pluginPackageQuarantine.report.workflowFrontierSurvivedPromotion,
        pluginPackageWorkflowTaskAttemptCommitsAtomically:
          pluginPackageQuarantine.workflowTaskAttempt.report.createdAtomically,
        pluginPackageWorkflowTaskAttemptExactlyReplays:
          pluginPackageQuarantine.workflowTaskAttempt.report.exactReplay,
        pluginPackageWorkflowTaskAttemptReplicatesBeforePromotion:
          pluginPackageQuarantine.workflowTaskAttempt.report
            .replicatedBeforePromotion,
        pluginPackageWorkflowTaskAttemptIsRuntimeOnly:
          pluginPackageQuarantine.workflowTaskAttempt.report.runtimeOnly,
        pluginPackageWorkflowTaskAttemptSurvivesPromotion:
          pluginPackageQuarantine.workflowTaskAttempt.report.survivedPromotion,
        remoteWorkflowCancellationReturnsStopRequested:
          pluginPackageQuarantine.remoteWorkflowCancellation.report
            .stopRequested,
        remoteWorkflowCancellationBindsWorkflowTarget:
          pluginPackageQuarantine.remoteWorkflowCancellation.report
            .workflowTargetBound,
        remoteWorkflowCancellationCompletionExactlyReplays:
          pluginPackageQuarantine.remoteWorkflowCancellation.report
            .completionReplayStatus === 'already_completed',
        remoteWorkflowCancellationConvergesAfterCommitResponseLoss:
          pluginPackageQuarantine.remoteWorkflowCancellation.report
            .convergenceCommitCompletedBeforeFault,
        remoteWorkflowCancellationSurvivesPromotion:
          pluginPackageQuarantine.remoteWorkflowCancellation.report
            .survivedPromotion,
        pluginPackageLifecycleStateSurvivesPromotion: true,
        pluginPackageLifecycleSeparationOfDutyEnforced: true,
        pluginPackageLifecycleManagedPlanReviewExecutesExactly: true,
        pluginPackageLifecycleManagementProcessCrashesConvergeExactlyOnce:
          pluginPackageLifecycle.report
            .managementProcessCrashesConvergedExactlyOnce,
        pluginPackageQuarantineCommitResponseLossConvergesExactlyOnce: true,
        pluginPackageQuarantineRunAndToolFencesSurvivePromotion: true,
        pluginPackageQuarantineInventorySurvivesPromotion: true,
        pluginPackagePublisherTrustOverlapAndSafeRetirementSurvivePromotion: true,
        projectToolSnapshotSurvivesPromotion: true,
        toolInvocationArtifactSurvivesPromotionWithoutPlaintext: true,
        nonEmptyToolResultRekeySurvivesPromotionAndUnifiedReopen: true,
        toolResultCatalogRotationBeatsStaleCompletionWithoutPartialWrites: true,
        toolResultCatalogCommitResponseLossConvergesExactlyOnce: true,
        toolResultCompletionCommitResponseLossRecoversWithoutReexecution: true,
        toolResultRekeyCommitResponseLossConvergesExactlyOnce: true,
        manualRunRetryConcurrentReplayIsExact:
          manualRunRetry.report.exactConcurrentReplay,
        manualRunRetryQuotaIsSerializedAcrossReplicas:
          manualRunRetry.report.crossReplicaQuotaSerialized,
        manualRunRetryDoesNotInheritAutomaticPolicy:
          manualRunRetry.report.inheritedRetryPolicies === 0,
        manualRunRetryAllowedAuditIsDurable:
          manualRunRetry.report.allowedAuditEvents ===
          CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
        manualRunRetryReplicatesBeforePromotion:
          manualRunRetry.report.replicatedBeforePromotion,
        manualRunRetrySurvivesPromotion:
          manualRunRetry.report.survivedPromotion,
        physicalStreaming: true,
        oldPrimaryFencedBeforePromotion: true,
        bothOldReplicasNotReady: true,
        endpointSwitchedAfterPromotion: true,
        bothFreshReplicasReady: true,
        ambiguousCommitRequiresDurableInspection: true,
        uncommittedWriteRolledBack: true,
        synchronousRemoteApplyBeforePartition: true,
        replicationLinkPartitionObserved: true,
        promotionRejectedBeforeOldPrimaryFence: true,
        partitionedCommitNotAcknowledged: true,
        unacknowledgedPartitionedCommitAbsentAfterPromotion: true,
        oldPrimaryRewoundAndRejoinedReadOnly: true,
        synchronousReplicationRestoredBeforeEndpointSwitch: true,
        schedulerClaimReplicatedBeforePromotion: true,
        schedulerClaimTakenOverAfterExpiry: true,
        schedulerOccurrenceAdmittedExactlyOnce: true,
        schedulerCommitResponseLossConvergedExactlyOnce: true,
        workerCredentialDeliveryCommitWindowsConvergedExactlyOnce: true,
        remoteWorkerCompletionCommitWindowConvergedExactlyOnce: true,
        runCancellationCommitWindowsConvergedExactlyOnce: true,
        passed: true,
      },
      limitations: [
        'test-only TCP endpoint is not a production operator or proxy',
        'Docker replication-link partition plus a test-only promotion guard is not production operator or infrastructure STONITH evidence',
        'single-standby remote_apply prioritizes acknowledged-write durability and blocks mutation availability until synchronous redundancy is restored',
        'domain COMMIT-response-loss faults are injected at the PostgresClient boundary, not by dropping raw PostgreSQL protocol packets',
      ],
    };
  } catch (error) {
    const logs = {};
    for (const containerName of [names.primary, names.standby]) {
      const result = docker(['logs', '--tail', '80', containerName], {
        allowFailure: true,
      });
      if (result.status === 0) logs[containerName] = result.stdout;
    }
    if (Object.keys(logs).length > 0) {
      error.haContainerLogs = logs;
    }
    throw error;
  } finally {
    for (const replica of replicas.splice(0)) {
      await replica.stop().catch(() => {});
    }
    await proxy?.close().catch(() => {});
    if (resources.primary || resources.standby) {
      docker(['rm', '-f', '-v', names.primary, names.standby], {
        allowFailure: true,
      });
    }
    await ambiguousClient?.end().catch(() => {});
    await uncommittedClient?.end().catch(() => {});
    await partitionClient?.end().catch(() => {});
    await schedulerFaultPool?.end().catch(() => {});
    await promotedDatabase?.close().catch(() => {});
    await standbyDatabase?.close().catch(() => {});
    await primaryDatabase?.close().catch(() => {});
    if (resources.primaryVolume || resources.standbyVolume) {
      docker(['volume', 'rm', names.primaryVolume, names.standbyVolume], {
        allowFailure: true,
      });
    }
    if (
      resources.network ||
      resources.primaryNetwork ||
      resources.standbyNetwork
    ) {
      docker(
        [
          'network',
          'rm',
          names.network,
          names.primaryNetwork,
          names.standbyNetwork,
        ],
        { allowFailure: true },
      );
    }
  }

  writePrivateReport(reportFile, report);
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: report.fixture,
      status: 'passed',
      reportPath: reportFile,
      reportSha256: createHash('sha256').update(serializedReport).digest('hex'),
      architecture: report.postgres.architecture,
      postgresVersionNumber: report.postgres.versionNumber,
      initialPrimaryTimeline: report.replication.initialPrimaryTimeline,
      promotedPrimaryTimeline: report.replication.promotedPrimaryTimeline,
      gateCount: Object.keys(report.gates).length,
    })}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ql3 PostgreSQL HA contract failed: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    let cause = error?.cause;
    while (cause) {
      process.stderr.write(
        `caused by: ${
          cause instanceof Error ? cause.stack ?? cause.message : String(cause)
        }\n`,
      );
      cause = cause?.cause;
    }
    if (error?.haContainerLogs) {
      process.stderr.write(
        `${JSON.stringify(error.haContainerLogs, null, 2)}\n`,
      );
    }
    process.exitCode = 1;
  });
}

module.exports = { privateReportPath, writePrivateReport };
