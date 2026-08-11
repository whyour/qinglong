import { createHash } from 'node:crypto';

import {
  TOOL_EXECUTION_START_BARRIER_SCHEMA,
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRepository,
} from './toolExecutionStartBarrier';
import {
  TOOL_INVOCATION_SCHEMA,
  type ToolJsonValue,
} from './tool-registry/toolRegistry';
import {
  normalizeToolInvocationInputArtifact,
  openToolInvocationInputArtifact,
  toolInvocationInputArtifactReference,
  type ToolInvocationArtifactKeyProvider,
  type ToolInvocationArtifactRepository,
} from './toolInvocationArtifact';
import {
  TrustedToolHandlerBindingRegistry,
  normalizeTrustedToolHandlerBinding,
  trustedToolContractIdentityDigest,
  type TrustedToolHandlerBinding,
} from './trustedToolInvocation';
import type { DeploymentProfile } from '../cluster-control/clusterControlActivation';
import type { SecuritySubject } from '../security/security';

export const TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA =
  'qinglong/trusted-tool-execution-result@v1' as const;
export const TRUSTED_TOOL_EXECUTION_RECOVERY_EVIDENCE_SCHEMA =
  'qinglong/trusted-tool-execution-recovery-evidence@v1' as const;
export const MAX_TRUSTED_TOOL_EXECUTION_ADAPTERS = 128;

export interface TrustedToolExecutionAdapterContext {
  readonly startId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stepRunId: string;
  readonly actionRef: string;
  readonly requestedBy: Readonly<SecuritySubject>;
  readonly profile: DeploymentProfile;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
}

/**
 * An executable adapter is supplied only by a trusted Profile composition
 * root. Its immutable binding is Project/snapshot-specific; Package content,
 * invocation input and persisted plans cannot register executable code.
 */
export interface TrustedToolExecutionAdapter {
  readonly binding: Readonly<TrustedToolHandlerBinding>;
  readonly profile: DeploymentProfile;
  readonly recoveryMode: 'retry_safe_read';
  execute(
    context: Readonly<TrustedToolExecutionAdapterContext>,
    input: ToolJsonValue,
  ): Promise<unknown>;
}

export interface TrustedToolExecutionDependencies {
  readonly barriers: Pick<ToolExecutionStartBarrierRepository, 'findByStartId'>;
  readonly artifacts: Pick<ToolInvocationArtifactRepository, 'findInput'>;
  readonly keys: Pick<ToolInvocationArtifactKeyProvider, 'resolve'>;
  readonly adapters: TrustedToolExecutionAdapterRegistry;
  readonly now?: () => number;
}

export interface TrustedToolExecutionResult {
  readonly schema: typeof TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA;
  readonly startId: string;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly output: ToolJsonValue;
  readonly outputDigest: string;
  readonly completedAtMs: number;
  readonly resultDigest: string;
}

export interface TrustedToolExecutionRecoveryEvidence {
  readonly schema: typeof TRUSTED_TOOL_EXECUTION_RECOVERY_EVIDENCE_SCHEMA;
  readonly startId: string;
  readonly barrierDigest: string;
  readonly adapterDigest: string;
  readonly disposition: 'retry_safe';
  readonly reason: 'read_only_no_side_effects';
  readonly inspectedAtMs: number;
  readonly evidenceDigest: string;
}

export class InvalidTrustedToolExecutionError extends TypeError {
  readonly code = 'TRUSTED_TOOL_EXECUTION_INVALID';

  constructor(message: string) {
    super(`Trusted Tool execution is invalid: ${message}`);
    this.name = 'InvalidTrustedToolExecutionError';
  }
}

export class TrustedToolExecutionUnavailableError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_UNAVAILABLE';

  constructor() {
    super('Trusted Tool execution prerequisites are unavailable');
    this.name = 'TrustedToolExecutionUnavailableError';
  }
}

export class TrustedToolExecutionBindingConflictError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_BINDING_CONFLICT';

  constructor() {
    super('Trusted Tool execution binding changed after durable start');
    this.name = 'TrustedToolExecutionBindingConflictError';
  }
}

export class TrustedToolExecutionDeadlineExceededError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_DEADLINE_EXCEEDED';

  constructor() {
    super('Trusted Tool execution deadline was exceeded');
    this.name = 'TrustedToolExecutionDeadlineExceededError';
  }
}

