import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
  type TaskDefinitionSource,
} from '../taskDefinition';

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type BoundedTaskReadProjection =
  | Readonly<{ found: false }>
  | Readonly<{
      found: true;
      taskId: string;
      revision: number;
      name: string;
      kind: TaskDefinitionRecord['kind'];
      specSchema: string;
      enabled: boolean;
      contentDigest: string;
      createdAtMs: number;
      updatedAtMs: number;
    }>;

export class InvalidBoundedTaskReadProjectionError extends TypeError {
  readonly code = 'BOUNDED_TASK_READ_PROJECTION_INVALID';

  constructor() {
    super('Bounded Task read projection input is invalid');
    this.name = 'InvalidBoundedTaskReadProjectionError';
  }
}

export class BoundedTaskReadProjectionUnavailableError extends Error {
  readonly code = 'BOUNDED_TASK_READ_PROJECTION_UNAVAILABLE';

  constructor() {
    super('Bounded Task read projection is unavailable');
    this.name = 'BoundedTaskReadProjectionUnavailableError';
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 128 &&
    !CONTROL_PATTERN.test(value)
  );
}

export async function executeBoundedTaskReadProjection(
  source: Pick<TaskDefinitionSource, 'findCurrentTaskDefinition'>,
  projectId: string,
  taskId: string,
): Promise<Readonly<BoundedTaskReadProjection>> {
  if (
    !source ||
    typeof source.findCurrentTaskDefinition !== 'function' ||
    !identifier(projectId) ||
    !identifier(taskId)
  ) {
    throw new InvalidBoundedTaskReadProjectionError();
  }

  let definition: TaskDefinitionRecord | null;
  try {
    definition = await source.findCurrentTaskDefinition(projectId, taskId);
  } catch {
    throw new BoundedTaskReadProjectionUnavailableError();
  }
  if (!definition) return Object.freeze({ found: false });

  let current: TaskDefinitionRecord;
  try {
    current = normalizeTaskDefinitionRecord(definition);
  } catch {
    throw new BoundedTaskReadProjectionUnavailableError();
  }
  if (current.projectId !== projectId || current.taskId !== taskId) {
    return Object.freeze({ found: false });
  }

  return Object.freeze({
    found: true,
    taskId: current.taskId,
    revision: current.revision,
    name: current.name,
    kind: current.kind,
    specSchema: current.spec.schema,
    enabled: current.enabled,
    contentDigest: current.contentDigest,
    createdAtMs: current.createdAtMs,
    updatedAtMs: current.updatedAtMs,
  });
}
