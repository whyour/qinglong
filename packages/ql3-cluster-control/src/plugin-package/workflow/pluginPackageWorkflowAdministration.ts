// Plugin Package Workflow owns inspection and durable authorized admission.
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import { normalizeSecurityAuditRecord } from '@qinglong/runtime-core/security-audit';
import type {
  PluginPackageAutomationPublication,
  PluginPackageAutomationPublicationRepository,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import type {
  PluginPackageMaterializedRevision,
  PluginPackageMaterializedRevisionRepository,
  PluginPackageWorkflowResource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import type {
  PluginPackageWorkflowAdministrationRepository,
  PluginPackageWorkflowRunEventListRepository,
  PluginPackageWorkflowRunEventListResult,
  PluginPackageWorkflowRunInspectionRepository,
  PluginPackageWorkflowRunInspectionResult,
  PluginPackageWorkflowRunListRepository,
  PluginPackageWorkflowRunListResult,
  PluginPackageWorkflowStepRunListRepository,
  PluginPackageWorkflowStepRunListResult,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import type {
  ClusterRunCancellationRepository,
  ClusterRunCancellationResult,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import {
  createPluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowAdmissionReceipt,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  TaskSpecSemanticRegistry,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

export interface ClusterPluginPackageWorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly steps: readonly Readonly<{
    id: string;
    task: string;
    needs: readonly string[];
  }>[];
}

export interface StartClusterPluginPackageWorkflowCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly planId: string;
  readonly runId: string;
  readonly stepRunIds: Readonly<Record<string, string>>;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly plannedAtMs: number;
}

export interface CancelClusterPluginPackageWorkflowCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface InspectClusterPluginPackageWorkflowRunCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly observedAtMs: number;
}

export interface ListClusterPluginPackageWorkflowRunsCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly limit: number;
  readonly after: Readonly<{ admittedAtMs: number; runId: string }> | null;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly observedAtMs: number;
}

export interface ListClusterPluginPackageWorkflowStepRunsCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly after: Readonly<{ stepKey: string; id: string }> | null;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly observedAtMs: number;
}

export interface ListClusterPluginPackageWorkflowRunEventsCommand {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly afterSequence: number;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly observedAtMs: number;
}

export interface ClusterPluginPackageWorkflowAdministrationCapability {
  inspect(
    projectId: string,
    packageName: string,
  ): Promise<
    Readonly<{
      found: boolean;
      publicationState: PluginPackageAutomationPublication['state'] | null;
      workflows: readonly Readonly<ClusterPluginPackageWorkflowSummary>[];
    }>
  >;
  start(command: Readonly<StartClusterPluginPackageWorkflowCommand>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      plan: Readonly<PluginPackageWorkflowExecutionPlan>;
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  >;
  cancel(
    command: Readonly<CancelClusterPluginPackageWorkflowCommand>,
  ): Promise<Readonly<ClusterRunCancellationResult>>;
  inspectRun(
    command: Readonly<InspectClusterPluginPackageWorkflowRunCommand>,
  ): Promise<Readonly<PluginPackageWorkflowRunInspectionResult>>;
  listRuns(
    command: Readonly<ListClusterPluginPackageWorkflowRunsCommand>,
  ): Promise<Readonly<PluginPackageWorkflowRunListResult>>;
  listStepRuns(
    command: Readonly<ListClusterPluginPackageWorkflowStepRunsCommand>,
  ): Promise<Readonly<PluginPackageWorkflowStepRunListResult>>;
  listRunEvents(
    command: Readonly<ListClusterPluginPackageWorkflowRunEventsCommand>,
  ): Promise<Readonly<PluginPackageWorkflowRunEventListResult>>;
}

export class ClusterPluginPackageWorkflowNotFoundError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_WORKFLOW_NOT_FOUND';

  constructor() {
    super('Active Plugin Package Workflow is not available');
    this.name = 'ClusterPluginPackageWorkflowNotFoundError';
  }
}

export class ClusterPluginPackageWorkflowConflictError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_WORKFLOW_CONFLICT';

  constructor() {
    super('Plugin Package Workflow request conflicts with durable identity');
    this.name = 'ClusterPluginPackageWorkflowConflictError';
  }
}

export class ClusterPluginPackageWorkflowUnavailableError extends Error {
  readonly code = 'CLUSTER_PLUGIN_PACKAGE_WORKFLOW_UNAVAILABLE';

  constructor() {
    super('Plugin Package Workflow administration is unavailable');
    this.name = 'ClusterPluginPackageWorkflowUnavailableError';
  }
}

