import type { LocalExecutionContextRecipe } from '../domain/localExecutionContextRecipe';
import type { LocalExecutionContextRecipeSource } from './localExecutionContextRecipeSource';

export type InsertLocalExecutionContextRecipeResult = 'inserted' | 'idempotent';

export interface LocalExecutionContextRecipeRepository
  extends LocalExecutionContextRecipeSource {
  insert(
    recipe: LocalExecutionContextRecipe,
    createdAtMs: number,
  ): Promise<InsertLocalExecutionContextRecipeResult>;
}
