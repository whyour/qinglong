import type { LocalExecutionContextRecipe } from '../domain/localExecutionContextRecipe';

export interface LocalExecutionContextRecipeSource {
  /** Resolves one exact opaque reference and never falls back to latest. */
  resolve(contextRef: string): Promise<LocalExecutionContextRecipe | null>;
}
