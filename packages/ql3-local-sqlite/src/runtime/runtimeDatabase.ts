import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  LocalSqliteConfigurationError,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { LocalSqliteRunRepository } from '../run/runRepository';
import { createLocalSqliteRunRuntimeCapabilities } from '../run/runRuntimeCapabilities';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';
import type { LocalRunStartupRecoverySource } from '@qinglong/runtime-core/local-startup-recovery';
import type { LocalDispatchStore } from '@qinglong/runtime-core/local-dispatch';
import type { LocalExecutionControlSource } from '@qinglong/runtime-core/local-execution-control';
import type { LocalCompletionReceiptJournal } from '@qinglong/runtime-core/local-completion-receipt-journal';
import type { LocalSecretEnvelopeRepository } from '@qinglong/runtime-core/local-secret';
import type { LocalSecretAdministrationRepository } from '@qinglong/runtime-core/local-secret-administration';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';
import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { PluginPackageInstallRepository } from '@qinglong/runtime-core/plugin-package-install';
import type {
  PluginPackageAutomationPublicationRepository,
  PluginPackageAutomationPublicationRecoverySource,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageMaterializedRevisionRepository } from '@qinglong/runtime-core/plugin-package-resource-materialization';
import type { PluginPackageSecretBindingRepository } from '@qinglong/runtime-core/plugin-package-secret-binding';
import type { PluginPackageActivationPrerequisite } from '@qinglong/runtime-core/plugin-package-installation';
import type { PluginPackageTaskReconciliationRepository } from '@qinglong/runtime-core/plugin-package-task-reconciliation';
import type { PluginPackageTaskPublicationRecoverySource } from '@qinglong/runtime-core/plugin-package-task-publication';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';
import type { RunCancellationRepository } from '@qinglong/runtime-core/run-cancellation';
import type { TaskStartRepository } from '@qinglong/runtime-core/task-start';
import type { TaskDefinitionAdministrationRepository } from '@qinglong/runtime-core/task-definition-administration';
import type { ToolExecutionCompletionRepository } from '@qinglong/runtime-core/tool-execution-completion';
import type { ToolExecutionFailureCompletionRepository } from '@qinglong/runtime-core/tool-execution-failure-completion';
import type { ToolExecutionStartBarrierRepository } from '@qinglong/runtime-core/tool-execution-start-barrier';
import type { ToolInvocationArtifactRepository } from '@qinglong/runtime-core/tool-invocation-artifact';
import type { ToolResultKeyCatalogReader } from '@qinglong/runtime-core/tool-result-key-catalog';
import type { ToolExecutionResultRekeyReader } from '@qinglong/runtime-core/tool-result-rekey';
import type {
  ProjectToolDefinitionSnapshotRepository,
  ProjectToolDefinitionSnapshotSourceRepository,
} from '@qinglong/runtime-core/project-tool-definition-snapshot';
import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteTaskDefinitionRepository } from '../task-definition/taskDefinitionRepository';
import { LocalSqliteTaskDefinitionAdministrationRepository } from '../task-definition/taskDefinitionAdministration';
import {
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  type LocalSqliteAuthenticatedUserCredentialFence,
} from '../administration/packageManagement';
import {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import {
  TriggerSpecSemanticRegistry,
  createBuiltInTriggerSpecSemanticRegistry,
} from '@qinglong/runtime-core/trigger';
import { LocalSqliteTriggerRepository } from '../scheduling/triggerRepository';
import { LocalSqliteScheduleRepository } from '../scheduling/scheduleRepository';
import type { LocalSqliteWorkflowTaskExecutionRepository } from '../plugin-package/workflow/workflowTaskExecutionRepository';
import type { LocalSqlitePluginPackageWorkflowFrontierRepository } from '../plugin-package/workflow/pluginPackageWorkflowFrontierRepository';
import type { LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository } from '../plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository';
import type { LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository } from '../plugin-package/workflow/pluginPackageWorkflowCancellationConvergenceRepository';
import { LocalSqliteRunAttemptLogRetentionRepository } from '../run/runAttemptLogRetentionRepository';
import { LocalSqliteRunLostRetryRepository } from '../run/runLostRetryRepository';

export interface LocalSqliteRuntimeDependencies {
  readonly taskSpecSemanticRegistry?: TaskSpecSemanticRegistry;
  readonly triggerSpecSemanticRegistry?: TriggerSpecSemanticRegistry;
}

export interface LocalSqliteTrustedToolStorage {
  readonly invocationArtifacts: ToolInvocationArtifactRepository;
  readonly stepRuns: StepRunRepository;
  readonly startBarriers: ToolExecutionStartBarrierRepository;
  readonly completions: ToolExecutionCompletionRepository;
  readonly failureCompletions: ToolExecutionFailureCompletionRepository;
  readonly resultKeyCatalog: ToolResultKeyCatalogReader;
  readonly resultRekeys: ToolExecutionResultRekeyReader;
  readonly toolDefinitionSnapshots: ProjectToolDefinitionSnapshotRepository &
    ProjectToolDefinitionSnapshotSourceRepository;
}

export interface LocalSqlitePluginPackageWorkflowRuntime {
  readonly frontier: LocalSqlitePluginPackageWorkflowFrontierRepository;
  readonly taskAttempts: LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository;
  readonly cancellation: LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository;
  readonly executions: LocalSqliteWorkflowTaskExecutionRepository;
}

export interface LocalSqliteRuntimeDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly runRepository: LocalSqliteRunRepository;
  readonly taskDefinitions: LocalSqliteTaskDefinitionRepository;
  taskDefinitionAdministrationForCredential(
    fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
  ): TaskDefinitionAdministrationRepository;
  readonly triggers: LocalSqliteTriggerRepository;
  readonly schedules: LocalSqliteScheduleRepository;
  readonly localDispatch: LocalDispatchStore;
  readonly executionControl: LocalExecutionControlSource;
  readonly completionReceipts: LocalCompletionReceiptJournal;
  readonly runAttemptLogRetention: LocalSqliteRunAttemptLogRetentionRepository;
  readonly runLostRetry: LocalSqliteRunLostRetryRepository;
  readonly localSecrets: LocalSecretEnvelopeRepository;
  readonly localSecretAdministration: LocalSecretAdministrationRepository;
  readonly projectPolicy: ProjectPolicyRepository;
  readonly securityAudit: SecurityAuditSink;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: LocalOwnerPepperRepository;
  pluginPackageInstalls(): Promise<PluginPackageInstallRepository>;
  pluginPackageMaterializedRevisions(): Promise<PluginPackageMaterializedRevisionRepository>;
  pluginPackageSecretBindings(): Promise<PluginPackageSecretBindingRepository>;
  pluginPackageActivationPrerequisite(): Promise<PluginPackageActivationPrerequisite>;
  pluginPackageTaskReconciliations(): Promise<
    PluginPackageTaskReconciliationRepository &
      PluginPackageTaskPublicationRecoverySource
  >;
  pluginPackageAutomationPublications(): Promise<
    PluginPackageAutomationPublicationRepository &
      PluginPackageAutomationPublicationRecoverySource
  >;
  projectToolDefinitionSnapshots(): Promise<
    ProjectToolDefinitionSnapshotRepository &
      ProjectToolDefinitionSnapshotSourceRepository
  >;
  stepRunReader(): Promise<Pick<StepRunRepository, 'listByRun'>>;
  runCancellationRepository(): Promise<RunCancellationRepository>;
  taskStartRepository(): Promise<TaskStartRepository>;
  pluginPackageWorkflowRuntime(): Promise<LocalSqlitePluginPackageWorkflowRuntime>;
  trustedToolStorage(): Promise<LocalSqliteTrustedToolStorage>;
  readonly startupRecovery: LocalRunStartupRecoverySource;
  close(): Promise<void>;
}

