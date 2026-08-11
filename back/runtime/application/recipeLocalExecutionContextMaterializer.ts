import type { ExecutionContext } from '../domain/execution';
import { normalizeExecutionContext } from '../domain/executionContext';
import { assertLocalExecutionArtifactId } from '../domain/localExecutionArtifact';
import {
  assertLocalExecutionContextRef,
  normalizeLocalExecutionContextRecipe,
} from '../domain/localExecutionContextRecipe';
import { assertRunDispatchCandidate } from '../domain/runDispatchCandidate';
import type { LocalExecutionArtifactAllocator } from '../ports/localExecutionArtifactAllocator';
import type { LocalExecutionContextMaterializer } from '../ports/localExecutionContextMaterializer';
import type { LocalExecutionContextRecipeSource } from '../ports/localExecutionContextRecipeSource';
import type { LocalSecretEnvironmentProvider } from '../ports/localSecretEnvironmentProvider';

const VALIDATION_OUTPUT = Object.freeze({ async write() {} });

/** Resolves public values, ephemeral Secrets and an Attempt-scoped Artifact. */
export class RecipeLocalExecutionContextMaterializer
  implements LocalExecutionContextMaterializer
{
  constructor(
    private readonly recipes: LocalExecutionContextRecipeSource,
    private readonly artifacts: LocalExecutionArtifactAllocator,
    private readonly secrets?: LocalSecretEnvironmentProvider,
  ) {}

  async prepare(
    request: Parameters<LocalExecutionContextMaterializer['prepare']>[0],
  ): ReturnType<LocalExecutionContextMaterializer['prepare']> {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('Local execution context request must be an object');
    }
    assertRunDispatchCandidate(request.candidate);
    assertLocalExecutionContextRef(request.contextRef);
    const recipe = await this.recipes.resolve(request.contextRef);
    if (!recipe) return null;
    const normalized = normalizeLocalExecutionContextRecipe(recipe);
    if (normalized.contextRef !== request.contextRef) {
      throw new TypeError('Local context recipe does not match contextRef');
    }

    const secretRefs = [
      ...new Set(
        normalized.environment.flatMap((binding) =>
          binding.kind === 'secret' ? [binding.secretRef] : [],
        ),
      ),
    ];
    let secretValues: readonly string[] = [];
    if (secretRefs.length > 0) {
      if (!this.secrets) return null;
      const resolved = await this.secrets.resolve(
        Object.freeze({
          candidate: Object.freeze({ ...request.candidate }),
          secretRefs: Object.freeze([...secretRefs]),
        }),
      );
      if (!resolved) return null;
      if (resolved.length !== secretRefs.length) {
        throw new TypeError('Local Secret provider returned an invalid result');
      }
      secretValues = resolved;
    }
    const byRef = new Map(
      secretRefs.map((secretRef, index) => [secretRef, secretValues[index]]),
    );
    const environment: Record<string, string> = Object.create(null);
    for (const binding of normalized.environment) {
      environment[binding.name] =
        binding.kind === 'public'
          ? binding.value
          : (byRef.get(binding.secretRef) as string);
    }
    const validatedEnvironment = normalizeExecutionContext({
      environment,
      output: VALIDATION_OUTPUT,
    }).environment;

    const artifact = await this.artifacts.prepare(request.candidate);
    try {
      assertLocalExecutionArtifactId(artifact.logArtifactId);
      const context: ExecutionContext = normalizeExecutionContext({
        environment: validatedEnvironment,
        output: artifact.output,
      });
      return {
        context,
        logArtifactId: artifact.logArtifactId,
        dispose: () => artifact.dispose(),
      };
    } catch (error) {
      await Promise.resolve(artifact.dispose()).catch(() => undefined);
      throw error;
    }
  }
}
