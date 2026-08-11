import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  openLocalOwnerDeliveryAcknowledgementGc,
  type CompactLocalOwnerDeliveryAcknowledgementRequest,
  type OpenLocalOwnerDeliveryAcknowledgementGcOptions,
} from '../security-maintenance/acknowledgementGc';
import {
  openLocalOwnerPepperMaterialGc,
  type CollectLocalOwnerPepperMaterialRequest,
  type OpenLocalOwnerPepperMaterialGcOptions,
} from '../security-maintenance/pepperGc';
import type {
  LocalOwnerPromptOutputGcAuthority,
  OpenLocalOwnerPromptOutputGcOptions,
} from '../prompt-output-maintenance/promptOutputGc';
import type {
  LocalOwnerPromptOutputKeyRetirementAuthority,
  OpenLocalOwnerPromptOutputKeyRetirementOptions,
  RetireLocalOwnerPromptOutputKeyRequest,
} from '../prompt-output-maintenance/promptOutputKeyRetirement';

export interface LocalOwnerAcknowledgementGcCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.delivery-acknowledgement.compact';
  readonly options: OpenLocalOwnerDeliveryAcknowledgementGcOptions;
  readonly request: CompactLocalOwnerDeliveryAcknowledgementRequest;
}

export interface LocalOwnerPepperMaterialGcCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.pepper-material.collect';
  readonly options: OpenLocalOwnerPepperMaterialGcOptions;
  readonly request: CollectLocalOwnerPepperMaterialRequest;
}

export interface LocalOwnerPromptOutputGcCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.prompt-output.collect';
  readonly options: OpenLocalOwnerPromptOutputGcOptions;
  readonly request: Readonly<Record<string, never>>;
}

export interface LocalOwnerPromptOutputKeyRetirementCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.prompt-output-key.retire';
  readonly options: OpenLocalOwnerPromptOutputKeyRetirementOptions;
  readonly request: RetireLocalOwnerPromptOutputKeyRequest;
}

export type LocalOwnerGcCommand =
  | LocalOwnerAcknowledgementGcCommand
  | LocalOwnerPepperMaterialGcCommand
  | LocalOwnerPromptOutputGcCommand
  | LocalOwnerPromptOutputKeyRetirementCommand;

export interface LocalOwnerAcknowledgementGcCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'owner.delivery-acknowledgement.compact';
  readonly status: 'inserted' | 'existing';
  readonly gcMutationId: string;
  readonly acknowledgementMutationId: string;
  readonly acknowledgementKind: 'credential' | 'challenge';
  readonly retentionEligibleAtMs: number;
  readonly compactedAtMs: number;
}

export interface LocalOwnerPepperMaterialGcCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'owner.pepper-material.collect';
  readonly status: 'inserted' | 'existing';
  readonly prepareMutationId: string;
  readonly completeMutationId: string;
  readonly pepperKeyId: string;
  readonly state: 'completed';
  readonly completedAtMs: number;
}

export interface LocalOwnerPromptOutputGcCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'owner.prompt-output.collect';
  readonly scanned: number;
  readonly tombstoned: number;
  readonly skipped: number;
  readonly hasMore: boolean;
}

export interface LocalOwnerPromptOutputKeyRetirementCommandResult {
  readonly schemaVersion: 1;
  readonly operation: 'owner.prompt-output-key.retire';
  readonly status: 'completed' | 'existing';
  readonly keyId: string;
  readonly retirementId: string;
  readonly preparationDigest: string;
  readonly completionDigest: string;
  readonly completedAtMs: number;
}

export type LocalOwnerGcCommandResult =
  | LocalOwnerAcknowledgementGcCommandResult
  | LocalOwnerPepperMaterialGcCommandResult
  | LocalOwnerPromptOutputGcCommandResult
  | LocalOwnerPromptOutputKeyRetirementCommandResult;

export interface LocalOwnerGcCommandRunnerDependencies {
  readonly openAcknowledgementGc: typeof openLocalOwnerDeliveryAcknowledgementGc;
  readonly openPepperMaterialGc: typeof openLocalOwnerPepperMaterialGc;
  readonly openPromptOutputGc: (
    options: OpenLocalOwnerPromptOutputGcOptions,
  ) => Promise<LocalOwnerPromptOutputGcAuthority>;
  readonly openPromptOutputKeyRetirement: (
    options: OpenLocalOwnerPromptOutputKeyRetirementOptions,
  ) => Promise<LocalOwnerPromptOutputKeyRetirementAuthority>;
}

export interface LocalOwnerGcCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalOwnerGcCommandResult>>;
}

