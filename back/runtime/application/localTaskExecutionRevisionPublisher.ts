import type { PinnedTaskExecutionRevision } from '../domain/taskExecutionRevision';
import type { LocalExecutionContextRecipe } from '../domain/localExecutionContextRecipe';
import type { LocalExecutionContextRecipeRepository } from '../ports/localExecutionContextRecipeRepository';
import type { TaskExecutionRevisionRepository } from '../ports/taskExecutionRevisionRepository';

export interface PublishLocalTaskExecutionRevisionCommand {
  revision: PinnedTaskExecutionRevision;
  contextRecipe: LocalExecutionContextRecipe;
  createdAtMs: number;
}

export interface PublishLocalTaskExecutionRevisionResult {
  contextRecipe: 'inserted' | 'idempotent';
  revision: 'inserted' | 'idempotent';
}

/** Publishes the dependency first so a revision never points at a missing recipe. */
export class LocalTaskExecutionRevisionPublisher {
  constructor(
    private readonly recipes: LocalExecutionContextRecipeRepository,
    private readonly revisions: TaskExecutionRevisionRepository,
  ) {}

  async publish(
    command: PublishLocalTaskExecutionRevisionCommand,
  ): Promise<PublishLocalTaskExecutionRevisionResult> {
    if (command.revision.contextRef !== command.contextRecipe.contextRef) {
      throw new TypeError('Task revision contextRef does not match its recipe');
    }
    const contextRecipe = await this.recipes.insert(
      command.contextRecipe,
      command.createdAtMs,
    );
    const revision = await this.revisions.insert(
      command.revision,
      command.createdAtMs,
    );
    return { contextRecipe, revision };
  }
}