export class TrustedToolExecutionFailedError extends Error {
  readonly code = 'TRUSTED_TOOL_EXECUTION_FAILED';

  constructor() {
    super('Trusted Tool adapter execution failed');
    this.name = 'TrustedToolExecutionFailedError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const RECOVERY_EVIDENCE_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-recovery-evidence-digest@v1\0',
  'utf8',
);

function invalid(message: string): never {
  throw new InvalidTrustedToolExecutionError(message);
}

function hash(domain: Uint8Array, value: unknown): string {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function now(clock: (() => number) | undefined): number {
  let value: number;
  try {
    value = (clock ?? Date.now)();
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TrustedToolExecutionUnavailableError();
  }
  return value;
}

function startIdentity(value: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    return invalid('start identity is invalid');
  }
  return value;
}

function adapterKey(bindingDigest: string, profile: DeploymentProfile): string {
  return `${bindingDigest}:${profile}`;
}

function invocationActionDigest(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  binding: Readonly<TrustedToolHandlerBinding>,
  definitions: ReturnType<
    TrustedToolHandlerBindingRegistry['definitionRegistry']
  >,
): string {
  const definition = definitions.resolve(
    binding.tool.name,
    binding.tool.version,
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: TOOL_INVOCATION_SCHEMA,
        projectId: barrier.projectId,
        requestedBy: barrier.requestedBy,
        tool: binding.tool,
        permission: `tool.call:${definition.name}`,
        requiredPermissions: definition.requiredPermissions,
        effect: definition.effect,
        risk: definition.risk,
        timeoutSeconds: definition.timeoutSeconds,
        inputDigest: barrier.invocationArtifact.inputDigest,
      }),
    )
    .digest('hex');
}

export class TrustedToolExecutionAdapterRegistry {
  readonly #bindings!: TrustedToolHandlerBindingRegistry;
  readonly #adapters!: ReadonlyMap<string, TrustedToolExecutionAdapter>;

  constructor(
    bindings: TrustedToolHandlerBindingRegistry,
    adapters: readonly TrustedToolExecutionAdapter[],
  ) {
    if (!(bindings instanceof TrustedToolHandlerBindingRegistry)) {
      return invalid('handler binding registry is invalid');
    }
    if (
      !Array.isArray(adapters) ||
      adapters.length > MAX_TRUSTED_TOOL_EXECUTION_ADAPTERS
    ) {
      return invalid('adapter count is invalid');
    }
    const entries = new Map<string, TrustedToolExecutionAdapter>();
    const definitions = bindings.definitionRegistry();
    for (const candidate of adapters) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.execute !== 'function' ||
        candidate.recoveryMode !== 'retry_safe_read'
      ) {
        return invalid('adapter shape is invalid');
      }
      const binding = normalizeTrustedToolHandlerBinding(candidate.binding);
      const current = bindings.resolve(
        binding.tool.name,
        binding.tool.version,
        candidate.profile,
      );
      const definition = definitions.resolve(
        binding.tool.name,
        binding.tool.version,
      );
      if (
        current.bindingDigest !== binding.bindingDigest ||
        definition.effect !== 'read' ||
        binding.executionClass !== 'builtin_in_process'
      ) {
        throw new TrustedToolExecutionBindingConflictError();
      }
      const key = adapterKey(binding.bindingDigest, candidate.profile);
      if (entries.has(key)) {
        return invalid('adapter binding is duplicated');
      }
      entries.set(
        key,
        Object.freeze({
          binding,
          profile: candidate.profile,
          recoveryMode: candidate.recoveryMode,
          execute: candidate.execute.bind(candidate),
        }),
      );
    }
    this.#bindings = bindings;
    this.#adapters = entries;
    Object.freeze(this);
  }

  resolve(
    barrierValue: ToolExecutionStartBarrierRecord,
  ): TrustedToolExecutionAdapter {
    const barrier = normalizeToolExecutionStartBarrierRecord(barrierValue);
    const current = this.#bindings
      .list()
      .find((binding) => binding.bindingDigest === barrier.bindingDigest);
    if (!current) {
      throw new TrustedToolExecutionBindingConflictError();
    }
    let resolved: Readonly<TrustedToolHandlerBinding>;
    try {
      resolved = this.#bindings.resolve(
        current.tool.name,
        current.tool.version,
        barrier.profile,
      );
    } catch {
      throw new TrustedToolExecutionBindingConflictError();
    }
    if (
      barrier.schema !== TOOL_EXECUTION_START_BARRIER_SCHEMA ||
      barrier.projectId !== this.#bindings.projectId ||
      barrier.snapshotDigest !== this.#bindings.snapshotDigest ||
      barrier.definitionDigest !== current.definitionDigest ||
      resolved.bindingDigest !== current.bindingDigest ||
      barrier.timeoutSeconds !== current.timeoutSeconds ||
      barrier.executionClass !== current.executionClass ||
      !sameValue(barrier.adapter, current.adapter) ||
      barrier.adapterDigest !==
        trustedToolContractIdentityDigest(current.adapter) ||
      !sameValue(barrier.redactionContract, current.redactionContract) ||
      barrier.redactionContractDigest !==
        trustedToolContractIdentityDigest(current.redactionContract) ||
      !sameValue(barrier.auditContract, current.auditContract) ||
      barrier.auditContractDigest !==
        trustedToolContractIdentityDigest(current.auditContract)
    ) {
      throw new TrustedToolExecutionBindingConflictError();
    }
    const adapter = this.#adapters.get(
      adapterKey(current.bindingDigest, barrier.profile),
    );
    if (!adapter) {
      throw new TrustedToolExecutionUnavailableError();
    }
    return adapter;
  }

  definitionRegistry(): ReturnType<
    TrustedToolHandlerBindingRegistry['definitionRegistry']
  > {
    return this.#bindings.definitionRegistry();
  }
}

