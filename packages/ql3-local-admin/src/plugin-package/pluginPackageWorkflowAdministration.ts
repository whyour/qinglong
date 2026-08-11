import {
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  type ProjectPolicyRepository,
} from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyDecision,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import type {
  PluginPackageAutomationPublication,
  PluginPackageAutomationPublicationRepository,
} from '@qinglong/runtime-core/plugin-package-automation-publication';
import type {
  PluginPackageMaterializedRevision,
  PluginPackageMaterializedRevisionRepository,
  PluginPackageWorkflowResource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';
import {
  MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE,
  PluginPackageWorkflowCancellationNotFoundError,
  type PluginPackageWorkflowAdministrationRepository,
  type PluginPackageWorkflowCancellationRepository,
  type PluginPackageWorkflowCancellationResult,
  type PluginPackageWorkflowRunEventListRepository,
  type PluginPackageWorkflowRunEventListResult,
  type PluginPackageWorkflowRunListRepository,
  type PluginPackageWorkflowRunListResult,
  type PluginPackageWorkflowRunInspectionRepository,
  type PluginPackageWorkflowRunInspectionResult,
  type PluginPackageWorkflowStepRunListRepository,
  type PluginPackageWorkflowStepRunListResult,
} from '@qinglong/runtime-core/plugin-package-workflow-administration';
import {
  createPluginPackageWorkflowExecutionPlan,
  type PluginPackageWorkflowAdmissionReceipt,
  type PluginPackageWorkflowExecutionPlan,
} from '@qinglong/runtime-core/plugin-package-workflow-execution-plan';
import {
  createBuiltInTaskSpecSemanticRegistry,
  TaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;
const STRONG_USER_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);

export interface StartLocalPluginPackageWorkflowRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly planId: string;
  readonly runId: string;
  readonly stepRunIds: Readonly<Record<string, string>>;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectLocalPluginPackageWorkflowsRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface CancelLocalPluginPackageWorkflowRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly runEventId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface InspectLocalPluginPackageWorkflowRunRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListLocalPluginPackageWorkflowRunsRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly limit: number;
  readonly after: Readonly<{ admittedAtMs: number; runId: string }> | null;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListLocalPluginPackageWorkflowStepRunsRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly after: Readonly<{ stepKey: string; id: string }> | null;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface ListLocalPluginPackageWorkflowRunEventsRequest {
  readonly projectId: string;
  readonly packageName: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly limit: number;
  readonly afterSequence: number;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: SecurityPrincipal;
}

export interface LocalPluginPackageWorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly steps: readonly Readonly<{
    id: string;
    task: string;
    needs: readonly string[];
  }>[];
}

export interface LocalPluginPackageWorkflowAdministrationService {
  inspect(request: InspectLocalPluginPackageWorkflowsRequest): Promise<
    Readonly<{
      found: boolean;
      publicationState: PluginPackageAutomationPublication['state'] | null;
      workflows: readonly Readonly<LocalPluginPackageWorkflowSummary>[];
    }>
  >;
  start(request: StartLocalPluginPackageWorkflowRequest): Promise<
    Readonly<{
      status: 'created' | 'existing';
      plan: Readonly<PluginPackageWorkflowExecutionPlan>;
      receipt: Readonly<PluginPackageWorkflowAdmissionReceipt>;
    }>
  >;
  cancel(
    request: CancelLocalPluginPackageWorkflowRequest,
  ): Promise<Readonly<PluginPackageWorkflowCancellationResult>>;
  inspectRun(
    request: InspectLocalPluginPackageWorkflowRunRequest,
  ): Promise<Readonly<PluginPackageWorkflowRunInspectionResult>>;
  listRuns(
    request: ListLocalPluginPackageWorkflowRunsRequest,
  ): Promise<Readonly<PluginPackageWorkflowRunListResult>>;
  listStepRuns(
    request: ListLocalPluginPackageWorkflowStepRunsRequest,
  ): Promise<Readonly<PluginPackageWorkflowStepRunListResult>>;
  listRunEvents(
    request: ListLocalPluginPackageWorkflowRunEventsRequest,
  ): Promise<Readonly<PluginPackageWorkflowRunEventListResult>>;
}

