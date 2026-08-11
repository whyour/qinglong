import type {
  LocalDispatchCandidate,
  LocalDispatchStore,
  LocalSecretEnvironmentProvider,
} from '@qinglong/runtime-core/local-dispatch';
import {
  MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES,
  MAX_LOCAL_DISPATCH_SECRET_REFS,
  normalizeLocalDispatchCandidate,
  normalizeLocalExecutionContextRecipe,
  normalizeLocalTaskExecutionRevision,
} from '@qinglong/runtime-core/local-dispatch';
import type { LocalExecutionStartCommand } from '../execution/coordinator';
import type { LocalArtifactAllocator } from './artifact';

export interface LocalDispatchPlan {
  readonly command: LocalExecutionStartCommand;
}

export interface LocalDispatchPlanSource {
  prepare(candidate: LocalDispatchCandidate): Promise<LocalDispatchPlan | null>;
}

function assertEnvironmentValue(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 16 * 1024
  ) {
    throw new TypeError('Local dispatch environment value is invalid');
  }
}

export class LocalDispatchPlanMaterializer implements LocalDispatchPlanSource {
  constructor(
    private readonly definitions: Pick<
      LocalDispatchStore,
      'resolveLocalTaskExecutionRevision' | 'resolveLocalExecutionContextRecipe'
    >,
    private readonly artifacts: LocalArtifactAllocator,
    private readonly secrets?: LocalSecretEnvironmentProvider,
  ) {}

  async prepare(
    candidate: LocalDispatchCandidate,
  ): Promise<LocalDispatchPlan | null> {
    const normalizedCandidate = normalizeLocalDispatchCandidate(candidate);
    const revision = await this.definitions.resolveLocalTaskExecutionRevision({
      projectId: normalizedCandidate.projectId,
      taskId: normalizedCandidate.taskId,
      taskRevision: normalizedCandidate.taskRevision,
    });
    if (!revision) return null;
    const normalizedRevision = normalizeLocalTaskExecutionRevision(revision);
    if (
      normalizedRevision.projectId !== normalizedCandidate.projectId ||
      normalizedRevision.taskId !== normalizedCandidate.taskId ||
      normalizedRevision.taskRevision !== normalizedCandidate.taskRevision ||
      normalizedRevision.executorType !== normalizedCandidate.executorType
    ) {
      throw new TypeError('Local Task revision does not match its candidate');
    }
    const recipe = await this.definitions.resolveLocalExecutionContextRecipe(
      normalizedRevision.contextRef,
    );
    if (!recipe) return null;
    const normalizedRecipe = normalizeLocalExecutionContextRecipe(recipe);
    if (normalizedRecipe.contextRef !== normalizedRevision.contextRef) {
      throw new TypeError('Local context recipe does not match its revision');
    }
    const secretRefs = Object.freeze([
      ...new Set(
        normalizedRecipe.environment.flatMap((binding) =>
          binding.kind === 'secret' ? [binding.secretRef] : [],
        ),
      ),
    ]);
    if (secretRefs.length > MAX_LOCAL_DISPATCH_SECRET_REFS) {
      throw new RangeError('Local dispatch Secret reference budget exceeded');
    }
    let secretValues: readonly string[] = [];
    if (secretRefs.length > 0) {
      if (!this.secrets) return null;
      const resolved = await this.secrets.resolveLocalSecretEnvironment({
        candidate: normalizedCandidate,
        secretRefs,
      });
      if (!resolved) return null;
      if (resolved.length !== secretRefs.length) {
        throw new TypeError('Local Secret provider returned an invalid result');
      }
      secretValues = resolved;
    }
    const secretByRef = new Map(
      secretRefs.map((secretRef, index) => [secretRef, secretValues[index]]),
    );
    const environment: Record<string, string> = Object.create(null);
    let environmentBytes = 0;
    for (const binding of normalizedRecipe.environment) {
      const value =
        binding.kind === 'public'
          ? binding.value
          : secretByRef.get(binding.secretRef);
      assertEnvironmentValue(value);
      environmentBytes +=
        Buffer.byteLength(binding.name, 'utf8') +
        Buffer.byteLength(value, 'utf8');
      if (environmentBytes > MAX_LOCAL_DISPATCH_ENVIRONMENT_BYTES) {
        throw new RangeError('Local dispatch environment byte budget exceeded');
      }
      environment[binding.name] = value;
    }
    const artifact = await this.artifacts.prepare(normalizedCandidate);
    return Object.freeze({
      command: Object.freeze({
        runId: normalizedCandidate.runId,
        attemptId: normalizedCandidate.attemptId,
        ...(normalizedCandidate.stepRunId === undefined
          ? {}
          : { stepRunId: normalizedCandidate.stepRunId }),
        command: normalizedRevision.command,
        environment: Object.freeze(environment),
        ...(normalizedRevision.workingDirectory === undefined
          ? {}
          : { workingDirectory: normalizedRevision.workingDirectory }),
        ...(normalizedRevision.timeoutMs === undefined
          ? {}
          : { timeoutMs: normalizedRevision.timeoutMs }),
        output: artifact.output,
      }),
    });
  }
}
