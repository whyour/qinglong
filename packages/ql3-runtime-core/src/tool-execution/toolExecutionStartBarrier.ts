import { createHash } from 'node:crypto';

import {
  normalizeProjectPolicySubject,
} from '../security/project-policy/projectPolicy';
import type { SecuritySubject } from '../security/security';
import {
  normalizeStepRunMutation,
  type StepRunMutation,
} from '../run/stepRun';
import {
  normalizeToolExecutionEvidenceBundle,
  type ToolExecutionEvidenceBundle,
} from './toolExecutionEvidence';
import {
  normalizeToolInvocationInputArtifactReference,
  normalizeToolInvocationPreviewArtifactReference,
  type ToolInvocationInputArtifactReference,
  type ToolInvocationPreviewArtifactReference,
} from './toolInvocationArtifact';
import {
  TRUSTED_TOOL_DEPLOYMENT_PROFILES,
  TRUSTED_TOOL_EXECUTION_CLASSES,
  normalizeTrustedToolExecutionAdmission,
  trustedToolContractIdentityDigest,
  type TrustedToolContractIdentity,
  type TrustedToolExecutionAdmission,
  type TrustedToolExecutionClass,
} from './trustedToolInvocation';
import type { DeploymentProfile } from '../cluster-control/clusterControlActivation';
import type { SecurityPolicyFence } from '../security/security';

export const TOOL_EXECUTION_START_COMMAND_SCHEMA =
  'qinglong/tool-execution-start-command@v1' as const;
export const TOOL_EXECUTION_START_BARRIER_SCHEMA =
  'qinglong/tool-execution-start-barrier@v1' as const;
export const MAX_TOOL_EXECUTION_START_COMMAND_BYTES = 64 * 1024;
export const MAX_TOOL_EXECUTION_START_BARRIER_BYTES = 16 * 1024;

export interface CreateToolExecutionStartCommandInput {
  readonly startId: string;
  readonly admission: TrustedToolExecutionAdmission;
  readonly evidence: ToolExecutionEvidenceBundle;
  readonly stepRunMutation: StepRunMutation;
}

export interface ToolExecutionStartCommand {
  readonly schema: typeof TOOL_EXECUTION_START_COMMAND_SCHEMA;
  readonly startId: string;
  readonly admission: Readonly<TrustedToolExecutionAdmission>;
  readonly evidence: Readonly<ToolExecutionEvidenceBundle>;
  readonly stepRunMutation: Readonly<StepRunMutation>;
  readonly commandDigest: string;
}

export interface ToolExecutionStartBarrierRecord {
  readonly schema: typeof TOOL_EXECUTION_START_BARRIER_SCHEMA;
  readonly startId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly actionRef: string;
  readonly planDigest: string;
  readonly actionDigest: string;
  readonly snapshotDigest: string;
  readonly definitionDigest: string;
  readonly bindingDigest: string;
  readonly admissionDigest: string;
  readonly invocationArtifact: Readonly<ToolInvocationInputArtifactReference>;
  readonly previewArtifact: Readonly<ToolInvocationPreviewArtifactReference>;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly profile: DeploymentProfile;
  readonly adapter: Readonly<TrustedToolContractIdentity>;
  readonly adapterDigest: string;
  readonly redactionContract: Readonly<TrustedToolContractIdentity>;
  readonly redactionContractDigest: string;
  readonly auditContract: Readonly<TrustedToolContractIdentity>;
  readonly auditContractDigest: string;
  readonly executionClass: TrustedToolExecutionClass;
  readonly timeoutSeconds: number;
  readonly policyFence: Readonly<SecurityPolicyFence>;
  readonly approvalRequestId: string | null;
  readonly approvalDispatchId: string | null;
  readonly approvalDispatchDigest: string | null;
  readonly previousStepRunVersion: number;
  readonly previousStepRunDigest: string;
  readonly startedStepRunVersion: number;
  readonly startedStepRunDigest: string;
  readonly stepRunMutationId: string;
  readonly stepRunMutationDigest: string;
  readonly runEventId: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceDigest: string;
  readonly auditEventId: string;
  readonly auditReceiptDigest: string;
  readonly startedAtMs: number;
  readonly commandDigest: string;
  readonly barrierDigest: string;
}

