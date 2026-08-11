import { createHash } from 'node:crypto';
export type { LocalSecretEnvironmentProvider } from '../secret/localSecret';

export const LOCAL_PROCESS_EXECUTOR_TYPE = 'local_process';
export const MAX_LOCAL_DISPATCH_PAGE_SIZE = 64;
export const MAX_LOCAL_DISPATCH_ENVIRONMENT_ENTRIES = 256;
export const MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES = 64 * 1024;
export const MAX_LOCAL_DISPATCH_SECRET_REFS = 64;
export const MAX_LOCAL_DISPATCH_TIMEOUT_MS = 365 * 24 * 60 * 60_000;

const CONTEXT_REF_PATTERN = /^localctx:sha256:[a-f0-9]{64}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export type LocalDispatchCommand =
  | Readonly<{
      kind: 'argv';
      file: string;
      args: readonly string[];
    }>
  | Readonly<{
      kind: 'shell';
      command: string;
      shell?: '/bin/sh' | '/bin/bash';
    }>;

export interface LocalDispatchCandidateCursor {
  readonly priority: number;
  readonly queuedAtMs: number;
  readonly attemptCreatedAtMs: number;
  readonly attemptId: string;
}

export interface LocalDispatchCandidate extends LocalDispatchCandidateCursor {
  readonly runId: string;
  readonly stepRunId?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly attemptNumber: number;
  readonly executorType: typeof LOCAL_PROCESS_EXECUTOR_TYPE;
}

export interface LocalDispatchCandidatePage {
  readonly candidates: readonly LocalDispatchCandidate[];
  readonly truncated: boolean;
}

export interface LocalTaskExecutionRevisionContent {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly executorType: typeof LOCAL_PROCESS_EXECUTOR_TYPE;
  readonly command: LocalDispatchCommand;
  readonly workingDirectory?: string;
  readonly timeoutMs?: number;
  readonly contextRef: string;
  readonly createdAtMs: number;
}

export interface LocalTaskExecutionRevision
  extends LocalTaskExecutionRevisionContent {
  readonly contentDigest: string;
}

export type LocalExecutionEnvironmentBinding =
  | Readonly<{ name: string; kind: 'public'; value: string }>
  | Readonly<{ name: string; kind: 'secret'; secretRef: string }>;

export interface LocalExecutionContextRecipe {
  readonly contextRef: string;
  readonly environment: readonly LocalExecutionEnvironmentBinding[];
  readonly contentDigest: string;
  readonly createdAtMs: number;
}

export interface LocalDispatchCandidateSource {
  listLocalDispatchCandidates(options: {
    readonly limit: number;
    readonly after?: LocalDispatchCandidateCursor;
  }): Promise<LocalDispatchCandidatePage>;
}

export interface LocalTaskExecutionRevisionSource {
  resolveLocalTaskExecutionRevision(identity: {
    readonly projectId: string;
    readonly taskId: string;
    readonly taskRevision: string;
  }): Promise<LocalTaskExecutionRevision | null>;
}

export interface LocalExecutionContextRecipeSource {
  resolveLocalExecutionContextRecipe(
    contextRef: string,
  ): Promise<LocalExecutionContextRecipe | null>;
}

export interface LocalDispatchDefinitionWriter {
  appendLocalExecutionContextRecipe(
    recipe: LocalExecutionContextRecipe,
  ): Promise<'inserted' | 'existing'>;
  appendLocalTaskExecutionRevision(
    revision: LocalTaskExecutionRevision,
  ): Promise<'inserted' | 'existing'>;
}

export interface LocalDispatchStore
  extends LocalDispatchCandidateSource,
    LocalTaskExecutionRevisionSource,
    LocalExecutionContextRecipeSource,
    LocalDispatchDefinitionWriter {}