export interface LocalPluginPackageWorkflowAdministrationOptions {
  readonly now?: () => number;
  readonly taskSpecSemanticRegistry?: TaskSpecSemanticRegistry;
}

export class LocalPluginPackageWorkflowAdministrationConfigurationError extends TypeError {
  readonly code =
    'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(
      `Local Plugin Package Workflow administration configuration is invalid: ${message}`,
    );
    this.name = 'LocalPluginPackageWorkflowAdministrationConfigurationError';
  }
}

export class LocalPluginPackageWorkflowAdministrationAuthenticationError extends Error {
  readonly code =
    'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_AUTHENTICATION_REQUIRED';

  constructor() {
    super(
      'Local Plugin Package Workflow administration requires a strong User',
    );
    this.name = 'LocalPluginPackageWorkflowAdministrationAuthenticationError';
  }
}

export class LocalPluginPackageWorkflowAdministrationAuthorizationError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_FORBIDDEN';

  constructor() {
    super('Local Plugin Package Workflow administration is not authorized');
    this.name = 'LocalPluginPackageWorkflowAdministrationAuthorizationError';
  }
}

export class LocalPluginPackageWorkflowAdministrationNotFoundError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_NOT_FOUND';

  constructor() {
    super('Active Plugin Package Workflow is not available');
    this.name = 'LocalPluginPackageWorkflowAdministrationNotFoundError';
  }
}

export class LocalPluginPackageWorkflowAdministrationUnavailableError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_WORKFLOW_ADMINISTRATION_UNAVAILABLE';

  constructor() {
    super('Local Plugin Package Workflow administration is unavailable');
    this.name = 'LocalPluginPackageWorkflowAdministrationUnavailableError';
  }
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'clock is invalid',
    );
  }
  return value;
}

function strongUser(
  value: SecurityPrincipal,
  nowMs: number,
): Readonly<SecurityPrincipal> {
  try {
    const principal = normalizeSecurityPrincipal(value, nowMs);
    if (
      principal.subject.type !== 'user' ||
      !STRONG_USER_ASSURANCES.has(principal.assurance)
    ) {
      throw new LocalPluginPackageWorkflowAdministrationAuthenticationError();
    }
    return principal;
  } catch (error) {
    if (
      error instanceof
      LocalPluginPackageWorkflowAdministrationAuthenticationError
    ) {
      throw error;
    }
    throw new LocalPluginPackageWorkflowAdministrationAuthenticationError();
  }
}

function identity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      `${label} is invalid`,
    );
  }
  return value;
}

function requestIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      `${label} is invalid`,
    );
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      `${label} must be a UUID v4`,
    );
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'packageName is invalid',
    );
  }
  return value;
}

function workflowId(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'workflowId is invalid',
    );
  }
  return value;
}

function normalizeStepRunIds(value: unknown): Readonly<Record<string, string>> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'stepRunIds must be an object',
    );
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 128) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'stepRunIds cardinality is invalid',
    );
  }
  const normalized = Object.fromEntries(
    entries.map(([key, candidate]) => [
      workflowId(key),
      uuid(candidate, `stepRunIds.${key}`),
    ]),
  );
  if (new Set(Object.values(normalized)).size !== entries.length) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'stepRunIds must be unique',
    );
  }
  return Object.freeze(normalized);
}

