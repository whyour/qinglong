import {
  PrivateLocalCommandFileError,
  readPrivateLocalCommandFile,
} from '@qinglong/local-command-file';
import {
  installLocalOwnerCredentialPresentation,
  LocalOwnerSecretDeliveryError,
  openLocalOwnerConsole,
  type ClaimLocalOwnerFromDeliveriesRequest,
  type LocalOwnerConsole,
  type LocalOwnerSecretDeliverySummary,
  type OpenLocalOwnerConsoleOptions,
} from '@qinglong/local-owner-console';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface ProvisionLocalOwnerIdentityCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.identity.provision';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly mutationId: string;
    readonly requestId: string;
    readonly credentialTtlMs?: number;
  };
}

export interface IssueLocalOwnerChallengeCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.challenge.issue';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly projectId: string;
    readonly mutationId: string;
    readonly requestId: string;
    readonly ttlMs?: number;
  };
}

export interface ClaimLocalOwnerCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.claim.from-deliveries';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: ClaimLocalOwnerFromDeliveriesRequest;
}

export interface InspectLocalOwnerDeliveryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.delivery.inspect';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly kind: 'credential' | 'challenge';
    readonly mutationId: string;
  };
}

export type LocalOwnerDeliveryPurpose =
  | 'credential-provisioning'
  | 'credential-recovery'
  | 'challenge';

export interface AcknowledgeLocalOwnerDeliveryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.delivery.acknowledge';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly purpose: LocalOwnerDeliveryPurpose;
    readonly mutationId: string;
    readonly expectedDeliveryDigest: string;
  };
}

export interface InstallLocalOwnerCredentialPresentationCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.credential-presentation.install-from-delivery';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly credentialMutationId: string;
    readonly destinationFilePath: string;
  };
}

export interface IssueLocalOwnerCredentialRecoveryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.credential-recovery.issue';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly mutationId: string;
    readonly requestId: string;
    readonly previousCredentialId: string;
    readonly expectedPreviousVersion: number;
    readonly credentialTtlMs?: number;
  };
}

export interface CompleteLocalOwnerCredentialRecoveryCommand {
  readonly schemaVersion: 1;
  readonly operation: 'owner.credential-recovery.complete';
  readonly options: OpenLocalOwnerConsoleOptions;
  readonly request: {
    readonly issueMutationId: string;
    readonly mutationId: string;
    readonly requestId: string;
  };
}

export type LocalOwnerCommand =
  | ProvisionLocalOwnerIdentityCommand
  | IssueLocalOwnerChallengeCommand
  | ClaimLocalOwnerCommand
  | InspectLocalOwnerDeliveryCommand
  | AcknowledgeLocalOwnerDeliveryCommand
  | InstallLocalOwnerCredentialPresentationCommand
  | IssueLocalOwnerCredentialRecoveryCommand
  | CompleteLocalOwnerCredentialRecoveryCommand;

export interface LocalOwnerCommandRunnerDependencies {
  readonly openConsole: typeof openLocalOwnerConsole;
}

export interface LocalOwnerCommandRunner {
  run(commandFilePath: string): Promise<Readonly<LocalOwnerCommandResult>>;
}

export type LocalOwnerCommandResult = Readonly<
  Record<string, unknown> & {
    readonly schemaVersion: 1;
    readonly operation: LocalOwnerCommand['operation'];
  }
>;

