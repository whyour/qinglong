// Remote Execution owns bounded Secret and Artifact context materialization.
import {
  MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES,
  MAX_LOCAL_DISPATCH_ENVIRONMENT_ENTRIES,
  MAX_LOCAL_DISPATCH_SECRET_REFS,
} from '@qinglong/runtime-core/local-dispatch';
import { parseEnvironmentBundle } from '@qinglong/runtime-core/environment-bundle';
import type { ClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import { assertRunDispatchId } from '@qinglong/runtime-core/run-dispatch-lease';
import type {
  MaterializedWorkerRemoteExecutionContext,
  WorkerRemoteExecutionContextMaterializer,
  WorkerRemoteExecutionOutputSink,
} from './executionInboxProcessor';

export interface WorkerRemoteSecretResolution {
  readonly values: readonly Readonly<{
    secretRef: string;
    value: string;
  }>[];
  readonly environmentBundles: readonly Readonly<{
    secretRef: string;
    value: string;
  }>[];
  readonly dispose?: () => Promise<void> | void;
}

export interface WorkerRemoteSecretEnvironmentProvider {
  resolve(
    request: Readonly<{
      projectId: string;
      taskId: string;
      taskRevision: string;
      runId: string;
      attemptId: string;
      offerId: string;
      executionDigest: string;
      secretRefs: readonly string[];
      environmentBundleRefs: readonly string[];
    }>,
  ): Promise<WorkerRemoteSecretResolution | undefined>;
}

export interface WorkerRemoteLogArtifactPreparation {
  readonly logArtifactId: string;
  /** Transfers the prepared writer once; release must not close it afterwards. */
  readonly takeOutput: () => WorkerRemoteExecutionOutputSink;
  /** Releases only preparation resources; it must not delete a handed-off log. */
  readonly release: () => Promise<void> | void;
}

export interface WorkerRemoteLogArtifactAllocator {
  prepare(
    request: Readonly<{
      projectId: string;
      runId: string;
      attemptId: string;
      offerId: string;
    }>,
  ): Promise<WorkerRemoteLogArtifactPreparation | undefined>;
}

export interface BoundedWorkerRemoteExecutionContextMaterializerOptions {
  readonly artifacts: WorkerRemoteLogArtifactAllocator;
  readonly secrets?: WorkerRemoteSecretEnvironmentProvider;
}

export class WorkerRemoteExecutionMaterializationError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'secret_unavailable'
      | 'secret_response_invalid'
      | 'environment_budget_exceeded'
      | 'artifact_unavailable'
      | 'artifact_response_invalid',
  ) {
    super(`Worker remote execution materialization failed: ${reason}`);
    this.name = 'WorkerRemoteExecutionMaterializationError';
  }
}

function environmentValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 16 * 1024
  ) {
    throw new WorkerRemoteExecutionMaterializationError(
      'secret_response_invalid',
    );
  }
  return value;
}

async function disposeQuietly(
  operation: (() => Promise<void> | void) | undefined,
): Promise<void> {
  await Promise.resolve()
    .then(() => operation?.())
    .catch(() => undefined);
}

