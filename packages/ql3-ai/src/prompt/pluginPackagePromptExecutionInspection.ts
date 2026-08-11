import { RUN_STATUSES, type RunStatus } from '@qinglong/runtime-core';
import { normalizeProjectPolicySubject } from '@qinglong/runtime-core/project-policy';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  STEP_RUN_STATUSES,
  type StepRunStatus,
} from '@qinglong/runtime-core/step-run';

import { PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES } from './pluginPackagePromptExecution';

export const PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA =
  'qinglong/plugin-package-prompt-execution-inspection@v1' as const;

export interface AuthorizedPluginPackagePromptExecutionInspection {
  readonly projectId: string;
  readonly packageName: string;
  readonly promptId: string;
  readonly executionRequestId: string;
  readonly actor: Readonly<SecuritySubject>;
  readonly fence: Readonly<SecurityPolicyFence>;
  readonly audit: Readonly<SecurityAuditRecord>;
}

export interface PluginPackagePromptExecutionInspection {
  readonly invocationId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly runStatus:
    | Extract<RunStatus, 'running'>
    | (typeof PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES)[number];
  readonly runVersion: number;
  readonly eventSequence: number;
  readonly stepStatus: StepRunStatus;
  readonly stepVersion: number;
  readonly admittedAtMs: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly finalizedAtMs: number | null;
}

export interface PluginPackagePromptExecutionInspectionResult {
  readonly schema: typeof PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA;
  readonly found: boolean;
  readonly projectId: string;
  readonly packageName: string;
  readonly promptId: string;
  readonly executionRequestId: string;
  readonly execution: Readonly<PluginPackagePromptExecutionInspection> | null;
}

export interface PluginPackagePromptExecutionInspectionRepository {
  inspectAuthorized(
    inspection: AuthorizedPluginPackagePromptExecutionInspection,
  ): Promise<Readonly<PluginPackagePromptExecutionInspectionResult>>;
}

export class InvalidPluginPackagePromptExecutionInspectionError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_INVALID';

  constructor() {
    super('Plugin Package Prompt execution inspection is invalid');
    this.name = 'InvalidPluginPackagePromptExecutionInspectionError';
  }
}

export class PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError extends Error {
  readonly code =
    'PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_AUTHORIZATION_FENCE_CONFLICT';

  constructor() {
    super('Plugin Package Prompt execution inspection authorization changed');
    this.name =
      'PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError';
  }
}

export class PluginPackagePromptExecutionInspectionUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Prompt execution inspection is unavailable', options);
    this.name = 'PluginPackagePromptExecutionInspectionUnavailableError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INSPECTABLE_RUN_STATUSES = Object.freeze([
  'running',
  ...PLUGIN_PACKAGE_PROMPT_FINAL_RUN_STATUSES,
] as const);

function invalid(): never {
  throw new InvalidPluginPackagePromptExecutionInspectionError();
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function identity(value: unknown, pattern: RegExp = IDENTITY): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value);
}

function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function normalizeAuthorizedPluginPackagePromptExecutionInspection(
  value: AuthorizedPluginPackagePromptExecutionInspection,
): Readonly<AuthorizedPluginPackagePromptExecutionInspection> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'actor',
      'audit',
      'executionRequestId',
      'fence',
      'packageName',
      'projectId',
      'promptId',
    ])
  ) {
    return invalid();
  }
  try {
    const projectId = identity(value.projectId);
    const packageName = identity(value.packageName, PACKAGE_NAME);
    const promptId = identity(value.promptId);
    const executionRequestId = identity(value.executionRequestId);
    const actor = normalizeProjectPolicySubject(value.actor);
    const fence = value.fence;
    if (
      !fence ||
      typeof fence !== 'object' ||
      Array.isArray(fence) ||
      !exactKeys(fence, ['bindingVersion', 'projectVersion']) ||
      !Number.isSafeInteger(fence.projectVersion) ||
      fence.projectVersion < 1 ||
      !Number.isSafeInteger(fence.bindingVersion) ||
      (fence.bindingVersion as number) < 1
    ) {
      return invalid();
    }
    const audit = normalizeSecurityAuditRecord(value.audit);
    if (
      audit.operationId !== 'prompt.execution.read' ||
      audit.projectId !== projectId ||
      audit.outcome !== 'allowed' ||
      !audit.subject ||
      !sameSubject(audit.subject, actor) ||
      audit.authenticationId === null ||
      !audit.fence ||
      audit.fence.projectVersion !== fence.projectVersion ||
      audit.fence.bindingVersion !== fence.bindingVersion
    ) {
      return invalid();
    }
    return Object.freeze({
      projectId,
      packageName,
      promptId,
      executionRequestId,
      actor,
      fence: Object.freeze({
        projectVersion: fence.projectVersion,
        bindingVersion: fence.bindingVersion as number,
      }),
      audit,
    });
  } catch {
    return invalid();
  }
}