async function durableBarrier(
  startIdValue: string,
  dependencies: Pick<TrustedToolExecutionDependencies, 'adapters' | 'barriers'>,
): Promise<
  Readonly<{
    barrier: Readonly<ToolExecutionStartBarrierRecord>;
    adapter: TrustedToolExecutionAdapter;
  }>
> {
  const startId = startIdentity(startIdValue);
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    !dependencies.barriers ||
    typeof dependencies.barriers.findByStartId !== 'function' ||
    !(dependencies.adapters instanceof TrustedToolExecutionAdapterRegistry)
  ) {
    return invalid('durable execution dependencies are invalid');
  }
  let found: Readonly<ToolExecutionStartBarrierRecord> | null;
  try {
    found = await dependencies.barriers.findByStartId(startId);
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (!found) {
    throw new TrustedToolExecutionUnavailableError();
  }
  let barrier: Readonly<ToolExecutionStartBarrierRecord>;
  try {
    barrier = normalizeToolExecutionStartBarrierRecord(found);
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (barrier.startId !== startId) {
    throw new TrustedToolExecutionUnavailableError();
  }
  return Object.freeze({
    barrier,
    adapter: dependencies.adapters.resolve(barrier),
  });
}

function executionContext(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
): Readonly<TrustedToolExecutionAdapterContext> {
  const deadlineAtMs = barrier.startedAtMs + barrier.timeoutSeconds * 1_000;
  if (!Number.isSafeInteger(deadlineAtMs)) {
    throw new TrustedToolExecutionUnavailableError();
  }
  return Object.freeze({
    startId: barrier.startId,
    projectId: barrier.projectId,
    runId: barrier.runId,
    stepRunId: barrier.stepRunId,
    actionRef: barrier.actionRef,
    requestedBy: barrier.requestedBy,
    profile: barrier.profile,
    startedAtMs: barrier.startedAtMs,
    deadlineAtMs,
  });
}

async function executeBeforeDeadline(
  adapter: TrustedToolExecutionAdapter,
  context: Readonly<TrustedToolExecutionAdapterContext>,
  input: ToolJsonValue,
  clock: (() => number) | undefined,
): Promise<unknown> {
  const remainingMs = context.deadlineAtMs - now(clock);
  if (remainingMs <= 0) {
    throw new TrustedToolExecutionDeadlineExceededError();
  }
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TrustedToolExecutionDeadlineExceededError());
    }, remainingMs);
    Promise.resolve()
      .then(() => adapter.execute(context, input))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function executeTrustedToolAfterStart(
  startId: string,
  dependencies: TrustedToolExecutionDependencies,
): Promise<Readonly<TrustedToolExecutionResult>> {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    !dependencies.artifacts ||
    typeof dependencies.artifacts.findInput !== 'function' ||
    !dependencies.keys ||
    typeof dependencies.keys.resolve !== 'function'
  ) {
    return invalid('execution dependencies are invalid');
  }
  const { barrier, adapter } = await durableBarrier(startId, dependencies);
  const context = executionContext(barrier);
  if (now(dependencies.now) > context.deadlineAtMs) {
    throw new TrustedToolExecutionDeadlineExceededError();
  }

  let artifactValue: Awaited<
    ReturnType<ToolInvocationArtifactRepository['findInput']>
  >;
  try {
    artifactValue = await dependencies.artifacts.findInput(
      barrier.invocationArtifact.artifactId,
    );
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (!artifactValue) {
    throw new TrustedToolExecutionUnavailableError();
  }
  let artifact: ReturnType<typeof normalizeToolInvocationInputArtifact>;
  try {
    artifact = normalizeToolInvocationInputArtifact(artifactValue);
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (
    !sameValue(
      toolInvocationInputArtifactReference(artifact),
      barrier.invocationArtifact,
    ) ||
    artifact.projectId !== barrier.projectId ||
    artifact.actionRef !== barrier.actionRef ||
    !sameValue(artifact.requestedBy, barrier.requestedBy) ||
    !sameValue(artifact.tool, adapter.binding.tool) ||
    artifact.invocationActionDigest !==
      invocationActionDigest(
        barrier,
        adapter.binding,
        dependencies.adapters.definitionRegistry(),
      ) ||
    artifact.sealedAtMs > barrier.startedAtMs
  ) {
    throw new TrustedToolExecutionBindingConflictError();
  }

  let material: Awaited<
    ReturnType<ToolInvocationArtifactKeyProvider['resolve']>
  >;
  try {
    material = await dependencies.keys.resolve(artifact.keyId);
  } catch {
    throw new TrustedToolExecutionUnavailableError();
  }
  if (!material) {
    throw new TrustedToolExecutionUnavailableError();
  }
  const key = material.key;
  if (
    material.keyId !== artifact.keyId ||
    !(key instanceof Uint8Array) ||
    key.byteLength !== 32
  ) {
    if (key instanceof Uint8Array) key.fill(0);
    throw new TrustedToolExecutionUnavailableError();
  }

  const definitions = dependencies.adapters.definitionRegistry();
  let output: ToolJsonValue;
  try {
    const input = openToolInvocationInputArtifact(artifact, key, definitions);
    const candidate = await executeBeforeDeadline(
      adapter,
      context,
      input,
      dependencies.now,
    );
    output = definitions.normalizeOutput(
      adapter.binding.tool.name,
      adapter.binding.tool.version,
      candidate,
    );
  } catch (error) {
    if (error instanceof TrustedToolExecutionDeadlineExceededError) {
      throw error;
    }
    throw new TrustedToolExecutionFailedError();
  } finally {
    key.fill(0);
  }

  const completedAtMs = now(dependencies.now);
  if (completedAtMs > context.deadlineAtMs) {
    throw new TrustedToolExecutionDeadlineExceededError();
  }
  const outputDigest = hash(OUTPUT_DIGEST_DOMAIN, output);
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: barrier.startId,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    output,
    outputDigest,
    completedAtMs,
  });
  return Object.freeze({
    ...unsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, unsigned),
  });
}

/**
 * Recovery inspection deliberately does not load or decrypt invocation input.
 * A reviewed read-only in-process adapter can be retried because it has no
 * external side effect; later write/remote adapters require stronger,
 * adapter-specific evidence and are not accepted by this registry.
 */
export async function inspectTrustedToolExecutionRecovery(
  startId: string,
  dependencies: Pick<
    TrustedToolExecutionDependencies,
    'adapters' | 'barriers' | 'now'
  >,
): Promise<Readonly<TrustedToolExecutionRecoveryEvidence>> {
  const { barrier, adapter } = await durableBarrier(startId, dependencies);
  if (adapter.recoveryMode !== 'retry_safe_read') {
    throw new TrustedToolExecutionUnavailableError();
  }
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RECOVERY_EVIDENCE_SCHEMA,
    startId: barrier.startId,
    barrierDigest: barrier.barrierDigest,
    adapterDigest: barrier.adapterDigest,
    disposition: 'retry_safe' as const,
    reason: 'read_only_no_side_effects' as const,
    inspectedAtMs: now(dependencies.now),
  });
  return Object.freeze({
    ...unsigned,
    evidenceDigest: hash(RECOVERY_EVIDENCE_DIGEST_DOMAIN, unsigned),
  });
}