export async function openLocalSqliteRuntimeDatabase(
  options: LocalSqliteDatabaseOptions,
  dependencies: LocalSqliteRuntimeDependencies = {},
): Promise<LocalSqliteRuntimeDatabase> {
  assertLocalSqliteOptions(options);
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    Object.keys(dependencies).some(
      (key) =>
        key !== 'taskSpecSemanticRegistry' &&
        key !== 'triggerSpecSemanticRegistry',
    ) ||
    (dependencies.taskSpecSemanticRegistry !== undefined &&
      !(
        dependencies.taskSpecSemanticRegistry instanceof
        TaskSpecSemanticRegistry
      )) ||
    (dependencies.triggerSpecSemanticRegistry !== undefined &&
      !(
        dependencies.triggerSpecSemanticRegistry instanceof
        TriggerSpecSemanticRegistry
      ))
  ) {
    throw new LocalSqliteConfigurationError(
      'runtime dependencies contain an unsupported semantic registry',
    );
  }
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const taskSpecSemanticRegistry =
      dependencies.taskSpecSemanticRegistry ??
      createBuiltInTaskSpecSemanticRegistry();
    const runRepository = new LocalSqliteRunRepository(authority);
    const runRuntimeCapabilities =
      createLocalSqliteRunRuntimeCapabilities(authority);
    const securityAuthority = new LocalSqliteSecurityAuthorityStore(authority);
    const taskDefinitions = new LocalSqliteTaskDefinitionRepository(
      authority,
      taskSpecSemanticRegistry,
    );
    const triggers = new LocalSqliteTriggerRepository(
      authority,
      dependencies.triggerSpecSemanticRegistry ??
        createBuiltInTriggerSpecSemanticRegistry(),
    );
    const schedules = new LocalSqliteScheduleRepository(authority);
    const apiCredentials = new LocalSqliteApiCredentialRepository(authority);
    const ownerPepper = new LocalSqliteOwnerPepperRepository(authority);
    const runAttemptLogRetention =
      new LocalSqliteRunAttemptLogRetentionRepository(authority);
    const runLostRetry = new LocalSqliteRunLostRetryRepository(
      authority,
      runRepository,
    );
    let pluginPackageInstallsPromise:
      | Promise<PluginPackageInstallRepository>
      | undefined;
    let pluginPackageMaterializedRevisionsPromise:
      | Promise<PluginPackageMaterializedRevisionRepository>
      | undefined;
    let pluginPackageSecretBindingsPromise:
      | Promise<PluginPackageSecretBindingRepository>
      | undefined;
    let pluginPackageActivationPrerequisitePromise:
      | Promise<PluginPackageActivationPrerequisite>
      | undefined;
    let pluginPackageTaskReconciliationsPromise:
      | Promise<
          PluginPackageTaskReconciliationRepository &
            PluginPackageTaskPublicationRecoverySource
        >
      | undefined;
    let pluginPackageAutomationPublicationsPromise:
      | Promise<
          PluginPackageAutomationPublicationRepository &
            PluginPackageAutomationPublicationRecoverySource
        >
      | undefined;
    let projectToolDefinitionSnapshotsPromise:
      | Promise<
          ProjectToolDefinitionSnapshotRepository &
            ProjectToolDefinitionSnapshotSourceRepository
        >
      | undefined;
    let stepRunRepositoryPromise: Promise<StepRunRepository> | undefined;
    let runCancellationRepositoryPromise:
      | Promise<RunCancellationRepository>
      | undefined;
    let taskStartRepositoryPromise: Promise<TaskStartRepository> | undefined;
    let pluginPackageWorkflowRuntimePromise:
      | Promise<LocalSqlitePluginPackageWorkflowRuntime>
      | undefined;
    let trustedToolStoragePromise:
      | Promise<LocalSqliteTrustedToolStorage>
      | undefined;
    const projectPolicy: ProjectPolicyRepository = Object.freeze({
      resolve: (
        ...[projectId, subject]: Parameters<ProjectPolicyRepository['resolve']>
      ) => securityAuthority.resolve(projectId, subject),
      append: (...[command]: Parameters<ProjectPolicyRepository['append']>) =>
        securityAuthority.append(command),
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      runRepository,
      taskDefinitions,
      taskDefinitionAdministrationForCredential(
        fence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>,
      ) {
        confirmLocalSqliteAuthenticatedUserCredentialFence(authority, fence);
        return new LocalSqliteTaskDefinitionAdministrationRepository(
          authority,
          taskDefinitions,
          (actor) => {
            if (
              actor.type !== fence.subjectType ||
              actor.id !== fence.subjectId
            ) {
              throw new LocalSqliteAuthenticatedManagementFenceError();
            }
            confirmLocalSqliteAuthenticatedUserCredentialFence(
              authority,
              fence,
            );
          },
        );
      },
      triggers,
      schedules,
      localDispatch: runRuntimeCapabilities.dispatch,
      executionControl: runRuntimeCapabilities.executionControl,
      completionReceipts: runRuntimeCapabilities.completionReceipts,
      runAttemptLogRetention,
      runLostRetry,
      localSecrets: securityAuthority,
      localSecretAdministration: securityAuthority,
      projectPolicy,
      securityAudit: securityAuthority,
      apiCredentials,
      ownerPepper,
      pluginPackageInstalls() {
        pluginPackageInstallsPromise ??= import(
          '../plugin-package/pluginPackageInstallRepository.js'
        ).then(
          ({ LocalSqlitePluginPackageInstallRepository }) =>
            new LocalSqlitePluginPackageInstallRepository(authority),
        );
        return pluginPackageInstallsPromise;
      },
      pluginPackageMaterializedRevisions() {
        pluginPackageMaterializedRevisionsPromise ??= import(
          '../plugin-package/pluginPackageMaterializedRevisionRepository.js'
        ).then(
          ({ LocalSqlitePluginPackageMaterializedRevisionRepository }) =>
            new LocalSqlitePluginPackageMaterializedRevisionRepository(
              authority,
              taskSpecSemanticRegistry,
            ),
        );
        return pluginPackageMaterializedRevisionsPromise;
      },
      pluginPackageSecretBindings() {
        pluginPackageSecretBindingsPromise ??= import(
          '../plugin-package/secret-binding/repository.js'
        ).then(
          ({ LocalSqlitePluginPackageSecretBindingRepository }) =>
            new LocalSqlitePluginPackageSecretBindingRepository(authority),
        );
        return pluginPackageSecretBindingsPromise;
      },
      pluginPackageActivationPrerequisite() {
        pluginPackageActivationPrerequisitePromise ??= import(
          '../plugin-package/secret-binding/activationPrerequisite.js'
        ).then(
          ({ LocalSqlitePluginPackageSecretBindingActivationPrerequisite }) =>
            new LocalSqlitePluginPackageSecretBindingActivationPrerequisite(
              authority,
            ),
        );
        return pluginPackageActivationPrerequisitePromise;
      },
      pluginPackageTaskReconciliations() {
        pluginPackageTaskReconciliationsPromise ??= import(
          '../plugin-package/pluginPackageTaskReconciliationRepository.js'
        ).then(
          ({ LocalSqlitePluginPackageTaskReconciliationRepository }) =>
            new LocalSqlitePluginPackageTaskReconciliationRepository(
              authority,
              taskSpecSemanticRegistry,
            ),
        );
        return pluginPackageTaskReconciliationsPromise;
      },
      pluginPackageAutomationPublications() {
        pluginPackageAutomationPublicationsPromise ??= import(
          '../plugin-package/pluginPackageAutomationPublicationRepository.js'
        ).then(
          ({ LocalSqlitePluginPackageAutomationPublicationRepository }) =>
            new LocalSqlitePluginPackageAutomationPublicationRepository(
              authority,
            ),
        );
        return pluginPackageAutomationPublicationsPromise;
      },
      projectToolDefinitionSnapshots() {
        projectToolDefinitionSnapshotsPromise ??= import(
          '../tool-execution/projectToolDefinitionSnapshotRepository.js'
        ).then(
          ({ LocalSqliteProjectToolDefinitionSnapshotRepository }) =>
            new LocalSqliteProjectToolDefinitionSnapshotRepository(authority),
        );
        return projectToolDefinitionSnapshotsPromise;
      },
      stepRunReader() {
        stepRunRepositoryPromise ??= import('../run/stepRunRepository.js').then(
          ({ LocalSqliteStepRunRepository }) =>
            new LocalSqliteStepRunRepository(authority),
        );
        return stepRunRepositoryPromise.then((repository) =>
          Object.freeze({
            listByRun: repository.listByRun.bind(repository),
          }),
        );
      },
      runCancellationRepository() {
        runCancellationRepositoryPromise ??= import(
          '../run/runCancellationRepository.js'
        ).then(
          ({ LocalSqliteRunCancellationRepository }) =>
            new LocalSqliteRunCancellationRepository(authority),
        );
        return runCancellationRepositoryPromise;
      },
      taskStartRepository() {
        taskStartRepositoryPromise ??= import(
          '../task-start/taskStartRepository.js'
        ).then(
          ({ LocalSqliteTaskStartRepository }) =>
            new LocalSqliteTaskStartRepository(authority),
        );
        return taskStartRepositoryPromise;
      },
      pluginPackageWorkflowRuntime() {
        pluginPackageWorkflowRuntimePromise ??= Promise.all([
          import(
            '../plugin-package/workflow/pluginPackageWorkflowFrontierRepository.js'
          ),
          import(
            '../plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository.js'
          ),
          import(
            '../plugin-package/workflow/pluginPackageWorkflowCancellationConvergenceRepository.js'
          ),
          import(
            '../plugin-package/workflow/workflowTaskExecutionRepository.js'
          ),
        ]).then(
          ([
            { LocalSqlitePluginPackageWorkflowFrontierRepository },
            { LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository },
            {
              LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
            },
            { LocalSqliteWorkflowTaskExecutionRepository },
          ]) =>
            Object.freeze({
              frontier: new LocalSqlitePluginPackageWorkflowFrontierRepository(
                authority,
              ),
              taskAttempts:
                new LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository(
                  authority,
                ),
              cancellation:
                new LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository(
                  authority,
                ),
              executions: new LocalSqliteWorkflowTaskExecutionRepository(
                authority,
              ),
            }),
        );
        return pluginPackageWorkflowRuntimePromise;
      },
      trustedToolStorage() {
        trustedToolStoragePromise ??= Promise.all([
          import('../tool-execution/toolInvocationArtifactRepository.js'),
          stepRunRepositoryPromise ??
            (stepRunRepositoryPromise = import(
              '../run/stepRunRepository.js'
            ).then(
              ({ LocalSqliteStepRunRepository }) =>
                new LocalSqliteStepRunRepository(authority),
            )),
          import('../tool-execution/toolExecutionStartBarrierRepository.js'),
          import('../tool-execution/toolExecutionCompletionRepository.js'),
          import(
            '../tool-execution/toolExecutionFailureCompletionRepository.js'
          ),
          import('../tool-execution/toolResultKeyCatalogRepository.js'),
          import('../tool-execution/toolResultRekeyRepository.js'),
          projectToolDefinitionSnapshotsPromise ??
            (projectToolDefinitionSnapshotsPromise = import(
              '../tool-execution/projectToolDefinitionSnapshotRepository.js'
            ).then(
              ({ LocalSqliteProjectToolDefinitionSnapshotRepository }) =>
                new LocalSqliteProjectToolDefinitionSnapshotRepository(
                  authority,
                ),
            )),
        ]).then(
          ([
            { LocalSqliteToolInvocationArtifactRepository },
            stepRuns,
            { LocalSqliteToolExecutionStartBarrierRepository },
            { LocalSqliteToolExecutionCompletionRepository },
            { LocalSqliteToolExecutionFailureCompletionRepository },
            { LocalSqliteToolResultKeyCatalogRepository },
            { LocalSqliteToolResultRekeyRepository },
            toolDefinitionSnapshots,
          ]) => {
            const resultKeyCatalog =
              new LocalSqliteToolResultKeyCatalogRepository(authority);
            const resultRekeys = new LocalSqliteToolResultRekeyRepository(
              authority,
            );
            return Object.freeze({
              invocationArtifacts:
                new LocalSqliteToolInvocationArtifactRepository(authority),
              stepRuns,
              startBarriers: new LocalSqliteToolExecutionStartBarrierRepository(
                authority,
              ),
              completions: new LocalSqliteToolExecutionCompletionRepository(
                authority,
              ),
              failureCompletions:
                new LocalSqliteToolExecutionFailureCompletionRepository(
                  authority,
                ),
              resultKeyCatalog: Object.freeze({
                findCurrent:
                  resultKeyCatalog.findCurrent.bind(resultKeyCatalog),
              }),
              resultRekeys: Object.freeze({
                findHeadByArtifactId:
                  resultRekeys.findHeadByArtifactId.bind(resultRekeys),
              }),
              toolDefinitionSnapshots,
            });
          },
        );
        return trustedToolStoragePromise;
      },
      startupRecovery: runRuntimeCapabilities.startupRecovery,
      close() {
        if (closePromise) return closePromise;
        closePromise = runRepository.close();
        return closePromise;
      },
    });
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function auditLocalSqlitePath(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteReadinessEvidence> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, true);
  try {
    return await auditLocalSqliteReadiness(client);
  } finally {
    client.close();
  }
}

export {
  LocalSqliteConfigurationError,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
};
export {
  LOCAL_SQLITE_CONTRACT_NAME,
  LOCAL_SQLITE_CONTRACT_VERSION,
  LocalSqliteReadinessError,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
export { localSqliteMigrationManifest } from '../migration/migrationManifest';
export { LocalSqliteRunRepository } from '../run/runRepository';
export { LocalSqliteTaskDefinitionRepository } from '../task-definition/taskDefinitionRepository';
export { LocalSqliteTriggerRepository } from '../scheduling/triggerRepository';
export { LocalSqliteScheduleRepository } from '../scheduling/scheduleRepository';
export type {
  LocalRunStartupRecoveryCandidate,
  LocalRunStartupRecoveryPage,
  LocalRunStartupRecoverySource,
  LocalRunStartupRecoveryStatus,
} from '@qinglong/runtime-core/local-startup-recovery';
export { MAX_LOCAL_RUN_STARTUP_RECOVERY_CANDIDATES } from '@qinglong/runtime-core/local-startup-recovery';