export interface PrepareToolExecutionStartResult {
  readonly status: 'created' | 'existing';
  readonly barrier: Readonly<ToolExecutionStartBarrierRecord>;
}

export interface ToolExecutionStartBarrierRepository {
  findByStartId(
    startId: string,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null>;
  findByStepRun(
    runId: string,
    stepRunId: string,
    startedStepRunVersion: number,
  ): Promise<Readonly<ToolExecutionStartBarrierRecord> | null>;
  prepare(
    command: ToolExecutionStartCommand,
  ): Promise<Readonly<PrepareToolExecutionStartResult>>;
}

export class InvalidToolExecutionStartBarrierError extends TypeError {
  readonly code = 'TOOL_EXECUTION_START_BARRIER_INVALID';

  constructor(message: string) {
    super(`Tool execution start barrier is invalid: ${message}`);
    this.name = 'InvalidToolExecutionStartBarrierError';
  }
}

export class ToolExecutionStartBarrierConflictError extends Error {
  readonly code = 'TOOL_EXECUTION_START_BARRIER_CONFLICT';

  constructor() {
    super('Tool execution start identity is bound to different content');
    this.name = 'ToolExecutionStartBarrierConflictError';
  }
}

export class ToolExecutionStartBarrierUnavailableError extends Error {
  readonly code = 'TOOL_EXECUTION_START_BARRIER_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Tool execution start barrier repository is unavailable', options);
    this.name = 'ToolExecutionStartBarrierUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMAND_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-start-command-digest@v1\0',
  'utf8',
);
const BARRIER_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-start-barrier-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidToolExecutionStartBarrierError(message);
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    return invalid(`${label} must contain enumerable data properties`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(required);
  if (
    keys.length !== required.length ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function hash(domain: Buffer, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function actionRef(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_REF_PATTERN.test(value)) {
    return invalid('action reference is invalid');
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function traceIdentity(
  value: unknown,
  pattern: RegExp,
  label: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function sameFence(
  left: Readonly<SecurityPolicyFence>,
  right: Readonly<SecurityPolicyFence>,
): boolean {
  return (
    left.projectVersion === right.projectVersion &&
    left.bindingVersion === right.bindingVersion
  );
}

function normalizeFence(
  value: SecurityPolicyFence,
): Readonly<SecurityPolicyFence> {
  const record = dataRecord(value, 'policy fence');
  exactKeys(record, ['bindingVersion', 'projectVersion'], 'policy fence');
  if (
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    (value.bindingVersion !== null &&
      (!Number.isSafeInteger(value.bindingVersion) ||
        value.bindingVersion < 1))
  ) {
    return invalid('policy fence is invalid');
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

function normalizeContractIdentity(
  value: TrustedToolContractIdentity,
  label: string,
): Readonly<TrustedToolContractIdentity> {
  try {
    trustedToolContractIdentityDigest(value);
  } catch {
    return invalid(`${label} is invalid`);
  }
  return Object.freeze({ id: value.id, version: value.version });
}

function commandUnsigned(
  value: Readonly<ToolExecutionStartCommand>,
): Omit<ToolExecutionStartCommand, 'commandDigest'> {
  return Object.freeze({
    schema: value.schema,
    startId: value.startId,
    admission: value.admission,
    evidence: value.evidence,
    stepRunMutation: value.stepRunMutation,
  });
}

function validateCommandBindings(
  admission: Readonly<TrustedToolExecutionAdmission>,
  evidence: Readonly<ToolExecutionEvidenceBundle>,
  mutation: Readonly<StepRunMutation>,
): void {
  const trace = evidence.trace;
  const audit = evidence.audit;
  const receipt = evidence.receipt;
  const stepRun = mutation.stepRun;
  const expectedDefinitionRef =
    `tool:${admission.tool.name}@${admission.tool.version}`;
  if (
    admission.projectId !== trace.projectId ||
    admission.planDigest !== trace.invocationPlanDigest ||
    admission.bindingDigest !== trace.bindingDigest ||
    trustedToolContractIdentityDigest(admission.adapter) !==
      trace.adapterDigest ||
    trustedToolContractIdentityDigest(admission.redactionContract) !==
      trace.redactionContractDigest ||
    trustedToolContractIdentityDigest(admission.auditContract) !==
      trace.auditContractDigest ||
    admission.evidence.trace.traceId !== trace.traceId ||
    admission.evidence.trace.spanId !== trace.spanId ||
    admission.evidence.trace.digest !== trace.traceDigest ||
    admission.evidence.audit.eventId !== receipt.eventId ||
    admission.evidence.audit.digest !== receipt.receiptDigest ||
    admission.evidence.stepRun.id !== stepRun.id ||
    admission.evidence.stepRun.version !==
      mutation.expectedStepRunVersion ||
    admission.evidence.stepRun.digest !==
      mutation.expectedStepRunDigest ||
    admission.requestedBy.type !== audit.subject?.type ||
    admission.requestedBy.id !== audit.subject?.id ||
    audit.fence === null ||
    !sameFence(admission.policyFence, audit.fence) ||
    audit.occurredAtMs !== admission.admittedAtMs ||
    trace.createdAtMs !== admission.admittedAtMs ||
    mutation.runId !== trace.runId ||
    stepRun.runId !== trace.runId ||
    stepRun.id !== trace.stepRunId ||
    stepRun.kind !== 'tool' ||
    stepRun.definitionRef !== expectedDefinitionRef ||
    stepRun.definitionDigest !== admission.definitionDigest ||
    (mutation.previousStatus !== 'ready' &&
      mutation.previousStatus !== 'waiting_approval') ||
    mutation.expectedStepRunVersion === null ||
    mutation.expectedStepRunDigest === null ||
    stepRun.status !== 'running' ||
    stepRun.startedAtMs !== admission.admittedAtMs ||
    stepRun.updatedAtMs !== admission.admittedAtMs ||
    mutation.event.createdAtMs !== admission.admittedAtMs ||
    mutation.event.type !== 'step.running' ||
    (admission.approvalRequestId === null) !==
      (admission.approvalDispatchId === null) ||
    (admission.approvalDispatchId === null) !==
      (mutation.previousStatus === 'ready') ||
    (admission.approvalRequestId === null
      ? stepRun.approvalRequestId !== null
      : stepRun.approvalRequestId !== admission.approvalRequestId)
  ) {
    return invalid('start command bindings are inconsistent');
  }
}

export function normalizeToolExecutionStartCommand(
  value: ToolExecutionStartCommand,
): Readonly<ToolExecutionStartCommand> {
  const record = dataRecord(value, 'start command');
  exactKeys(
    record,
    [
      'admission',
      'commandDigest',
      'evidence',
      'schema',
      'startId',
      'stepRunMutation',
    ],
    'start command',
  );
  if (value.schema !== TOOL_EXECUTION_START_COMMAND_SCHEMA) {
    return invalid('start command schema is invalid');
  }
  let admission: Readonly<TrustedToolExecutionAdmission>;
  let evidence: Readonly<ToolExecutionEvidenceBundle>;
  let stepRunMutation: Readonly<StepRunMutation>;
  try {
    admission = normalizeTrustedToolExecutionAdmission(value.admission);
    evidence = normalizeToolExecutionEvidenceBundle(value.evidence);
    stepRunMutation = normalizeStepRunMutation(value.stepRunMutation);
  } catch {
    return invalid('start command contains invalid durable facts');
  }
  const normalized = Object.freeze({
    schema: TOOL_EXECUTION_START_COMMAND_SCHEMA,
    startId: identifier(value.startId, 'start id'),
    admission,
    evidence,
    stepRunMutation,
    commandDigest: digest(value.commandDigest, 'command digest'),
  });
  validateCommandBindings(admission, evidence, stepRunMutation);
  if (
    hash(COMMAND_DIGEST_DOMAIN, commandUnsigned(normalized)) !==
      normalized.commandDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_TOOL_EXECUTION_START_COMMAND_BYTES
  ) {
    return invalid('start command digest or size is invalid');
  }
  return normalized;
}

export function createToolExecutionStartCommand(
  inputValue: CreateToolExecutionStartCommandInput,
): Readonly<ToolExecutionStartCommand> {
  const input = dataRecord(inputValue, 'create start command input');
  exactKeys(
    input,
    ['admission', 'evidence', 'startId', 'stepRunMutation'],
    'create start command input',
  );
  let admission: Readonly<TrustedToolExecutionAdmission>;
  let evidence: Readonly<ToolExecutionEvidenceBundle>;
  let stepRunMutation: Readonly<StepRunMutation>;
  try {
    admission = normalizeTrustedToolExecutionAdmission(inputValue.admission);
    evidence = normalizeToolExecutionEvidenceBundle(inputValue.evidence);
    stepRunMutation = normalizeStepRunMutation(inputValue.stepRunMutation);
  } catch {
    return invalid('create start command input contains invalid facts');
  }
  validateCommandBindings(admission, evidence, stepRunMutation);
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_START_COMMAND_SCHEMA,
    startId: identifier(inputValue.startId, 'start id'),
    admission,
    evidence,
    stepRunMutation,
  });
  return normalizeToolExecutionStartCommand({
    ...unsigned,
    commandDigest: hash(COMMAND_DIGEST_DOMAIN, unsigned),
  });
}

function barrierUnsigned(
  value: Readonly<ToolExecutionStartBarrierRecord>,
): Omit<ToolExecutionStartBarrierRecord, 'barrierDigest'> {
  const { barrierDigest: _barrierDigest, ...unsigned } = value;
  return Object.freeze(unsigned);
}

export function toolExecutionStartBarrierRecord(
  commandValue: ToolExecutionStartCommand,
): Readonly<ToolExecutionStartBarrierRecord> {
  const command = normalizeToolExecutionStartCommand(commandValue);
  const admission = command.admission;
  const evidence = command.evidence;
  const mutation = command.stepRunMutation;
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_START_BARRIER_SCHEMA,
    startId: command.startId,
    projectId: admission.projectId,
    runId: mutation.runId,
    stepRunId: mutation.stepRun.id,
    actionRef: admission.actionRef,
    planDigest: admission.planDigest,
    actionDigest: admission.actionDigest,
    snapshotDigest: admission.snapshotDigest,
    definitionDigest: admission.definitionDigest,
    bindingDigest: admission.bindingDigest,
    admissionDigest: admission.admissionDigest,
    invocationArtifact: admission.invocationArtifact,
    previewArtifact: admission.previewArtifact,
    requestedBy: admission.requestedBy,
    profile: admission.profile,
    adapter: admission.adapter,
    adapterDigest: evidence.trace.adapterDigest,
    redactionContract: admission.redactionContract,
    redactionContractDigest: evidence.trace.redactionContractDigest,
    auditContract: admission.auditContract,
    auditContractDigest: evidence.trace.auditContractDigest,
    executionClass: admission.executionClass,
    timeoutSeconds: admission.timeoutSeconds,
    policyFence: admission.policyFence,
    approvalRequestId: admission.approvalRequestId,
    approvalDispatchId: admission.approvalDispatchId,
    approvalDispatchDigest: admission.approvalDispatchDigest,
    previousStepRunVersion: mutation.expectedStepRunVersion!,
    previousStepRunDigest: mutation.expectedStepRunDigest!,
    startedStepRunVersion: mutation.stepRun.version,
    startedStepRunDigest: mutation.stepRun.stepRunDigest,
    stepRunMutationId: mutation.mutationId,
    stepRunMutationDigest: mutation.mutationDigest,
    runEventId: mutation.event.id,
    traceId: evidence.trace.traceId,
    spanId: evidence.trace.spanId,
    traceDigest: evidence.trace.traceDigest,
    auditEventId: evidence.audit.eventId,
    auditReceiptDigest: evidence.receipt.receiptDigest,
    startedAtMs: admission.admittedAtMs,
    commandDigest: command.commandDigest,
  } satisfies Omit<ToolExecutionStartBarrierRecord, 'barrierDigest'>);
  return normalizeToolExecutionStartBarrierRecord({
    ...unsigned,
    barrierDigest: hash(BARRIER_DIGEST_DOMAIN, unsigned),
  });
}

export function normalizeToolExecutionStartBarrierRecord(
  value: ToolExecutionStartBarrierRecord,
): Readonly<ToolExecutionStartBarrierRecord> {
  const record = dataRecord(value, 'start barrier');
  exactKeys(
    record,
    [
      'actionDigest',
      'actionRef',
      'adapter',
      'adapterDigest',
      'admissionDigest',
      'approvalDispatchDigest',
      'approvalDispatchId',
      'approvalRequestId',
      'auditContract',
      'auditContractDigest',
      'auditEventId',
      'auditReceiptDigest',
      'barrierDigest',
      'bindingDigest',
      'commandDigest',
      'definitionDigest',
      'executionClass',
      'invocationArtifact',
      'planDigest',
      'policyFence',
      'previousStepRunDigest',
      'previousStepRunVersion',
      'profile',
      'projectId',
      'previewArtifact',
      'redactionContract',
      'redactionContractDigest',
      'requestedBy',
      'runEventId',
      'runId',
      'schema',
      'snapshotDigest',
      'spanId',
      'startId',
      'startedAtMs',
      'startedStepRunDigest',
      'startedStepRunVersion',
      'stepRunId',
      'stepRunMutationDigest',
      'stepRunMutationId',
      'timeoutSeconds',
      'traceDigest',
      'traceId',
    ],
    'start barrier',
  );
  if (value.schema !== TOOL_EXECUTION_START_BARRIER_SCHEMA) {
    return invalid('start barrier schema is invalid');
  }
  const approvalRequestId =
    value.approvalRequestId === null
      ? null
      : identifier(value.approvalRequestId, 'approval request id');
  const approvalDispatchId =
    value.approvalDispatchId === null
      ? null
      : identifier(value.approvalDispatchId, 'approval dispatch id');
  const approvalDispatchDigest =
    value.approvalDispatchDigest === null
      ? null
      : digest(value.approvalDispatchDigest, 'approval dispatch digest');
  if (
    (approvalRequestId === null) !== (approvalDispatchId === null) ||
    (approvalDispatchId === null) !== (approvalDispatchDigest === null)
  ) {
    return invalid('start barrier approval binding is incomplete');
  }
  if (!TRUSTED_TOOL_DEPLOYMENT_PROFILES.includes(value.profile)) {
    return invalid('start barrier profile is invalid');
  }
  if (!TRUSTED_TOOL_EXECUTION_CLASSES.includes(value.executionClass)) {
    return invalid('start barrier execution class is invalid');
  }
  let requestedBy: Readonly<SecuritySubject>;
  try {
    requestedBy = normalizeProjectPolicySubject(value.requestedBy);
  } catch {
    return invalid('start barrier subject is invalid');
  }
  const normalized = Object.freeze({
    schema: TOOL_EXECUTION_START_BARRIER_SCHEMA,
    startId: identifier(value.startId, 'start id'),
    projectId: identifier(value.projectId, 'project id'),
    runId: identifier(value.runId, 'Run id'),
    stepRunId: identifier(value.stepRunId, 'StepRun id'),
    actionRef: actionRef(value.actionRef),
    planDigest: digest(value.planDigest, 'plan digest'),
    actionDigest: digest(value.actionDigest, 'action digest'),
    snapshotDigest: digest(value.snapshotDigest, 'snapshot digest'),
    definitionDigest: digest(value.definitionDigest, 'definition digest'),
    bindingDigest: digest(value.bindingDigest, 'binding digest'),
    admissionDigest: digest(value.admissionDigest, 'admission digest'),
    invocationArtifact: normalizeToolInvocationInputArtifactReference(
      value.invocationArtifact,
    ),
    previewArtifact: normalizeToolInvocationPreviewArtifactReference(
      value.previewArtifact,
    ),
    requestedBy,
    profile: value.profile,
    adapter: normalizeContractIdentity(value.adapter, 'adapter identity'),
    adapterDigest: digest(value.adapterDigest, 'adapter digest'),
    redactionContract: normalizeContractIdentity(
      value.redactionContract,
      'redaction contract identity',
    ),
    redactionContractDigest: digest(
      value.redactionContractDigest,
      'redaction contract digest',
    ),
    auditContract: normalizeContractIdentity(
      value.auditContract,
      'audit contract identity',
    ),
    auditContractDigest: digest(
      value.auditContractDigest,
      'audit contract digest',
    ),
    executionClass: value.executionClass,
    timeoutSeconds: integer(
      value.timeoutSeconds,
      1,
      60 * 60,
      'timeout',
    ),
    policyFence: normalizeFence(value.policyFence),
    approvalRequestId,
    approvalDispatchId,
    approvalDispatchDigest,
    previousStepRunVersion: integer(
      value.previousStepRunVersion,
      1,
      2_147_483_646,
      'previous StepRun version',
    ),
    previousStepRunDigest: digest(
      value.previousStepRunDigest,
      'previous StepRun digest',
    ),
    startedStepRunVersion: integer(
      value.startedStepRunVersion,
      2,
      2_147_483_647,
      'started StepRun version',
    ),
    startedStepRunDigest: digest(
      value.startedStepRunDigest,
      'started StepRun digest',
    ),
    stepRunMutationId: identifier(
      value.stepRunMutationId,
      'StepRun mutation id',
    ),
    stepRunMutationDigest: digest(
      value.stepRunMutationDigest,
      'StepRun mutation digest',
    ),
    runEventId: identifier(value.runEventId, 'Run event id'),
    traceId: traceIdentity(value.traceId, TRACE_ID_PATTERN, 'trace id'),
    spanId: traceIdentity(value.spanId, SPAN_ID_PATTERN, 'span id'),
    traceDigest: digest(value.traceDigest, 'trace digest'),
    auditEventId: traceIdentity(
      value.auditEventId,
      UUID_V4_PATTERN,
      'audit event id',
    ),
    auditReceiptDigest: digest(
      value.auditReceiptDigest,
      'audit receipt digest',
    ),
    startedAtMs: integer(
      value.startedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'start time',
    ),
    commandDigest: digest(value.commandDigest, 'command digest'),
    barrierDigest: digest(value.barrierDigest, 'barrier digest'),
  });
  if (
    trustedToolContractIdentityDigest(normalized.adapter) !==
      normalized.adapterDigest ||
    trustedToolContractIdentityDigest(normalized.redactionContract) !==
      normalized.redactionContractDigest ||
    trustedToolContractIdentityDigest(normalized.auditContract) !==
      normalized.auditContractDigest ||
    normalized.previewArtifact.actionDigest !== normalized.actionDigest ||
    normalized.previewArtifact.redactionContractDigest !==
      normalized.redactionContractDigest ||
    normalized.startedStepRunVersion !==
      normalized.previousStepRunVersion + 1 ||
    hash(BARRIER_DIGEST_DOMAIN, barrierUnsigned(normalized)) !==
      normalized.barrierDigest ||
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
      MAX_TOOL_EXECUTION_START_BARRIER_BYTES
  ) {
    return invalid('start barrier digest, version or size is invalid');
  }
  return normalized;
}
