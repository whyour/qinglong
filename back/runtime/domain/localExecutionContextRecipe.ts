import { createHash } from 'crypto';
import { MAX_EXECUTION_ENVIRONMENT_ENTRIES } from './executionContext';

export const MAX_LOCAL_CONTEXT_REF_LENGTH = 512;
export const MAX_LOCAL_SECRET_REF_LENGTH = 512;

export type LocalExecutionEnvironmentBinding =
  | {
      name: string;
      kind: 'public';
      value: string;
    }
  | {
      name: string;
      kind: 'secret';
      secretRef: string;
    };

export interface LocalExecutionContextRecipe {
  contextRef: string;
  environment: readonly LocalExecutionEnvironmentBinding[];
}

export interface LocalExecutionContextRecipeRecord
  extends LocalExecutionContextRecipe {
  contentDigest: string;
  createdAtMs: number;
}

function assertBoundedText(name: string, value: string, maximum: number): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertEnvironmentName(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    value.includes('=') ||
    value.includes('\0')
  ) {
    throw new TypeError('Local context environment name is invalid');
  }
}

export function assertLocalExecutionContextRef(value: string): void {
  assertBoundedText(
    'Local execution contextRef',
    value,
    MAX_LOCAL_CONTEXT_REF_LENGTH,
  );
}

export function normalizeLocalExecutionContextRecipe(
  recipe: LocalExecutionContextRecipe,
): LocalExecutionContextRecipe {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new TypeError('Local execution context recipe must be an object');
  }
  assertLocalExecutionContextRef(recipe.contextRef);
  if (!Array.isArray(recipe.environment)) {
    throw new TypeError('Local context environment bindings must be an array');
  }
  if (recipe.environment.length > MAX_EXECUTION_ENVIRONMENT_ENTRIES) {
    throw new RangeError('Local context has too many environment bindings');
  }
  const names = new Set<string>();
  const environment = recipe.environment
    .map((binding) => {
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
        throw new TypeError('Local context environment binding is invalid');
      }
      assertEnvironmentName(binding.name);
      if (names.has(binding.name)) {
        throw new TypeError('Local context environment binding is duplicated');
      }
      names.add(binding.name);
      if (binding.kind === 'public') {
        if (typeof binding.value !== 'string' || binding.value.includes('\0')) {
          throw new TypeError('Local public environment value is invalid');
        }
        return Object.freeze({
          name: binding.name,
          kind: 'public' as const,
          value: binding.value,
        });
      }
      if (binding.kind === 'secret') {
        assertBoundedText(
          'Local environment secretRef',
          binding.secretRef,
          MAX_LOCAL_SECRET_REF_LENGTH,
        );
        return Object.freeze({
          name: binding.name,
          kind: 'secret' as const,
          secretRef: binding.secretRef,
        });
      }
      throw new TypeError('Local context environment binding kind is invalid');
    })
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  return Object.freeze({
    contextRef: recipe.contextRef,
    environment: Object.freeze(environment),
  });
}

function environmentDigest(
  environment: readonly LocalExecutionEnvironmentBinding[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(environment), 'utf8')
    .digest('hex');
}

export function createLocalExecutionContextRecipe(
  environment: readonly LocalExecutionEnvironmentBinding[],
): LocalExecutionContextRecipe {
  const placeholder = normalizeLocalExecutionContextRecipe({
    contextRef: 'localctx:pending',
    environment,
  });
  return normalizeLocalExecutionContextRecipe({
    contextRef: `localctx:sha256:${environmentDigest(placeholder.environment)}`,
    environment: placeholder.environment,
  });
}

export function localExecutionContextRecipeDigest(
  recipe: LocalExecutionContextRecipe,
): string {
  const normalized = normalizeLocalExecutionContextRecipe(recipe);
  return createHash('sha256')
    .update(JSON.stringify(normalized), 'utf8')
    .digest('hex');
}

export function assertContentAddressedLocalExecutionContextRecipe(
  recipe: LocalExecutionContextRecipe,
): void {
  const normalized = normalizeLocalExecutionContextRecipe(recipe);
  const expected = createLocalExecutionContextRecipe(normalized.environment);
  if (normalized.contextRef !== expected.contextRef) {
    throw new TypeError(
      'Local execution context recipe is not content-addressed',
    );
  }
}

export function createLocalExecutionContextRecipeRecord(
  recipe: LocalExecutionContextRecipe,
  createdAtMs: number,
): LocalExecutionContextRecipeRecord {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new RangeError('createdAtMs must be a non-negative safe integer');
  }
  const normalized = normalizeLocalExecutionContextRecipe(recipe);
  assertContentAddressedLocalExecutionContextRecipe(normalized);
  return Object.freeze({
    ...normalized,
    contentDigest: localExecutionContextRecipeDigest(normalized),
    createdAtMs,
  });
}