function assertBoundedText(
  value: unknown,
  field: string,
  maximumBytes: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  assertBoundedText(value, field, 255);
  if (/\r|\n|[\u0001-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertTimestamp(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} is invalid`);
  }
}

export function assertLocalDispatchContextRef(
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || !CONTEXT_REF_PATTERN.test(value)) {
    throw new TypeError('Local dispatch contextRef is invalid');
  }
}

export function normalizeLocalDispatchCommand(
  command: LocalDispatchCommand,
): LocalDispatchCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Local dispatch command is invalid');
  }
  if (command.kind === 'argv') {
    assertBoundedText(command.file, 'Local dispatch executable', 4096);
    if (!command.file.startsWith('/')) {
      throw new TypeError('Local dispatch executable must be absolute');
    }
    if (!Array.isArray(command.args) || command.args.length > 256) {
      throw new TypeError('Local dispatch arguments are invalid');
    }
    let bytes = Buffer.byteLength(command.file, 'utf8');
    const args = command.args.map((argument) => {
      if (
        typeof argument !== 'string' ||
        argument.includes('\0') ||
        Buffer.byteLength(argument, 'utf8') > 16 * 1024
      ) {
        throw new TypeError('Local dispatch argument is invalid');
      }
      bytes += Buffer.byteLength(argument, 'utf8');
      return argument;
    });
    if (bytes > 64 * 1024) {
      throw new RangeError('Local dispatch command exceeds its byte budget');
    }
    return Object.freeze({
      kind: 'argv' as const,
      file: command.file,
      args: Object.freeze(args),
    });
  }
  if (command.kind === 'shell') {
    assertBoundedText(
      command.command,
      'Local dispatch shell command',
      64 * 1024,
    );
    if (
      command.shell !== undefined &&
      command.shell !== '/bin/sh' &&
      command.shell !== '/bin/bash'
    ) {
      throw new TypeError('Local dispatch shell is not allowlisted');
    }
    return Object.freeze({
      kind: 'shell' as const,
      command: command.command,
      ...(command.shell === undefined ? {} : { shell: command.shell }),
    });
  }
  throw new TypeError('Local dispatch command kind is invalid');
}

export function normalizeLocalDispatchCandidate(
  candidate: LocalDispatchCandidate,
): LocalDispatchCandidate {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('Local dispatch candidate is invalid');
  }
  assertIdentifier(candidate.runId, 'Local dispatch runId');
  assertIdentifier(candidate.attemptId, 'Local dispatch attemptId');
  if (candidate.stepRunId !== undefined) {
    assertIdentifier(candidate.stepRunId, 'Local dispatch stepRunId');
  }
  assertIdentifier(candidate.projectId, 'Local dispatch projectId');
  assertIdentifier(candidate.taskId, 'Local dispatch taskId');
  assertIdentifier(candidate.taskRevision, 'Local dispatch taskRevision');
  if (!Number.isSafeInteger(candidate.priority)) {
    throw new TypeError('Local dispatch priority is invalid');
  }
  assertTimestamp(candidate.queuedAtMs, 'Local dispatch queuedAtMs');
  assertTimestamp(
    candidate.attemptCreatedAtMs,
    'Local dispatch attemptCreatedAtMs',
  );
  if (
    !Number.isSafeInteger(candidate.attemptNumber) ||
    candidate.attemptNumber < 1
  ) {
    throw new TypeError('Local dispatch attempt number is invalid');
  }
  if (candidate.executorType !== LOCAL_PROCESS_EXECUTOR_TYPE) {
    throw new TypeError('Local dispatch executor type is invalid');
  }
  return Object.freeze({ ...candidate });
}

export function assertLocalDispatchPageSize(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOCAL_DISPATCH_PAGE_SIZE
  ) {
    throw new RangeError(
      `Local dispatch page size must be between 1 and ${MAX_LOCAL_DISPATCH_PAGE_SIZE}`,
    );
  }
}

function normalizeLocalTaskExecutionRevisionContent(
  revision: LocalTaskExecutionRevisionContent,
): LocalTaskExecutionRevisionContent {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    throw new TypeError('Local Task execution revision is invalid');
  }
  assertIdentifier(revision.projectId, 'Local Task revision projectId');
  assertIdentifier(revision.taskId, 'Local Task revision taskId');
  assertIdentifier(revision.taskRevision, 'Local Task revision identity');
  if (revision.executorType !== LOCAL_PROCESS_EXECUTOR_TYPE) {
    throw new TypeError('Local Task revision executor type is invalid');
  }
  const command = normalizeLocalDispatchCommand(revision.command);
  if (revision.workingDirectory !== undefined) {
    assertBoundedText(
      revision.workingDirectory,
      'Local Task working directory',
      4096,
    );
    if (!revision.workingDirectory.startsWith('/')) {
      throw new TypeError('Local Task working directory must be absolute');
    }
  }
  if (
    revision.timeoutMs !== undefined &&
    (!Number.isSafeInteger(revision.timeoutMs) ||
      revision.timeoutMs < 1 ||
      revision.timeoutMs > MAX_LOCAL_DISPATCH_TIMEOUT_MS)
  ) {
    throw new RangeError('Local Task timeout is invalid');
  }
  assertLocalDispatchContextRef(revision.contextRef);
  assertTimestamp(revision.createdAtMs, 'Local Task revision createdAtMs');
  return Object.freeze({
    projectId: revision.projectId,
    taskId: revision.taskId,
    taskRevision: revision.taskRevision,
    executorType: LOCAL_PROCESS_EXECUTOR_TYPE,
    command,
    ...(revision.workingDirectory === undefined
      ? {}
      : { workingDirectory: revision.workingDirectory }),
    ...(revision.timeoutMs === undefined
      ? {}
      : { timeoutMs: revision.timeoutMs }),
    contextRef: revision.contextRef,
    createdAtMs: revision.createdAtMs,
  });
}

function localTaskExecutionRevisionDigestFromCanonical(
  revision: LocalTaskExecutionRevisionContent,
): string {
  const { createdAtMs: _createdAtMs, ...immutableContent } = revision;
  return createHash('sha256')
    .update('qinglong.local-task-execution-revision.v1\0', 'utf8')
    .update(JSON.stringify(immutableContent), 'utf8')
    .digest('hex');
}

export function localTaskExecutionRevisionDigest(
  revision: LocalTaskExecutionRevisionContent,
): string {
  return localTaskExecutionRevisionDigestFromCanonical(
    normalizeLocalTaskExecutionRevisionContent(revision),
  );
}

export function createLocalTaskExecutionRevision(
  revision: LocalTaskExecutionRevisionContent,
): LocalTaskExecutionRevision {
  const content = normalizeLocalTaskExecutionRevisionContent(revision);
  return Object.freeze({
    ...content,
    contentDigest: localTaskExecutionRevisionDigestFromCanonical(content),
  });
}

export function normalizeLocalTaskExecutionRevision(
  revision: LocalTaskExecutionRevision,
): LocalTaskExecutionRevision {
  const content = normalizeLocalTaskExecutionRevisionContent(revision);
  const contentDigest = localTaskExecutionRevisionDigestFromCanonical(content);
  if (
    typeof revision.contentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(revision.contentDigest) ||
    revision.contentDigest !== contentDigest
  ) {
    throw new TypeError(
      'Local Task execution revision digest does not match its content',
    );
  }
  return Object.freeze({ ...content, contentDigest });
}

function canonicalBindings(
  bindings: readonly LocalExecutionEnvironmentBinding[],
): readonly LocalExecutionEnvironmentBinding[] {
  if (
    !Array.isArray(bindings) ||
    bindings.length > MAX_LOCAL_DISPATCH_ENVIRONMENT_ENTRIES
  ) {
    throw new TypeError('Local context environment bindings are invalid');
  }
  const names = new Set<string>();
  let bytes = 0;
  const normalized = bindings.map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      throw new TypeError('Local context environment binding is invalid');
    }
    if (
      !ENVIRONMENT_NAME_PATTERN.test(binding.name) ||
      binding.name.startsWith('QL3_') ||
      names.has(binding.name)
    ) {
      throw new TypeError(
        'Local context environment name is invalid or duplicated',
      );
    }
    names.add(binding.name);
    bytes += Buffer.byteLength(binding.name, 'utf8');
    if (binding.kind === 'public') {
      if (typeof binding.value !== 'string' || binding.value.includes('\0')) {
        throw new TypeError('Local context public value is invalid');
      }
      bytes += Buffer.byteLength(binding.value, 'utf8');
      return Object.freeze({
        name: binding.name,
        kind: 'public' as const,
        value: binding.value,
      });
    }
    if (binding.kind === 'secret') {
      assertBoundedText(binding.secretRef, 'Local context secretRef', 512);
      bytes += Buffer.byteLength(binding.secretRef, 'utf8');
      return Object.freeze({
        name: binding.name,
        kind: 'secret' as const,
        secretRef: binding.secretRef,
      });
    }
    throw new TypeError('Local context environment binding kind is invalid');
  });
  if (bytes > MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES) {
    throw new RangeError('Local context environment exceeds its byte budget');
  }
  normalized.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(normalized);
}

function bindingsDigest(
  bindings: readonly LocalExecutionEnvironmentBinding[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(bindings), 'utf8')
    .digest('hex');
}

export function createLocalExecutionContextRecipe(input: {
  readonly environment: readonly LocalExecutionEnvironmentBinding[];
  readonly createdAtMs: number;
}): LocalExecutionContextRecipe {
  assertTimestamp(input.createdAtMs, 'Local context recipe createdAtMs');
  const environment = canonicalBindings(input.environment);
  const contentDigest = bindingsDigest(environment);
  return Object.freeze({
    contextRef: `localctx:sha256:${contentDigest}`,
    environment,
    contentDigest,
    createdAtMs: input.createdAtMs,
  });
}

export function normalizeLocalExecutionContextRecipe(
  recipe: LocalExecutionContextRecipe,
): LocalExecutionContextRecipe {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new TypeError('Local execution context recipe is invalid');
  }
  assertLocalDispatchContextRef(recipe.contextRef);
  assertTimestamp(recipe.createdAtMs, 'Local context recipe createdAtMs');
  const environment = canonicalBindings(recipe.environment);
  const contentDigest = bindingsDigest(environment);
  if (
    recipe.contentDigest !== contentDigest ||
    recipe.contextRef !== `localctx:sha256:${contentDigest}` ||
    JSON.stringify(recipe.environment) !== JSON.stringify(environment)
  ) {
    throw new TypeError('Local execution context recipe is not canonical');
  }
  return Object.freeze({
    contextRef: recipe.contextRef,
    environment,
    contentDigest,
    createdAtMs: recipe.createdAtMs,
  });
}
