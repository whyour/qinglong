/** Shared bounded process-configuration authority for cluster management planes. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_TLS_FILE_BYTES = 256 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type ClusterManagementProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterManagementProcessConfigurationFailure = (
  message: string,
) => Error;

export function boundedManagementEnvironmentValue(
  environment: ClusterManagementProcessEnvironment,
  name: string,
  maximumLength: number,
  failure: ClusterManagementProcessConfigurationFailure,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) throw failure(`${name} is required`);
    return undefined;
  }
  if (value.length > maximumLength || CONTROL_PATTERN.test(value)) {
    throw failure(`${name} is invalid`);
  }
  return value;
}

export function booleanManagementEnvironmentValue(
  environment: ClusterManagementProcessEnvironment,
  name: string,
  failure: ClusterManagementProcessConfigurationFailure,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw failure(`${name} must be true or false`);
}

export function integerManagementEnvironmentValue(
  environment: ClusterManagementProcessEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  failure: ClusterManagementProcessConfigurationFailure,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw failure(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw failure(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function absoluteManagementEnvironmentFile(
  environment: ClusterManagementProcessEnvironment,
  name: string,
  failure: ClusterManagementProcessConfigurationFailure,
): string {
  const value = boundedManagementEnvironmentValue(
    environment,
    name,
    4_096,
    failure,
    true,
  )!;
  if (!isAbsolute(value)) {
    throw failure(`${name} must be an absolute path`);
  }
  return value;
}

export function readManagementTlsFile(
  filePath: string,
  privateMaterial: boolean,
  failure: ClusterManagementProcessConfigurationFailure,
): Buffer {
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > MAX_TLS_FILE_BYTES ||
      (stat.mode & 0o022) !== 0 ||
      (privateMaterial && (stat.mode & 0o007) !== 0)
    ) {
      throw failure('TLS file authority is invalid');
    }
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(descriptor);
    if (
      offset !== stat.size ||
      offset > MAX_TLS_FILE_BYTES ||
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    ) {
      throw failure('TLS file changed while being read');
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (privateMaterial) bytes?.fill(0);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