export class LocalOwnerGcCliConfigurationError extends TypeError {
  readonly code = 'LOCAL_OWNER_GC_CLI_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Owner GC CLI configuration is invalid: ${message}`);
    this.name = 'LocalOwnerGcCliConfigurationError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizeCommand(value: unknown): Readonly<LocalOwnerGcCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'operation', 'options', 'request'])
  ) {
    throw new LocalOwnerGcCliConfigurationError('command shape is invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    (candidate.operation !== 'owner.delivery-acknowledgement.compact' &&
      candidate.operation !== 'owner.pepper-material.collect' &&
      candidate.operation !== 'owner.prompt-output.collect' &&
      candidate.operation !== 'owner.prompt-output-key.retire') ||
    !candidate.options ||
    typeof candidate.options !== 'object' ||
    Array.isArray(candidate.options) ||
    !candidate.request ||
    typeof candidate.request !== 'object' ||
    Array.isArray(candidate.request)
  ) {
    throw new LocalOwnerGcCliConfigurationError('command value is invalid');
  }
  return Object.freeze(value as LocalOwnerGcCommand);
}

function readCommandFile(candidatePath: string): Readonly<LocalOwnerGcCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalOwnerGcCliConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalOwnerGcCliConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalOwnerGcCliConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function dependencies(
  value: LocalOwnerGcCommandRunnerDependencies,
): Readonly<LocalOwnerGcCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'openAcknowledgementGc',
      'openPepperMaterialGc',
      'openPromptOutputGc',
      'openPromptOutputKeyRetirement',
    ]) ||
    typeof value.openAcknowledgementGc !== 'function' ||
    typeof value.openPepperMaterialGc !== 'function' ||
    typeof value.openPromptOutputGc !== 'function' ||
    typeof value.openPromptOutputKeyRetirement !== 'function'
  ) {
    throw new LocalOwnerGcCliConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export function createLocalOwnerGcCommandRunner(
  candidateDependencies: LocalOwnerGcCommandRunnerDependencies = {
    openAcknowledgementGc: openLocalOwnerDeliveryAcknowledgementGc,
    openPepperMaterialGc: openLocalOwnerPepperMaterialGc,
    async openPromptOutputGc(options) {
      const { openLocalOwnerPromptOutputGc } = await import(
        '../prompt-output-maintenance/promptOutputGc.js'
      );
      return openLocalOwnerPromptOutputGc(options);
    },
    async openPromptOutputKeyRetirement(options) {
      const { openLocalOwnerPromptOutputKeyRetirement } = await import(
        '../prompt-output-maintenance/promptOutputKeyRetirement.js'
      );
      return openLocalOwnerPromptOutputKeyRetirement(options);
    },
  },
): LocalOwnerGcCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      if (command.operation === 'owner.delivery-acknowledgement.compact') {
        const authority = await adapters.openAcknowledgementGc(command.options);
        try {
          const result = await authority.compact(command.request);
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            gcMutationId: result.record.mutationId,
            acknowledgementMutationId: result.record.acknowledgementMutationId,
            acknowledgementKind: result.record.acknowledgementKind,
            retentionEligibleAtMs: result.record.retentionEligibleAtMs,
            compactedAtMs: result.record.compactedAtMs,
          });
        } finally {
          await authority.close();
        }
      }
      if (command.operation === 'owner.prompt-output.collect') {
        if (Object.keys(command.request).length !== 0) {
          throw new LocalOwnerGcCliConfigurationError(
            'Prompt output collection request must be empty',
          );
        }
        const authority = await adapters.openPromptOutputGc(command.options);
        try {
          const result = await authority.collect();
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            ...result,
          });
        } finally {
          await authority.close();
        }
      }
      if (command.operation === 'owner.prompt-output-key.retire') {
        const authority = await adapters.openPromptOutputKeyRetirement(
          command.options,
        );
        try {
          const result = await authority.retire(command.request);
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            ...result,
          });
        } finally {
          await authority.close();
        }
      }
      const authority = await adapters.openPepperMaterialGc(command.options);
      try {
        const result = await authority.collect(command.request);
        if (
          result.record.state !== 'completed' ||
          !result.record.completeMutationId ||
          result.record.completedAtMs === undefined
        ) {
          throw new LocalOwnerGcCliConfigurationError(
            'pepper material collection did not complete',
          );
        }
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: result.status,
          prepareMutationId: result.record.prepareMutationId,
          completeMutationId: result.record.completeMutationId,
          pepperKeyId: result.record.pepperKeyId,
          state: result.record.state,
          completedAtMs: result.record.completedAtMs,
        });
      } finally {
        await authority.close();
      }
    },
  });
}

export function runLocalOwnerGcCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalOwnerGcCommandResult>> {
  return createLocalOwnerGcCommandRunner().run(commandFilePath);
}