function normalizeInspectRequest(
  value: InspectLocalPluginPackageWorkflowsRequest,
): Readonly<InspectLocalPluginPackageWorkflowsRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'packageName',
      'principal',
      'projectId',
      'requestId',
    ])
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'inspect request shape is invalid',
    );
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeStartRequest(
  value: StartLocalPluginPackageWorkflowRequest,
): Readonly<StartLocalPluginPackageWorkflowRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'packageName',
      'planId',
      'principal',
      'projectId',
      'requestId',
      'runId',
      'stepRunIds',
      'workflowId',
    ])
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'start request shape is invalid',
    );
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: workflowId(value.workflowId),
    planId: uuid(value.planId, 'planId'),
    runId: uuid(value.runId, 'runId'),
    stepRunIds: normalizeStepRunIds(value.stepRunIds),
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeCancelRequest(
  value: CancelLocalPluginPackageWorkflowRequest,
): Readonly<CancelLocalPluginPackageWorkflowRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'mutationId',
      'packageName',
      'principal',
      'projectId',
      'requestId',
      'runEventId',
      'runId',
    ])
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'cancel request shape is invalid',
    );
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    runId: uuid(value.runId, 'runId'),
    mutationId: uuid(value.mutationId, 'mutationId'),
    runEventId: uuid(value.runEventId, 'runEventId'),
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeInspectRunRequest(
  value: InspectLocalPluginPackageWorkflowRunRequest,
): Readonly<InspectLocalPluginPackageWorkflowRunRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'auditEventId',
      'packageName',
      'principal',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ])
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'run inspection request shape is invalid',
    );
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: workflowId(value.workflowId),
    runId: uuid(value.runId, 'runId'),
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeListRunsRequest(
  value: ListLocalPluginPackageWorkflowRunsRequest,
): Readonly<ListLocalPluginPackageWorkflowRunsRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'after',
      'auditEventId',
      'limit',
      'packageName',
      'principal',
      'projectId',
      'requestId',
      'workflowId',
    ]) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_PLUGIN_PACKAGE_WORKFLOW_RUN_LIST_PAGE_SIZE
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'run list request shape is invalid',
    );
  }
  let after: Readonly<{ admittedAtMs: number; runId: string }> | null = null;
  if (value.after !== null) {
    if (
      !value.after ||
      typeof value.after !== 'object' ||
      Array.isArray(value.after) ||
      !exactKeys(value.after, ['admittedAtMs', 'runId']) ||
      !Number.isSafeInteger(value.after.admittedAtMs) ||
      value.after.admittedAtMs < 0
    ) {
      throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
        'run list cursor is invalid',
      );
    }
    after = Object.freeze({
      admittedAtMs: value.after.admittedAtMs,
      runId: uuid(value.after.runId, 'after.runId'),
    });
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: workflowId(value.workflowId),
    limit: value.limit,
    after,
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeListStepRunsRequest(
  value: ListLocalPluginPackageWorkflowStepRunsRequest,
): Readonly<ListLocalPluginPackageWorkflowStepRunsRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'after',
      'auditEventId',
      'limit',
      'packageName',
      'principal',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ]) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 64
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'StepRun list request shape is invalid',
    );
  }
  let after: Readonly<{ stepKey: string; id: string }> | null = null;
  if (value.after !== null) {
    if (
      !value.after ||
      typeof value.after !== 'object' ||
      Array.isArray(value.after) ||
      !exactKeys(value.after, ['id', 'stepKey'])
    ) {
      throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
        'StepRun list cursor is invalid',
      );
    }
    after = Object.freeze({
      stepKey: workflowId(value.after.stepKey),
      id: uuid(value.after.id, 'after.id'),
    });
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: workflowId(value.workflowId),
    runId: uuid(value.runId, 'runId'),
    limit: value.limit,
    after,
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function normalizeListRunEventsRequest(
  value: ListLocalPluginPackageWorkflowRunEventsRequest,
): Readonly<ListLocalPluginPackageWorkflowRunEventsRequest> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'afterSequence',
      'auditEventId',
      'limit',
      'packageName',
      'principal',
      'projectId',
      'requestId',
      'runId',
      'workflowId',
    ]) ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 64 ||
    !Number.isSafeInteger(value.afterSequence) ||
    value.afterSequence < 0
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'RunEvent list request shape is invalid',
    );
  }
  return Object.freeze({
    projectId: identity(value.projectId, 'projectId'),
    packageName: packageName(value.packageName),
    workflowId: workflowId(value.workflowId),
    runId: uuid(value.runId, 'runId'),
    limit: value.limit,
    afterSequence: value.afterSequence,
    requestId: requestIdentity(value.requestId, 'requestId'),
    auditEventId: uuid(value.auditEventId, 'auditEventId'),
    principal: value.principal,
  });
}

