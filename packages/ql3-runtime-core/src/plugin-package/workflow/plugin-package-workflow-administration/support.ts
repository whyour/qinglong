import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '../../../security/security';

import { InvalidPluginPackageWorkflowAdministrationMutationError } from './errors';

export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

export function sameSubject(
  left: Readonly<SecuritySubject>,
  right: Readonly<SecuritySubject>,
): boolean {
  return left.type === right.type && left.id === right.id;
}

export function normalizeFence(
  value: SecurityPolicyFence,
): SecurityPolicyFence {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['bindingVersion', 'projectVersion']) ||
    !Number.isSafeInteger(value.projectVersion) ||
    value.projectVersion < 1 ||
    !Number.isSafeInteger(value.bindingVersion) ||
    (value.bindingVersion as number) < 1
  ) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'authorization fence is invalid',
    );
  }
  return Object.freeze({
    projectVersion: value.projectVersion,
    bindingVersion: value.bindingVersion,
  });
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'packageName is invalid',
    );
  }
  return value;
}

export function resourceId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      `${label} is invalid`,
    );
  }
  return value;
}

export function nullableTimestamp(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidPluginPackageWorkflowAdministrationMutationError(
      'run inspection timestamp is invalid',
    );
  }
  return value as number;
}
