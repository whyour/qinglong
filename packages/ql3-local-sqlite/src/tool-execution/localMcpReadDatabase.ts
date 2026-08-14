import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import type { ProjectPolicyRepository } from '@qinglong/runtime-core/project-policy';
import type {
  ProjectRunListQuery,
  ProjectRunListReader,
} from '@qinglong/runtime-core/project-run-list';
import type {
  TaskRunOutcomeWindowQuery,
  TaskRunOutcomeWindowReader,
} from '@qinglong/runtime-core/task-run-outcome-window';
import {
  RunRepositoryBusyError,
  RunRepositoryOperationError,
  type RunRepositoryReader,
} from '@qinglong/runtime-core/run-repository';
import type { SecurityAuditSink } from '@qinglong/runtime-core/security-audit';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';
import type { TriggerSource } from '@qinglong/runtime-core/trigger';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';
import type {
  ApprovalRequestDetailSource,
  ApprovalRequestSource,
} from '@qinglong/runtime-core/approval-discovery';
import type { RunAttemptLogRetentionStateReader } from '@qinglong/runtime-core/run-attempt-log-retention';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteOwnerPepperRepository } from '../local-owner/ownerPepperRepository';
import {
  auditLocalSqliteReadiness,
  type LocalSqliteReadinessEvidence,
} from '../readiness/readiness';
import { LocalSqliteRunReader } from '../run/runReader';
import { LocalSqliteRunAttemptLogRetentionRepository } from '../run/runAttemptLogRetentionRepository';
import { LocalSqliteTaskRunOutcomeWindowReader } from '../run/outcome-comparison/taskRunOutcomeWindowReader';
import { LocalSqliteStepRunRepository } from '../run/stepRunRepository';
import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
  type LocalSqliteProfile,
} from '../storage/config';
import { LocalSqliteApiCredentialRepository } from '../security/apiCredentialRepository';
import { LocalSqliteSecurityAuthorityStore } from '../security/securityAuthorityStore';
import { LocalSqliteTriggerRepository } from '../scheduling/triggerRepository';
import { LocalSqliteApprovalRequestSource } from '../approved-action/approvalRequestSource';
import { LocalSqliteTaskDefinitionRepository } from '../task-definition/taskDefinitionRepository';

export interface LocalSqliteMcpReadDatabase {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly runs: Pick<
    RunRepositoryReader,
    'findRunById' | 'findAttemptById' | 'listEvents'
  > &
    ProjectRunListReader &
    TaskRunOutcomeWindowReader;
  readonly runAttemptLogRetention: RunAttemptLogRetentionStateReader;
  readonly stepRuns: Pick<StepRunRepository, 'listByRun'>;
  readonly taskDefinitions: Pick<
    TaskDefinitionSource,
    'findCurrentTaskDefinition' | 'listTaskDefinitions'
  >;
  readonly triggers: Pick<TriggerSource, 'listTriggers'>;
  readonly approvals: Pick<ApprovalRequestSource, 'listApprovalRequests'> &
    Pick<ApprovalRequestDetailSource, 'getApprovalRequestDetail'>;
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
  readonly projectPolicy: Pick<ProjectPolicyRepository, 'resolve'>;
  readonly securityAudit: SecurityAuditSink;
  close(): Promise<void>;
}

/**
 * Opens the single bounded SQLite authority used by the optional local MCP
 * process. It intentionally exposes only credential verification, Project
 * Policy, durable Audit and bounded Run/Step/Task reads. Migrations and all
 * management/write surfaces stay outside this composition.
 */