function auditRecord(options: {
  readonly eventId: string;
  readonly requestId: string;
  readonly operationId:
    | 'workflow.read'
    | 'workflow.run.read'
    | 'workflow.run.list'
    | 'workflow.step.list'
    | 'workflow.event.list'
    | 'workflow.start'
    | 'workflow.cancel';
  readonly projectId: string;
  readonly principal: Readonly<SecurityPrincipal> | null;
  readonly outcome: SecurityAuditRecord['outcome'];
  readonly reasons: readonly string[];
  readonly fence: SecurityPolicyDecision['fence'];
  readonly occurredAtMs: number;
}): Readonly<SecurityAuditRecord> {
  return normalizeSecurityAuditRecord({
    eventId: options.eventId,
    requestId: options.requestId,
    operationId: options.operationId,
    projectId: options.projectId,
    subject: options.principal?.subject ?? null,
    authenticationId: options.principal?.authenticationId ?? null,
    outcome: options.outcome,
    reasons: options.reasons,
    fence: options.fence,
    occurredAtMs: options.occurredAtMs,
  });
}

function workflowSummary(
  value: Readonly<PluginPackageWorkflowResource>,
): Readonly<LocalPluginPackageWorkflowSummary> {
  return Object.freeze({
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    steps: Object.freeze(
      value.steps.map((step) =>
        Object.freeze({
          id: step.id,
          task: step.task,
          needs: Object.freeze([...step.needs]),
        }),
      ),
    ),
  });
}

function sameStepRunIds(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  request: Readonly<StartLocalPluginPackageWorkflowRequest>,
): boolean {
  const expected = Object.entries(request.stepRunIds).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const actual = plan.steps
    .map((step) => [step.stepKey, step.stepRunId] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    actual.length === expected.length &&
    actual.every(
      ([key, id], index) =>
        key === expected[index]?.[0] && id === expected[index]?.[1],
    )
  );
}

function assertReplayRequest(
  plan: Readonly<PluginPackageWorkflowExecutionPlan>,
  request: Readonly<StartLocalPluginPackageWorkflowRequest>,
): void {
  if (
    plan.planId !== request.planId ||
    plan.runId !== request.runId ||
    plan.target.projectId !== request.projectId ||
    plan.target.packageName !== request.packageName ||
    plan.target.workflowId !== request.workflowId ||
    !sameStepRunIds(plan, request)
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'start request conflicts with the durable plan',
    );
  }
}