export class BoundedWorkerRemoteExecutionContextMaterializer
  implements WorkerRemoteExecutionContextMaterializer
{
  private readonly artifacts: WorkerRemoteLogArtifactAllocator;
  private readonly secrets?: WorkerRemoteSecretEnvironmentProvider;

  constructor(options: BoundedWorkerRemoteExecutionContextMaterializerOptions) {
    if (
      !options ||
      typeof options.artifacts?.prepare !== 'function' ||
      (options.secrets !== undefined &&
        typeof options.secrets.resolve !== 'function')
    ) {
      throw new WorkerRemoteExecutionMaterializationError(
        'invalid_configuration',
      );
    }
    this.artifacts = options.artifacts;
    this.secrets = options.secrets;
  }

  async prepare(
    input: Readonly<{
      offer: ClusterRemoteExecutionOffer;
    }>,
  ): Promise<MaterializedWorkerRemoteExecutionContext> {
    let offer: ClusterRemoteExecutionOffer;
    try {
      offer = createClusterRemoteExecutionOffer(input?.offer);
    } catch {
      throw new WorkerRemoteExecutionMaterializationError(
        'invalid_configuration',
      );
    }
    const bindings = offer.executionRevision.environment;
    const secretRefs = Object.freeze([
      ...new Set(
        bindings.flatMap((binding) =>
          binding.kind === 'secret' ? [binding.secretRef] : [],
        ),
      ),
    ]);
    const environmentBundleRefs = Object.freeze(
      offer.executionRevision.environmentBundleRef === undefined
        ? []
        : [offer.executionRevision.environmentBundleRef],
    );
    if (secretRefs.length > MAX_LOCAL_DISPATCH_SECRET_REFS) {
      throw new WorkerRemoteExecutionMaterializationError(
        'environment_budget_exceeded',
      );
    }
    let secretResolution: WorkerRemoteSecretResolution | undefined;
    const secretByRef = new Map<string, string>();
    if (secretRefs.length > 0 || environmentBundleRefs.length > 0) {
      if (!this.secrets) {
        throw new WorkerRemoteExecutionMaterializationError(
          'secret_unavailable',
        );
      }
      try {
        secretResolution = await this.secrets.resolve(
          Object.freeze({
            projectId: offer.candidate.projectId,
            taskId: offer.candidate.taskId,
            taskRevision: offer.candidate.taskRevision,
            runId: offer.candidate.runId,
            attemptId: offer.candidate.attemptId,
            offerId: offer.offerId,
            executionDigest: offer.executionDigest,
            secretRefs,
            environmentBundleRefs,
          }),
        );
      } catch {
        throw new WorkerRemoteExecutionMaterializationError(
          'secret_unavailable',
        );
      }
      if (!secretResolution) {
        throw new WorkerRemoteExecutionMaterializationError(
          'secret_unavailable',
        );
      }
      if (
        Object.keys(secretResolution).some(
          (key) =>
            key !== 'values' &&
            key !== 'environmentBundles' &&
            key !== 'dispose',
        ) ||
        !Array.isArray(secretResolution.values) ||
        secretResolution.values.length !== secretRefs.length ||
        !Array.isArray(secretResolution.environmentBundles) ||
        secretResolution.environmentBundles.length !==
          environmentBundleRefs.length ||
        (secretResolution.dispose !== undefined &&
          typeof secretResolution.dispose !== 'function')
      ) {
        await disposeQuietly(secretResolution.dispose);
        throw new WorkerRemoteExecutionMaterializationError(
          'secret_response_invalid',
        );
      }
      try {
        for (const entry of secretResolution.values) {
          if (
            !entry ||
            typeof entry !== 'object' ||
            Object.keys(entry).length !== 2 ||
            !Object.hasOwn(entry, 'secretRef') ||
            !Object.hasOwn(entry, 'value') ||
            typeof entry.secretRef !== 'string' ||
            !secretRefs.includes(entry.secretRef) ||
            secretByRef.has(entry.secretRef)
          ) {
            throw new WorkerRemoteExecutionMaterializationError(
              'secret_response_invalid',
            );
          }
          secretByRef.set(entry.secretRef, environmentValue(entry.value));
        }
      } catch (error) {
        await disposeQuietly(secretResolution.dispose);
        throw error;
      }
    }
    let environmentBytes = 0;
    let environment: MaterializedWorkerRemoteExecutionContext['environment'];
    try {
      const names = new Set<string>();
      const materialized = bindings.map((binding) => {
        const value =
          binding.kind === 'public'
            ? binding.value
            : secretByRef.get(binding.secretRef);
        if (value === undefined) {
          throw new WorkerRemoteExecutionMaterializationError(
            'secret_response_invalid',
          );
        }
        environmentBytes +=
          Buffer.byteLength(binding.name, 'utf8') +
          Buffer.byteLength(value, 'utf8');
        names.add(binding.name);
        if (environmentBytes > MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES) {
          throw new WorkerRemoteExecutionMaterializationError(
            'environment_budget_exceeded',
          );
        }
        return Object.freeze({ name: binding.name, value });
      });
      for (const entry of secretResolution?.environmentBundles ?? []) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Object.keys(entry).length !== 2 ||
          !Object.hasOwn(entry, 'secretRef') ||
          !Object.hasOwn(entry, 'value') ||
          typeof entry.secretRef !== 'string' ||
          !environmentBundleRefs.includes(entry.secretRef) ||
          typeof entry.value !== 'string'
        ) {
          throw new WorkerRemoteExecutionMaterializationError(
            'secret_response_invalid',
          );
        }
        let bundle;
        try {
          bundle = parseEnvironmentBundle(entry.value);
        } catch {
          throw new WorkerRemoteExecutionMaterializationError(
            'secret_response_invalid',
          );
        }
        for (const binding of bundle.entries) {
          if (names.has(binding.name)) {
            throw new WorkerRemoteExecutionMaterializationError(
              'secret_response_invalid',
            );
          }
          names.add(binding.name);
          environmentBytes +=
            Buffer.byteLength(binding.name, 'utf8') +
            Buffer.byteLength(binding.value, 'utf8');
          if (
            materialized.length >= MAX_LOCAL_DISPATCH_ENVIRONMENT_ENTRIES ||
            environmentBytes > MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES
          ) {
            throw new WorkerRemoteExecutionMaterializationError(
              'environment_budget_exceeded',
            );
          }
          materialized.push(
            Object.freeze({ name: binding.name, value: binding.value }),
          );
        }
      }
      environment = Object.freeze(materialized);
    } catch (error) {
      await disposeQuietly(secretResolution?.dispose);
      throw error;
    }
    let artifact: WorkerRemoteLogArtifactPreparation | undefined;
    try {
      artifact = await this.artifacts.prepare(
        Object.freeze({
          projectId: offer.candidate.projectId,
          runId: offer.candidate.runId,
          attemptId: offer.candidate.attemptId,
          offerId: offer.offerId,
        }),
      );
    } catch {
      await disposeQuietly(secretResolution?.dispose);
      throw new WorkerRemoteExecutionMaterializationError(
        'artifact_unavailable',
      );
    }
    if (!artifact) {
      await disposeQuietly(secretResolution?.dispose);
      throw new WorkerRemoteExecutionMaterializationError(
        'artifact_unavailable',
      );
    }
    try {
      if (
        Object.keys(artifact).length !== 3 ||
        !Object.hasOwn(artifact, 'logArtifactId') ||
        !Object.hasOwn(artifact, 'takeOutput') ||
        !Object.hasOwn(artifact, 'release')
      ) {
        throw new Error('invalid artifact preparation');
      }
      assertRunDispatchId('logArtifactId', artifact.logArtifactId);
      if (
        artifact.logArtifactId.length > 36 ||
        typeof artifact.takeOutput !== 'function' ||
        typeof artifact.release !== 'function'
      ) {
        throw new Error('invalid artifact preparation');
      }
    } catch {
      await disposeQuietly(artifact.release);
      await disposeQuietly(secretResolution?.dispose);
      throw new WorkerRemoteExecutionMaterializationError(
        'artifact_response_invalid',
      );
    }
    let disposed = false;
    let outputTaken = false;
    return Object.freeze({
      environment,
      logArtifactId: artifact.logArtifactId,
      takeOutput() {
        if (disposed || outputTaken) {
          throw new WorkerRemoteExecutionMaterializationError(
            'artifact_response_invalid',
          );
        }
        const output = artifact!.takeOutput();
        if (
          !output ||
          typeof output !== 'object' ||
          output.logArtifactId !== artifact!.logArtifactId ||
          typeof output.write !== 'function' ||
          typeof output.close !== 'function'
        ) {
          void Promise.resolve(output?.close?.()).catch(() => undefined);
          throw new WorkerRemoteExecutionMaterializationError(
            'artifact_response_invalid',
          );
        }
        outputTaken = true;
        return output;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await Promise.all([
          disposeQuietly(artifact!.release),
          disposeQuietly(secretResolution?.dispose),
        ]);
      },
    });
  }
}