export async function openLocalSqliteMcpReadDatabase(
  options: LocalSqliteDatabaseOptions,
): Promise<LocalSqliteMcpReadDatabase> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const client = openLocalSqliteClient(options, false);
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    const authority = new LocalSqliteOperationAuthority(client);
    const reader = new LocalSqliteRunReader(client);
    const runAttemptLogRetention =
      new LocalSqliteRunAttemptLogRetentionRepository(authority);
    const outcomeWindowReader = new LocalSqliteTaskRunOutcomeWindowReader(
      client,
    );
    const stepRunRepository = new LocalSqliteStepRunRepository(authority);
    const taskRepository = new LocalSqliteTaskDefinitionRepository(authority);
    const triggerRepository = new LocalSqliteTriggerRepository(authority);
    const approvalSource = new LocalSqliteApprovalRequestSource(authority);
    const security = new LocalSqliteSecurityAuthorityStore(authority);
    const runs: Pick<
      RunRepositoryReader,
      'findRunById' | 'findAttemptById' | 'listEvents'
    > &
      ProjectRunListReader &
      TaskRunOutcomeWindowReader = Object.freeze({
      listRunsByProject(query: Readonly<ProjectRunListQuery>) {
        return authority.enqueue(
          () => reader.listRunsByProject(query),
          (reason) =>
            reason === 'busy'
              ? new RunRepositoryBusyError()
              : new RunRepositoryOperationError(
                  new Error('Local SQLite MCP read database is closed'),
                ),
        );
      },
      listRecentRunsByTask(query: Readonly<TaskRunOutcomeWindowQuery>) {
        return authority.enqueue(
          () => outcomeWindowReader.listRecentRunsByTask(query),
          (reason) =>
            reason === 'busy'
              ? new RunRepositoryBusyError()
              : new RunRepositoryOperationError(
                  new Error('Local SQLite MCP read database is closed'),
                ),
        );
      },
      findRunById(runId: string) {
        return authority.enqueue(
          () => reader.findRunById(runId),
          (reason) =>
            reason === 'busy'
              ? new RunRepositoryBusyError()
              : new RunRepositoryOperationError(
                  new Error('Local SQLite MCP read database is closed'),
                ),
        );
      },
      findAttemptById(attemptId: string) {
        return authority.enqueue(
          () => reader.findAttemptById(attemptId),
          (reason) =>
            reason === 'busy'
              ? new RunRepositoryBusyError()
              : new RunRepositoryOperationError(
                  new Error('Local SQLite MCP read database is closed'),
                ),
        );
      },
      listEvents(
        runId: string,
        options?: { afterSequence?: number; limit?: number },
      ) {
        return authority.enqueue(
          () => reader.listEvents(runId, options),
          (reason) =>
            reason === 'busy'
              ? new RunRepositoryBusyError()
              : new RunRepositoryOperationError(
                  new Error('Local SQLite MCP read database is closed'),
                ),
        );
      },
    });
    const projectPolicy: Pick<ProjectPolicyRepository, 'resolve'> =
      Object.freeze({
        resolve: (...args: Parameters<ProjectPolicyRepository['resolve']>) =>
          security.resolve(...args),
      });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      profile: options.profile,
      readiness,
      runs,
      runAttemptLogRetention: Object.freeze({
        inspect: runAttemptLogRetention.inspect.bind(runAttemptLogRetention),
      }),
      stepRuns: Object.freeze({
        listByRun: stepRunRepository.listByRun.bind(stepRunRepository),
      }),
      taskDefinitions: Object.freeze({
        findCurrentTaskDefinition:
          taskRepository.findCurrentTaskDefinition.bind(taskRepository),
        listTaskDefinitions:
          taskRepository.listTaskDefinitions.bind(taskRepository),
      }),
      triggers: Object.freeze({
        listTriggers: triggerRepository.listTriggers.bind(triggerRepository),
      }),
      approvals: Object.freeze({
        listApprovalRequests:
          approvalSource.listApprovalRequests.bind(approvalSource),
        getApprovalRequestDetail:
          approvalSource.getApprovalRequestDetail.bind(approvalSource),
      }),
      apiCredentials: new LocalSqliteApiCredentialRepository(authority),
      ownerPepper: new LocalSqliteOwnerPepperRepository(authority),
      projectPolicy,
      securityAudit: security,
      close() {
        if (closePromise) return closePromise;
        closePromise = authority.close();
        return closePromise;
      },
    });
  } catch (error) {
    if (client.isOpen) client.close();
    throw error;
  }
}