export function createLocalPluginPackageWorkflowAdministrationService(
  projectPolicy: ProjectPolicyRepository,
  publications: Pick<
    PluginPackageAutomationPublicationRepository,
    'findCurrent'
  >,
  revisions: Pick<PluginPackageMaterializedRevisionRepository, 'find'>,
  admissions: PluginPackageWorkflowAdministrationRepository &
    PluginPackageWorkflowCancellationRepository &
    PluginPackageWorkflowRunInspectionRepository &
    PluginPackageWorkflowRunListRepository &
    PluginPackageWorkflowStepRunListRepository &
    PluginPackageWorkflowRunEventListRepository,
  audit: SecurityAuditSink,
  options: LocalPluginPackageWorkflowAdministrationOptions = {},
): LocalPluginPackageWorkflowAdministrationService {
  if (
    !projectPolicy ||
    typeof projectPolicy.resolve !== 'function' ||
    !publications ||
    typeof publications.findCurrent !== 'function' ||
    !revisions ||
    typeof revisions.find !== 'function' ||
    !admissions ||
    typeof admissions.findPlanByPlanId !== 'function' ||
    typeof admissions.admitAuthorized !== 'function' ||
    typeof admissions.requestUserCancellation !== 'function' ||
    typeof admissions.inspectRunAuthorized !== 'function' ||
    typeof admissions.listRunsAuthorized !== 'function' ||
    typeof admissions.listStepRunsAuthorized !== 'function' ||
    typeof admissions.listRunEventsAuthorized !== 'function' ||
    !audit ||
    typeof audit.record !== 'function' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [], ['now', 'taskSpecSemanticRegistry']) ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.taskSpecSemanticRegistry !== undefined &&
      !(options.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry))
  ) {
    throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
      'dependencies or options are invalid',
    );
  }
  const policy = new ProjectPolicyEngine(projectPolicy);
  const now = options.now ?? Date.now;
  const taskSpecSemanticRegistry =
    options.taskSpecSemanticRegistry ?? createBuiltInTaskSpecSemanticRegistry();

  async function authorize(request: {
    readonly eventId: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly operationId:
      | 'workflow.read'
      | 'workflow.run.read'
      | 'workflow.run.list'
      | 'workflow.step.list'
      | 'workflow.event.list'
      | 'workflow.start'
      | 'workflow.cancel';
    readonly permission: 'run.read' | 'run.start' | 'run.stop';
    readonly principal: SecurityPrincipal;
    readonly nowMs: number;
    readonly auditAtMs: number;
  }): Promise<
    Readonly<{
      principal: Readonly<SecurityPrincipal>;
      decision: Readonly<SecurityPolicyDecision>;
    }>
  > {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = strongUser(request.principal, request.nowMs);
    } catch (error) {
      try {
        await audit.record(
          auditRecord({
            ...request,
            occurredAtMs: request.auditAtMs,
            principal: null,
            outcome: 'authentication_rejected',
            reasons: ['strong_authentication_required'],
            fence: null,
          }),
        );
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      throw error;
    }
    let decision: Readonly<SecurityPolicyDecision>;
    try {
      decision = await policy.authorize(
        principal,
        request.projectId,
        request.permission,
      );
    } catch (error) {
      if (!(error instanceof ProjectPolicyUnavailableError)) {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      try {
        await audit.record(
          auditRecord({
            ...request,
            occurredAtMs: request.auditAtMs,
            principal,
            outcome: 'authorization_unavailable',
            reasons: ['policy_unavailable'],
            fence: null,
          }),
        );
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
    }
    if (decision.effect !== 'allow') {
      try {
        await audit.record(
          auditRecord({
            ...request,
            occurredAtMs: request.auditAtMs,
            principal,
            outcome:
              decision.effect === 'require_approval'
                ? 'approval_required'
                : 'denied',
            reasons: decision.reasons,
            fence: decision.fence,
          }),
        );
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      throw new LocalPluginPackageWorkflowAdministrationAuthorizationError();
    }
    if (!decision.fence || decision.fence.bindingVersion === null) {
      throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
    }
    return Object.freeze({ principal, decision });
  }

  async function currentTarget(
    projectId: string,
    targetPackageName: string,
  ): Promise<Readonly<{
    publication: Readonly<PluginPackageAutomationPublication>;
    revision: Readonly<PluginPackageMaterializedRevision>;
  }> | null> {
    try {
      const publication = await publications.findCurrent(
        projectId,
        targetPackageName,
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
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      return Object.freeze({ publication, revision });
    } catch (error) {
      if (
        error instanceof
        LocalPluginPackageWorkflowAdministrationUnavailableError
      ) {
        throw error;
      }
      throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
    }
  }

  return Object.freeze({
    async inspect(request: InspectLocalPluginPackageWorkflowsRequest) {
      const normalized = normalizeInspectRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.read',
        permission: 'run.read',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      const target = await currentTarget(
        normalized.projectId,
        normalized.packageName,
      );
      try {
        await audit.record(
          auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.read',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        );
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
      return target
        ? Object.freeze({
            found: true,
            publicationState: target.publication.state,
            workflows: Object.freeze(
              target.publication.definitions.workflows.map(workflowSummary),
            ),
          })
        : Object.freeze({
            found: false,
            publicationState: null,
            workflows: Object.freeze([]),
          });
    },

    async start(request: StartLocalPluginPackageWorkflowRequest) {
      const normalized = normalizeStartRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.start',
        permission: 'run.start',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      let plan = await admissions.findPlanByPlanId(normalized.planId);
      if (plan) {
        assertReplayRequest(plan, normalized);
      } else {
        const target = await currentTarget(
          normalized.projectId,
          normalized.packageName,
        );
        if (!target || target.publication.state !== 'active') {
          throw new LocalPluginPackageWorkflowAdministrationNotFoundError();
        }
        const workflow = target.publication.definitions.workflows.find(
          ({ id }) => id === normalized.workflowId,
        );
        if (!workflow || !workflow.enabled) {
          throw new LocalPluginPackageWorkflowAdministrationNotFoundError();
        }
        try {
          plan = createPluginPackageWorkflowExecutionPlan({
            planId: normalized.planId,
            runId: normalized.runId,
            workflowId: normalized.workflowId,
            stepRunIds: normalized.stepRunIds,
            publication: target.publication,
            revision: target.revision,
            taskSpecSemanticRegistry,
            plannedAtMs: nowMs,
          });
        } catch {
          throw new LocalPluginPackageWorkflowAdministrationConfigurationError(
            'Workflow execution identity does not match the publication',
          );
        }
      }
      const admitted = await admissions.admitAuthorized({
        plan,
        actor: authorization.principal.subject,
        fence: authorization.decision.fence as NonNullable<
          SecurityPolicyDecision['fence']
        >,
        audit: auditRecord({
          eventId: normalized.auditEventId,
          requestId: normalized.requestId,
          operationId: 'workflow.start',
          projectId: normalized.projectId,
          principal: authorization.principal,
          outcome: 'allowed',
          reasons: authorization.decision.reasons,
          fence: authorization.decision.fence,
          occurredAtMs: plan.plannedAtMs,
        }),
      });
      return Object.freeze({
        status: admitted.status,
        plan,
        receipt: admitted.receipt,
      });
    },

    async cancel(request: CancelLocalPluginPackageWorkflowRequest) {
      const normalized = normalizeCancelRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.cancel',
        permission: 'run.stop',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      try {
        return await admissions.requestUserCancellation({
          projectId: normalized.projectId,
          packageName: normalized.packageName,
          runId: normalized.runId,
          mutationId: normalized.mutationId,
          runEventId: normalized.runEventId,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.cancel',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        });
      } catch (error) {
        if (error instanceof PluginPackageWorkflowCancellationNotFoundError) {
          throw new LocalPluginPackageWorkflowAdministrationNotFoundError();
        }
        throw error;
      }
    },

    async inspectRun(request: InspectLocalPluginPackageWorkflowRunRequest) {
      const normalized = normalizeInspectRunRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.run.read',
        permission: 'run.read',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      try {
        return await admissions.inspectRunAuthorized({
          projectId: normalized.projectId,
          packageName: normalized.packageName,
          workflowId: normalized.workflowId,
          runId: normalized.runId,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.run.read',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        });
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
    },

    async listRuns(request: ListLocalPluginPackageWorkflowRunsRequest) {
      const normalized = normalizeListRunsRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.run.list',
        permission: 'run.read',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      try {
        return await admissions.listRunsAuthorized({
          projectId: normalized.projectId,
          packageName: normalized.packageName,
          workflowId: normalized.workflowId,
          limit: normalized.limit,
          after: normalized.after,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.run.list',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        });
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
    },

    async listStepRuns(request: ListLocalPluginPackageWorkflowStepRunsRequest) {
      const normalized = normalizeListStepRunsRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.step.list',
        permission: 'run.read',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      try {
        return await admissions.listStepRunsAuthorized({
          projectId: normalized.projectId,
          packageName: normalized.packageName,
          workflowId: normalized.workflowId,
          runId: normalized.runId,
          limit: normalized.limit,
          after: normalized.after,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.step.list',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        });
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
    },

    async listRunEvents(
      request: ListLocalPluginPackageWorkflowRunEventsRequest,
    ) {
      const normalized = normalizeListRunEventsRequest(request);
      const nowMs = clock(now);
      const authorization = await authorize({
        eventId: normalized.auditEventId,
        requestId: normalized.requestId,
        projectId: normalized.projectId,
        operationId: 'workflow.event.list',
        permission: 'run.read',
        principal: normalized.principal,
        nowMs,
        auditAtMs: nowMs,
      });
      try {
        return await admissions.listRunEventsAuthorized({
          projectId: normalized.projectId,
          packageName: normalized.packageName,
          workflowId: normalized.workflowId,
          runId: normalized.runId,
          limit: normalized.limit,
          afterSequence: normalized.afterSequence,
          actor: authorization.principal.subject,
          fence: authorization.decision.fence as NonNullable<
            SecurityPolicyDecision['fence']
          >,
          audit: auditRecord({
            eventId: normalized.auditEventId,
            requestId: normalized.requestId,
            operationId: 'workflow.event.list',
            projectId: normalized.projectId,
            principal: authorization.principal,
            outcome: 'allowed',
            reasons: authorization.decision.reasons,
            fence: authorization.decision.fence,
            occurredAtMs: nowMs,
          }),
        });
      } catch {
        throw new LocalPluginPackageWorkflowAdministrationUnavailableError();
      }
    },
  });
}