function summary(
  workflow: Readonly<PluginPackageWorkflowResource>,
): Readonly<ClusterPluginPackageWorkflowSummary> {
  return Object.freeze({
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled,
    steps: Object.freeze(
      workflow.steps.map((step) =>
        Object.freeze({
          id: step.id,
          task: step.task,
          needs: Object.freeze([...step.needs]),
        }),
      ),
    ),
  });
}

function sameReplay(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  command: Readonly<StartClusterPluginPackageWorkflowCommand>,
): boolean {
  const requested = Object.entries(command.stepRunIds).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const stored = plan.steps
    .map((step) => [step.stepKey, step.stepRunId] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    plan.planId === command.planId &&
    plan.runId === command.runId &&
    plan.target.projectId === command.projectId &&
    plan.target.packageName === command.packageName &&
    plan.target.workflowId === command.workflowId &&
    stored.length === requested.length &&
    stored.every(
      ([key, id], index) =>
        key === requested[index]?.[0] && id === requested[index]?.[1],
    )
  );
}

export function createClusterPluginPackageWorkflowAdministrationCapability(
  publications: Pick<
    PluginPackageAutomationPublicationRepository,
    'findCurrent'
  >,
  revisions: Pick<PluginPackageMaterializedRevisionRepository, 'find'>,
  admissions: PluginPackageWorkflowAdministrationRepository,
  runInspections: PluginPackageWorkflowRunInspectionRepository,
  runLists: PluginPackageWorkflowRunListRepository,
  stepRunLists: PluginPackageWorkflowStepRunListRepository,
  runEventLists: PluginPackageWorkflowRunEventListRepository,
  cancellations: ClusterRunCancellationRepository,
  taskSpecSemanticRegistry: TaskSpecSemanticRegistry = createBuiltInTaskSpecSemanticRegistry(),
): ClusterPluginPackageWorkflowAdministrationCapability {
  if (
    !publications ||
    typeof publications.findCurrent !== 'function' ||
    !revisions ||
    typeof revisions.find !== 'function' ||
    !admissions ||
    typeof admissions.findPlanByPlanId !== 'function' ||
    typeof admissions.admitAuthorized !== 'function' ||
    !runInspections ||
    typeof runInspections.inspectRunAuthorized !== 'function' ||
    !runLists ||
    typeof runLists.listRunsAuthorized !== 'function' ||
    !stepRunLists ||
    typeof stepRunLists.listStepRunsAuthorized !== 'function' ||
    !runEventLists ||
    typeof runEventLists.listRunEventsAuthorized !== 'function' ||
    !cancellations ||
    typeof cancellations.requestUserCancellation !== 'function' ||
    !(taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
  ) {
    throw new TypeError(
      'Cluster Plugin Package Workflow administration dependencies are invalid',
    );
  }

  async function currentTarget(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<{
    publication: Readonly<PluginPackageAutomationPublication>;
    revision: Readonly<PluginPackageMaterializedRevision>;
  }> | null> {
    try {
      const publication = await publications.findCurrent(
        projectId,
        packageName,
      );
      if (!publication) return null;
      const revision = await revisions.find(
        publication.target.generationDigest,
      );
      if (
        !revision ||
        revision.revisionDigest !==
          publication.target.materializedRevisionDigest
      ) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return Object.freeze({ publication, revision });
    } catch (error) {
      if (error instanceof ClusterPluginPackageWorkflowUnavailableError) {
        throw error;
      }
      throw new ClusterPluginPackageWorkflowUnavailableError();
    }
  }

  return Object.freeze({
    async inspect(projectId: string, packageName: string) {
      const target = await currentTarget(projectId, packageName);
      return target
        ? Object.freeze({
            found: true,
            publicationState: target.publication.state,
            workflows: Object.freeze(
              target.publication.definitions.workflows.map(summary),
            ),
          })
        : Object.freeze({
            found: false,
            publicationState: null,
            workflows: Object.freeze([]),
          });
    },

    async start(command: Readonly<StartClusterPluginPackageWorkflowCommand>) {
      let plan = await admissions.findPlanByPlanId(command.planId);
      if (plan) {
        if (!sameReplay(plan, command)) {
          throw new ClusterPluginPackageWorkflowConflictError();
        }
      } else {
        const target = await currentTarget(
          command.projectId,
          command.packageName,
        );
        const workflow = target?.publication.definitions.workflows.find(
          ({ id }) => id === command.workflowId,
        );
        if (
          !target ||
          target.publication.state !== 'active' ||
          !workflow?.enabled
        ) {
          throw new ClusterPluginPackageWorkflowNotFoundError();
        }
        try {
          plan = createPluginPackageWorkflowExecutionPlan({
            planId: command.planId,
            runId: command.runId,
            workflowId: command.workflowId,
            stepRunIds: command.stepRunIds,
            publication: target.publication,
            revision: target.revision,
            taskSpecSemanticRegistry,
            plannedAtMs: command.plannedAtMs,
          });
        } catch {
          throw new ClusterPluginPackageWorkflowConflictError();
        }
      }
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      const admitted = await admissions.admitAuthorized({
        plan,
        actor: command.principal.subject,
        fence: {
          projectVersion: command.policyFence.projectVersion,
          bindingVersion: command.policyFence.bindingVersion,
        },
        audit: normalizeSecurityAuditRecord({
          eventId: command.planId,
          requestId: command.planId,
          operationId: 'workflow.start',
          projectId: command.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: command.policyFence,
          occurredAtMs: plan.plannedAtMs,
        }),
      });
      return Object.freeze({
        status: admitted.status,
        plan,
        receipt: admitted.receipt,
      });
    },

    async cancel(command: Readonly<CancelClusterPluginPackageWorkflowCommand>) {
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return cancellations.requestUserCancellation({
        projectId: command.projectId,
        runId: command.runId,
        mutationId: command.mutationId,
        eventId: command.eventId,
        subject: command.principal.subject,
        policyFence: command.policyFence,
        workflowTarget: {
          packageName: command.packageName,
          workflowId: command.workflowId,
        },
      });
    },

    async inspectRun(
      command: Readonly<InspectClusterPluginPackageWorkflowRunCommand>,
    ) {
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return runInspections.inspectRunAuthorized({
        projectId: command.projectId,
        packageName: command.packageName,
        workflowId: command.workflowId,
        runId: command.runId,
        actor: command.principal.subject,
        fence: {
          projectVersion: command.policyFence.projectVersion,
          bindingVersion: command.policyFence.bindingVersion,
        },
        audit: normalizeSecurityAuditRecord({
          eventId: command.auditEventId,
          requestId: command.requestId,
          operationId: 'workflow.run.read',
          projectId: command.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: command.policyFence,
          occurredAtMs: command.observedAtMs,
        }),
      });
    },

    async listRuns(
      command: Readonly<ListClusterPluginPackageWorkflowRunsCommand>,
    ) {
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return runLists.listRunsAuthorized({
        projectId: command.projectId,
        packageName: command.packageName,
        workflowId: command.workflowId,
        limit: command.limit,
        after: command.after,
        actor: command.principal.subject,
        fence: {
          projectVersion: command.policyFence.projectVersion,
          bindingVersion: command.policyFence.bindingVersion,
        },
        audit: normalizeSecurityAuditRecord({
          eventId: command.auditEventId,
          requestId: command.requestId,
          operationId: 'workflow.run.list',
          projectId: command.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: command.policyFence,
          occurredAtMs: command.observedAtMs,
        }),
      });
    },

    async listStepRuns(
      command: Readonly<ListClusterPluginPackageWorkflowStepRunsCommand>,
    ) {
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return stepRunLists.listStepRunsAuthorized({
        projectId: command.projectId,
        packageName: command.packageName,
        workflowId: command.workflowId,
        runId: command.runId,
        limit: command.limit,
        after: command.after,
        actor: command.principal.subject,
        fence: {
          projectVersion: command.policyFence.projectVersion,
          bindingVersion: command.policyFence.bindingVersion,
        },
        audit: normalizeSecurityAuditRecord({
          eventId: command.auditEventId,
          requestId: command.requestId,
          operationId: 'workflow.step.list',
          projectId: command.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: command.policyFence,
          occurredAtMs: command.observedAtMs,
        }),
      });
    },

    async listRunEvents(
      command: Readonly<ListClusterPluginPackageWorkflowRunEventsCommand>,
    ) {
      if (command.policyFence.bindingVersion === null) {
        throw new ClusterPluginPackageWorkflowUnavailableError();
      }
      return runEventLists.listRunEventsAuthorized({
        projectId: command.projectId,
        packageName: command.packageName,
        workflowId: command.workflowId,
        runId: command.runId,
        limit: command.limit,
        afterSequence: command.afterSequence,
        actor: command.principal.subject,
        fence: {
          projectVersion: command.policyFence.projectVersion,
          bindingVersion: command.policyFence.bindingVersion,
        },
        audit: normalizeSecurityAuditRecord({
          eventId: command.auditEventId,
          requestId: command.requestId,
          operationId: 'workflow.event.list',
          projectId: command.projectId,
          subject: command.principal.subject,
          authenticationId: command.principal.authenticationId,
          outcome: 'allowed',
          reasons: ['project_policy_allowed'],
          fence: command.policyFence,
          occurredAtMs: command.observedAtMs,
        }),
      });
    },
  });
}
