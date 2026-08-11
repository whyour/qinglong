import { createHash } from 'node:crypto';

import type { RunRepositoryReader } from '../run/runRepository';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunRepository,
} from '../run/stepRun';
import {
  createToolExecutionCompletionCommand,
  createToolExecutionResultArtifact,
  normalizeToolExecutionCompletionRecord,
  normalizeToolExecutionResultArtifact,
  openToolExecutionResultArtifact,
  ToolExecutionCompletionConflictError,
  ToolExecutionCompletionUnavailableError,
  toolExecutionCompletionRecord,
  type ToolExecutionCompletionRecord,
  type ToolExecutionCompletionRepository,
  type ToolExecutionResultArtifact,
} from './toolExecutionCompletion';
import {
  normalizeToolExecutionStartBarrierRecord,
  type ToolExecutionStartBarrierRecord,
} from './toolExecutionStartBarrier';
import {
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  requireDecryptableToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
  type ToolResultKeyCatalogReader,
  type ToolResultKeyCatalogRecord,
} from './toolResultKeyCatalog';
import type {
  ToolInvocationArtifactKeyMaterial,
  ToolInvocationArtifactKeyProvider,
} from './toolInvocationArtifact';
import {
  normalizeToolExecutionResultRekeyOverlay,
  openToolExecutionResultRekeyOverlay,
  type ToolExecutionResultRekeyOverlay,
  type ToolExecutionResultRekeyReader,
} from './toolResultRekey';
import {
  executeTrustedToolAfterStart,
  TrustedToolExecutionAdapterRegistry,
  type TrustedToolExecutionDependencies,
} from './trustedToolExecution';
import type { ToolJsonValue } from './tool-registry/toolRegistry';

export interface TrustedToolSuccessCompletionIdentities {
  readonly artifactId: string;
  readonly mutationId: string;
  readonly eventId: string;
}

export interface TrustedToolSuccessCompletionIdentityFactory {
  create(startId: string): TrustedToolSuccessCompletionIdentities;
}

export interface TrustedToolSuccessCompletionDependencies
  extends TrustedToolExecutionDependencies {
  readonly completions: ToolExecutionCompletionRepository;
  readonly stepRuns: Pick<StepRunRepository, 'findById'>;
  readonly runs: Pick<RunRepositoryReader, 'findRunById'>;
  readonly resultKeyCatalog: ToolResultKeyCatalogReader;
  readonly resultRekeys: ToolExecutionResultRekeyReader;
  readonly resultKeys: Pick<ToolInvocationArtifactKeyProvider, 'resolve'>;
  readonly identities: TrustedToolSuccessCompletionIdentityFactory;
  readonly nonceFactory?: () => Uint8Array;
}

export interface TrustedToolSuccessCompletionResult {
  readonly status: 'created' | 'existing';
  readonly completion: Readonly<ToolExecutionCompletionRecord>;
  readonly output: ToolJsonValue;
}