export function normalizePluginPackagePromptExecutionInspectionResult(
  value: PluginPackagePromptExecutionInspectionResult,
): Readonly<PluginPackagePromptExecutionInspectionResult> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'execution',
      'executionRequestId',
      'found',
      'packageName',
      'projectId',
      'promptId',
      'schema',
    ]) ||
    value.schema !== PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA ||
    typeof value.found !== 'boolean'
  ) {
    return invalid();
  }
  const projectId = identity(value.projectId);
  const packageName = identity(value.packageName, PACKAGE_NAME);
  const promptId = identity(value.promptId);
  const executionRequestId = identity(value.executionRequestId);
  if (!value.found) {
    if (value.execution !== null) return invalid();
    return Object.freeze({
      schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
      found: false,
      projectId,
      packageName,
      promptId,
      executionRequestId,
      execution: null,
    });
  }
  const execution = value.execution;
  if (
    !execution ||
    typeof execution !== 'object' ||
    Array.isArray(execution) ||
    !exactKeys(execution, [
      'admittedAtMs',
      'eventSequence',
      'finalizedAtMs',
      'finishedAtMs',
      'invocationId',
      'runId',
      'runStatus',
      'runVersion',
      'startedAtMs',
      'stepRunId',
      'stepStatus',
      'stepVersion',
    ]) ||
    !RUN_STATUSES.includes(execution.runStatus) ||
    !INSPECTABLE_RUN_STATUSES.includes(
      execution.runStatus as (typeof INSPECTABLE_RUN_STATUSES)[number],
    ) ||
    !STEP_RUN_STATUSES.includes(execution.stepStatus)
  ) {
    return invalid();
  }
  const admittedAtMs = nonNegativeInteger(execution.admittedAtMs);
  const startedAtMs = nonNegativeInteger(execution.startedAtMs);
  const finishedAtMs = nullableTimestamp(execution.finishedAtMs);
  const finalizedAtMs = nullableTimestamp(execution.finalizedAtMs);
  const terminal = execution.runStatus !== 'running';
  if (
    admittedAtMs !== startedAtMs ||
    terminal !== (finishedAtMs !== null) ||
    terminal !== (finalizedAtMs !== null) ||
    (terminal && finishedAtMs !== finalizedAtMs) ||
    (terminal && execution.stepStatus !== execution.runStatus)
  ) {
    return invalid();
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_SCHEMA,
    found: true,
    projectId,
    packageName,
    promptId,
    executionRequestId,
    execution: Object.freeze({
      invocationId: identity(execution.invocationId),
      runId: identity(execution.runId, RUN_ID),
      stepRunId: identity(execution.stepRunId),
      runStatus: execution.runStatus,
      runVersion: positiveInteger(execution.runVersion),
      eventSequence: nonNegativeInteger(execution.eventSequence),
      stepStatus: execution.stepStatus,
      stepVersion: positiveInteger(execution.stepVersion),
      admittedAtMs,
      startedAtMs,
      finishedAtMs,
      finalizedAtMs,
    }),
  });
}