export class LocalOwnerCliConfigurationError extends TypeError {
  readonly code = 'LOCAL_OWNER_CLI_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Owner CLI configuration is invalid: ${message}`);
    this.name = 'LocalOwnerCliConfigurationError';
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

function normalizeCommand(value: unknown): Readonly<LocalOwnerCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'operation', 'options', 'request'])
  ) {
    throw new LocalOwnerCliConfigurationError('command shape is invalid');
  }
  const candidate = value as Record<string, unknown>;
  const operations: readonly LocalOwnerCommand['operation'][] = [
    'owner.identity.provision',
    'owner.challenge.issue',
    'owner.claim.from-deliveries',
    'owner.delivery.inspect',
    'owner.delivery.acknowledge',
    'owner.credential-presentation.install-from-delivery',
    'owner.credential-recovery.issue',
    'owner.credential-recovery.complete',
  ];
  if (
    candidate.schemaVersion !== 1 ||
    !operations.includes(
      candidate.operation as LocalOwnerCommand['operation'],
    ) ||
    !candidate.options ||
    typeof candidate.options !== 'object' ||
    Array.isArray(candidate.options) ||
    !candidate.request ||
    typeof candidate.request !== 'object' ||
    Array.isArray(candidate.request)
  ) {
    throw new LocalOwnerCliConfigurationError('command value is invalid');
  }
  return Object.freeze(value as LocalOwnerCommand);
}

function readCommandFile(candidatePath: string): Readonly<LocalOwnerCommand> {
  try {
    return normalizeCommand(readPrivateLocalCommandFile(candidatePath));
  } catch (error) {
    if (error instanceof LocalOwnerCliConfigurationError) throw error;
    if (error instanceof PrivateLocalCommandFileError) {
      throw new LocalOwnerCliConfigurationError(
        'command file cannot be read',
        error,
      );
    }
    throw new LocalOwnerCliConfigurationError(
      'command file cannot be read',
      error,
    );
  }
}

function validateDeliveryRequest(
  value: InspectLocalOwnerDeliveryCommand['request'],
): void {
  if (
    !exactKeys(value, ['kind', 'mutationId']) ||
    (value.kind !== 'credential' && value.kind !== 'challenge') ||
    !UUID_V4_PATTERN.test(value.mutationId)
  ) {
    throw new LocalOwnerCliConfigurationError(
      'delivery inspect request is invalid',
    );
  }
}

function validateAcknowledgementRequest(
  value: AcknowledgeLocalOwnerDeliveryCommand['request'],
): void {
  if (
    !exactKeys(value, ['purpose', 'mutationId', 'expectedDeliveryDigest']) ||
    !['credential-provisioning', 'credential-recovery', 'challenge'].includes(
      value.purpose,
    ) ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    !DIGEST_PATTERN.test(value.expectedDeliveryDigest)
  ) {
    throw new LocalOwnerCliConfigurationError(
      'delivery acknowledgement request is invalid',
    );
  }
}

function validatePresentationInstallRequest(
  value: InstallLocalOwnerCredentialPresentationCommand['request'],
): void {
  if (
    !exactKeys(value, ['credentialMutationId', 'destinationFilePath']) ||
    !UUID_V4_PATTERN.test(value.credentialMutationId) ||
    typeof value.destinationFilePath !== 'string'
  ) {
    throw new LocalOwnerCliConfigurationError(
      'credential presentation install request is invalid',
    );
  }
}