const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function unavailable(cause?: unknown): never {
  throw new ToolExecutionCompletionUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function conflict(): never {
  throw new ToolExecutionCompletionConflictError();
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateDependencies(
  dependencies: TrustedToolSuccessCompletionDependencies,
): void {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    !dependencies.completions ||
    typeof dependencies.completions.findByStartId !== 'function' ||
    typeof dependencies.completions.findResultArtifact !== 'function' ||
    typeof dependencies.completions.commit !== 'function' ||
    !dependencies.stepRuns ||
    typeof dependencies.stepRuns.findById !== 'function' ||
    !dependencies.runs ||
    typeof dependencies.runs.findRunById !== 'function' ||
    !dependencies.resultKeys ||
    typeof dependencies.resultKeys.resolve !== 'function' ||
    !dependencies.resultKeyCatalog ||
    typeof dependencies.resultKeyCatalog.findCurrent !== 'function' ||
    !dependencies.resultRekeys ||
    typeof dependencies.resultRekeys.findHeadByArtifactId !== 'function' ||
    !dependencies.identities ||
    typeof dependencies.identities.create !== 'function' ||
    !(dependencies.adapters instanceof TrustedToolExecutionAdapterRegistry) ||
    (dependencies.nonceFactory !== undefined &&
      typeof dependencies.nonceFactory !== 'function')
  ) {
    unavailable();
  }
}

async function findResultRekeyHead(
  artifactId: string,
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<ToolExecutionResultRekeyOverlay> | null> {
  try {
    const value = await dependencies.resultRekeys.findHeadByArtifactId(
      artifactId,
    );
    return value === null
      ? null
      : normalizeToolExecutionResultRekeyOverlay(value);
  } catch (cause) {
    return unavailable(cause);
  }
}

async function findResultKeyCatalog(
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<ToolResultKeyCatalogRecord>> {
  try {
    const value = await dependencies.resultKeyCatalog.findCurrent();
    if (!value) return unavailable();
    return normalizeToolResultKeyCatalogRecord(value);
  } catch (cause) {
    return unavailable(cause);
  }
}

function validCatalogMaterial(
  material: ToolInvocationArtifactKeyMaterial | null,
  keyId: string,
  materialProof: string,
): material is ToolInvocationArtifactKeyMaterial {
  return (
    validKey(material, keyId) &&
    toolResultKeyMaterialProof(keyId, material.key) === materialProof
  );
}

async function findCompletion(
  startId: string,
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<ToolExecutionCompletionRecord> | null> {
  try {
    const value = await dependencies.completions.findByStartId(startId);
    return value === null
      ? null
      : normalizeToolExecutionCompletionRecord(value);
  } catch (cause) {
    return unavailable(cause);
  }
}

async function findBarrier(
  startId: string,
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<ToolExecutionStartBarrierRecord>> {
  try {
    const value = await dependencies.barriers.findByStartId(startId);
    if (!value) return unavailable();
    const barrier = normalizeToolExecutionStartBarrierRecord(value);
    if (barrier.startId !== startId) return unavailable();
    return barrier;
  } catch (cause) {
    return unavailable(cause);
  }
}

function validKey(
  material: ToolInvocationArtifactKeyMaterial | null,
  expectedKeyId?: string,
): material is ToolInvocationArtifactKeyMaterial {
  return (
    material !== null &&
    typeof material.keyId === 'string' &&
    (expectedKeyId === undefined || material.keyId === expectedKeyId) &&
    material.key instanceof Uint8Array &&
    material.key.byteLength === 32
  );
}

function wipeMaterial(
  material: ToolInvocationArtifactKeyMaterial | null | undefined,
): void {
  if (material?.key instanceof Uint8Array) material.key.fill(0);
}

function completionMatches(
  completion: Readonly<ToolExecutionCompletionRecord>,
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  artifact: Readonly<ToolExecutionResultArtifact>,
): boolean {
  return (
    completion.startId === barrier.startId &&
    completion.projectId === barrier.projectId &&
    completion.runId === barrier.runId &&
    completion.stepRunId === barrier.stepRunId &&
    completion.startedStepRunVersion === barrier.startedStepRunVersion &&
    completion.barrierDigest === barrier.barrierDigest &&
    completion.adapterDigest === barrier.adapterDigest &&
    artifact.artifactId === completion.resultArtifact.artifactId &&
    artifact.artifactDigest === completion.resultArtifact.artifactDigest &&
    artifact.projectId === completion.projectId &&
    artifact.startId === completion.startId &&
    artifact.runId === completion.runId &&
    artifact.stepRunId === completion.stepRunId &&
    artifact.barrierDigest === completion.barrierDigest &&
    artifact.adapterDigest === completion.adapterDigest &&
    artifact.outputDigest === completion.resultArtifact.outputDigest &&
    artifact.executionResultDigest ===
      completion.resultArtifact.executionResultDigest &&
    artifact.sealedAtMs === completion.completedAtMs
  );
}

async function openDurableCompletion(
  completion: Readonly<ToolExecutionCompletionRecord>,
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<TrustedToolSuccessCompletionResult>> {
  const barrier = await findBarrier(completion.startId, dependencies);
  let artifact: Readonly<ToolExecutionResultArtifact>;
  try {
    const value = await dependencies.completions.findResultArtifact(
      completion.resultArtifact.artifactId,
    );
    if (!value) return unavailable();
    artifact = normalizeToolExecutionResultArtifact(value);
  } catch (cause) {
    return unavailable(cause);
  }
  if (!completionMatches(completion, barrier, artifact)) {
    return conflict();
  }

  const adapter = dependencies.adapters.resolve(barrier);
  if (!sameValue(artifact.tool, adapter.binding.tool)) {
    return conflict();
  }

  let material: ToolInvocationArtifactKeyMaterial | null | undefined;
  try {
    const catalog = await findResultKeyCatalog(dependencies);
    const overlay = await findResultRekeyHead(
      artifact.artifactId,
      dependencies,
    );
    const keyId = overlay?.targetCatalogFence.keyId ?? artifact.keyId;
    const entry = requireDecryptableToolResultKey(catalog, keyId);
    const materialProof =
      overlay?.targetCatalogFence.materialProof ?? entry.materialProof;
    if (entry.materialProof !== materialProof) return unavailable();
    material = await dependencies.resultKeys.resolve(keyId);
    if (!validCatalogMaterial(material, keyId, materialProof)) {
      return unavailable();
    }
    const output = overlay
      ? openToolExecutionResultRekeyOverlay(
          overlay,
          material.key,
          dependencies.adapters.definitionRegistry(),
          artifact,
        )
      : openToolExecutionResultArtifact(
          artifact,
          material.key,
          dependencies.adapters.definitionRegistry(),
        );
    return Object.freeze({
      status: 'existing' as const,
      completion,
      output,
    });
  } catch (cause) {
    return unavailable(cause);
  } finally {
    wipeMaterial(material);
  }
}

async function findStepRun(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  dependencies: TrustedToolSuccessCompletionDependencies,
) {
  try {
    const value = await dependencies.stepRuns.findById(barrier.stepRunId);
    if (!value) return unavailable();
    return normalizeStepRunRecord(value);
  } catch (cause) {
    return unavailable(cause);
  }
}

async function findRun(
  barrier: Readonly<ToolExecutionStartBarrierRecord>,
  dependencies: TrustedToolSuccessCompletionDependencies,
) {
  try {
    const value = await dependencies.runs.findRunById(barrier.runId);
    if (!value) return unavailable();
    return value;
  } catch (cause) {
    return unavailable(cause);
  }
}

function completionDedupeKey(startId: string): string {
  return `tool-success:${createHash('sha256').update(startId).digest('hex')}`;
}

/**
 * Executes one already-started retry-safe Tool and closes its success path.
 *
 * Durable completion is checked before adapter execution and again after it.
 * If the commit response is lost, the stored encrypted result is reopened and
 * returned without executing the adapter a second time in this call.
 */
export async function executeAndCompleteTrustedToolSuccess(
  startId: string,
  dependencies: TrustedToolSuccessCompletionDependencies,
): Promise<Readonly<TrustedToolSuccessCompletionResult>> {
  validateDependencies(dependencies);

  const existing = await findCompletion(startId, dependencies);
  if (existing) return openDurableCompletion(existing, dependencies);

  const executionResult = await executeTrustedToolAfterStart(
    startId,
    dependencies,
  );

  const concurrent = await findCompletion(startId, dependencies);
  if (concurrent) return openDurableCompletion(concurrent, dependencies);

  const barrier = await findBarrier(startId, dependencies);
  const adapter = dependencies.adapters.resolve(barrier);
  const stepRun = await findStepRun(barrier, dependencies);
  const run = await findRun(barrier, dependencies);
  if (
    stepRun.id !== barrier.stepRunId ||
    stepRun.runId !== barrier.runId ||
    stepRun.kind !== 'tool' ||
    stepRun.status !== 'running' ||
    stepRun.version !== barrier.startedStepRunVersion ||
    stepRun.stepRunDigest !== barrier.startedStepRunDigest ||
    run.id !== barrier.runId ||
    run.projectId !== barrier.projectId ||
    !Number.isSafeInteger(run.version) ||
    run.version < 0 ||
    !Number.isSafeInteger(run.eventSequence) ||
    run.eventSequence < 0 ||
    TERMINAL_RUN_STATUSES.has(run.status)
  ) {
    return conflict();
  }

  let identities: TrustedToolSuccessCompletionIdentities;
  try {
    identities = dependencies.identities.create(startId);
  } catch (cause) {
    return unavailable(cause);
  }

  let material: ToolInvocationArtifactKeyMaterial | null | undefined;
  let resultArtifact: Readonly<ToolExecutionResultArtifact>;
  let resultKeyCatalogFence: ReturnType<typeof toolResultKeyCatalogFence>;
  try {
    const catalog = await findResultKeyCatalog(dependencies);
    const entry = requireActiveToolResultKey(catalog);
    material = await dependencies.resultKeys.resolve(entry.keyId);
    if (!validCatalogMaterial(material, entry.keyId, entry.materialProof)) {
      return unavailable();
    }
    resultKeyCatalogFence = toolResultKeyCatalogFence(catalog, entry);
    resultArtifact = createToolExecutionResultArtifact(
      {
        artifactId: identities.artifactId,
        projectId: barrier.projectId,
        runId: barrier.runId,
        stepRunId: barrier.stepRunId,
        tool: adapter.binding.tool,
        executionResult,
        keyId: entry.keyId,
        key: material.key,
      },
      dependencies.adapters.definitionRegistry(),
      dependencies.nonceFactory,
    );
  } catch (cause) {
    return unavailable(cause);
  } finally {
    wipeMaterial(material);
  }

  const stepRunMutation = transitionStepRunMutation(
    stepRun,
    {
      expectedVersion: stepRun.version,
      expectedDigest: stepRun.stepRunDigest,
      mutationId: identities.mutationId,
      to: 'succeeded',
      atMs: executionResult.completedAtMs,
      outputRef: resultArtifact.artifactId,
    },
    {
      expectedRunVersion: run.version,
      expectedRunEventSequence: run.eventSequence,
      eventId: identities.eventId,
      dedupeKey: completionDedupeKey(startId),
      actor: Object.freeze({
        type: 'system' as const,
        id: 'trusted-tool-runtime',
      }),
    },
  );
  const command = createToolExecutionCompletionCommand({
    barrier,
    executionResult,
    resultArtifact,
    resultKeyCatalogFence,
    stepRunMutation,
  });
  const expectedCompletion = toolExecutionCompletionRecord(command);

  try {
    const committed = await dependencies.completions.commit(command);
    const completion = normalizeToolExecutionCompletionRecord(
      committed.completion,
    );
    if (
      !['created', 'existing'].includes(committed.status) ||
      !sameValue(completion, expectedCompletion)
    ) {
      return conflict();
    }
    return Object.freeze({
      status: committed.status,
      completion,
      output: executionResult.output,
    });
  } catch (cause) {
    const recovered = await findCompletion(startId, dependencies);
    if (recovered) return openDurableCompletion(recovered, dependencies);
    throw cause;
  }
}