function missing(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if ('code' in current && current.code === 'ENOENT') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function deliveryAfterMutation(
  status: 'inserted' | 'existing',
  inspect: () => Readonly<LocalOwnerSecretDeliverySummary>,
): Readonly<LocalOwnerSecretDeliverySummary> | null {
  try {
    return inspect();
  } catch (error) {
    if (
      status === 'existing' &&
      error instanceof LocalOwnerSecretDeliveryError &&
      missing(error)
    ) {
      return null;
    }
    throw error;
  }
}

function dependencies(
  value: LocalOwnerCommandRunnerDependencies,
): Readonly<LocalOwnerCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['openConsole']) ||
    typeof value.openConsole !== 'function'
  ) {
    throw new LocalOwnerCliConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

async function execute(
  console: LocalOwnerConsole,
  command: Readonly<LocalOwnerCommand>,
): Promise<Readonly<LocalOwnerCommandResult>> {
  switch (command.operation) {
    case 'owner.identity.provision': {
      const result = await console.service.provision(command.request);
      const delivery = deliveryAfterMutation(result.status, () =>
        console.inspectCredentialDelivery(command.request.mutationId),
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        subjectId: result.subjectId,
        credentialId: result.credentialId,
        expiresAtMs: result.expiresAtMs,
        delivery,
      });
    }
    case 'owner.challenge.issue': {
      const result = await console.service.issue(command.request);
      const delivery = deliveryAfterMutation(result.status, () =>
        console.inspectChallengeDelivery(command.request.mutationId),
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        challengeId: result.challengeId,
        expiresAtMs: result.expiresAtMs,
        delivery,
      });
    }
    case 'owner.claim.from-deliveries': {
      const result = await console.claimOwnerFromDeliveries(command.request);
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        projectId: result.challenge.projectId,
        challengeId: result.challenge.challengeId,
        subject: result.binding.subject,
        role: result.binding.role,
        bindingVersion: result.binding.version,
        claimedAtMs: result.challenge.consumedAtMs,
      });
    }
    case 'owner.delivery.inspect': {
      validateDeliveryRequest(command.request);
      const delivery =
        command.request.kind === 'credential'
          ? console.inspectCredentialDelivery(command.request.mutationId)
          : console.inspectChallengeDelivery(command.request.mutationId);
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        delivery,
      });
    }
    case 'owner.delivery.acknowledge': {
      validateAcknowledgementRequest(command.request);
      const acknowledgement =
        command.request.purpose === 'credential-provisioning'
          ? await console.acknowledgeCredentialDelivery(
              command.request.mutationId,
              command.request.expectedDeliveryDigest,
            )
          : command.request.purpose === 'credential-recovery'
          ? await console.acknowledgeCredentialRecoveryDelivery(
              command.request.mutationId,
              command.request.expectedDeliveryDigest,
            )
          : await console.acknowledgeChallengeDelivery(
              command.request.mutationId,
              command.request.expectedDeliveryDigest,
            );
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        purpose: command.request.purpose,
        kind: acknowledgement.kind,
        state: acknowledgement.state,
        mutationId: acknowledgement.mutationId,
        requestId: acknowledgement.requestId,
        ttlMs: acknowledgement.ttlMs,
      });
    }
    case 'owner.credential-presentation.install-from-delivery': {
      validatePresentationInstallRequest(command.request);
      const result = installLocalOwnerCredentialPresentation({
        deploymentRoot: command.options.deploymentRoot,
        deliveryFilePath: console.credentialDeliveryPath(
          command.request.credentialMutationId,
        ),
        destinationFilePath: command.request.destinationFilePath,
      });
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        credentialMutationId: result.credentialMutationId,
      });
    }
    case 'owner.credential-recovery.issue': {
      const result = await console.credentialRecovery.issue(command.request);
      const delivery = deliveryAfterMutation(result.status, () =>
        console.inspectCredentialDelivery(command.request.mutationId),
      );
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        subjectId: result.subjectId,
        previousCredentialId: result.previousCredentialId,
        replacementCredentialId: result.replacementCredentialId,
        expiresAtMs: result.expiresAtMs,
        state: result.state,
        delivery,
      });
    }
    case 'owner.credential-recovery.complete': {
      const result = await console.credentialRecovery.complete(command.request);
      return Object.freeze({
        schemaVersion: 1 as const,
        operation: command.operation,
        status: result.status,
        previousCredentialId: result.previousCredentialId,
        replacementCredentialId: result.replacementCredentialId,
        state: result.state,
      });
    }
  }
}

export function createLocalOwnerCommandRunner(
  candidateDependencies: LocalOwnerCommandRunnerDependencies = {
    openConsole: openLocalOwnerConsole,
  },
): LocalOwnerCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const console = await adapters.openConsole(command.options);
      try {
        return await execute(console, command);
      } finally {
        await console.close();
      }
    },
  });
}

export function runLocalOwnerCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalOwnerCommandResult>> {
  return createLocalOwnerCommandRunner().run(commandFilePath);
}
