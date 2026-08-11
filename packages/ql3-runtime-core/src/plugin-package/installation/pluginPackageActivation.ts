import {
  InvalidPluginPackageInstallError,
  MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallUnavailableError,
  assertPluginPackageInstallMatchesLock,
  normalizePluginPackageActivationReceipt,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageLock,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallCommit,
  transitionPluginPackageInstall,
  type PluginPackageActivationReceipt,
  type PluginPackageInstallRecord,
  type PluginPackageInstallRepository,
  type PluginPackageLock,
} from './pluginPackageInstall';
import {
  createPluginPackageResourceGenerationFromReferences,
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGeneration,
} from '../pluginPackageResourceGeneration';

export const PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA =
  'qinglong/plugin-package-activation-intent@v2' as const;

export interface PluginPackageActivationIntent {
  readonly schema: typeof PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA;
  readonly installationId: string;
  readonly projectId: string;
  readonly packageName: string;
  readonly lockDigest: string;
  readonly targetGeneration: number;
  readonly previousActiveLockDigest: string | null;
  readonly stageRef: string;
  readonly stageReceiptDigest: string;
  readonly stageEvidenceDigest: string;
  readonly contentDigest: string;
  readonly resourceGeneration: Readonly<PluginPackageResourceGeneration>;
  readonly intentDigest: string;
}

export type PluginPackageActivationObservation =
  | Readonly<{ status: 'not_published' }>
  | Readonly<{
      status: 'published';
      receipt: Readonly<PluginPackageActivationReceipt>;
    }>;

export interface PluginPackageActivationPublisher {
  inspect(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationObservation>>;
  publish(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationReceipt>>;
}

export interface ActivatePluginPackageOptions {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly activationStartedMutationId: string;
  readonly activationCommittedMutationId: string;
  readonly startedAtMs: number;
}

export interface InspectPluginPackageActivationOptions {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly activationCommittedMutationId: string;
  readonly activationFailedMutationId: string;
  readonly observedAtMs: number;
}

export class PluginPackageActivationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_ACTIVATION_CONFLICT';

  constructor() {
    super('Plugin Package activation fact conflicts with durable intent');
    this.name = 'PluginPackageActivationConflictError';
  }
}

export class PluginPackageActivationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_ACTIVATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package activation authority is unavailable', options);
    this.name = 'PluginPackageActivationUnavailableError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageInstallError(`${label} must be an object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new InvalidPluginPackageInstallError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageInstallError(`${label} shape is invalid`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  return value;
}

function normalizeIdentity(value: {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
}): Readonly<{
  projectId: string;
  packageName: string;
  installationId: string;
}> {
  const projectId = identifier(value.projectId, 'project id');
  const packageName = value.packageName;
  if (
    typeof packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(packageName)
  ) {
    throw new InvalidPluginPackageInstallError('package name is invalid');
  }
  return Object.freeze({
    projectId,
    packageName,
    installationId: identifier(value.installationId, 'installation id'),
  });
}

export function createPluginPackageActivationIntent(
  lockValue: PluginPackageLock,
  recordValue: PluginPackageInstallRecord,
): Readonly<PluginPackageActivationIntent> {
  const lock = normalizePluginPackageLock(lockValue);
  const record = normalizePluginPackageInstallRecord(recordValue);
  const intentDigest = pluginPackageActivationIntentDigest(lock, record);
  if (record.stageReceipt === null) {
    throw new PluginPackageInstallTransitionConflictError();
  }
  const resourceGeneration =
    createPluginPackageResourceGenerationFromReferences({
      installationId: record.installationId,
      projectId: record.projectId,
      packageName: record.packageName,
      lockDigest: lock.lockDigest,
      generation: lock.targetGeneration,
      previousActiveLockDigest: record.previousActiveLockDigest,
      contentDigest: lock.source.contentDigest,
      resources: lock.resources,
    });
  return Object.freeze({
    schema: PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
    installationId: record.installationId,
    projectId: record.projectId,
    packageName: record.packageName,
    lockDigest: lock.lockDigest,
    targetGeneration: lock.targetGeneration,
    previousActiveLockDigest: record.previousActiveLockDigest,
    stageRef: record.stageReceipt.stageRef,
    stageReceiptDigest: record.stageReceipt.receiptDigest,
    stageEvidenceDigest: record.stageReceipt.evidenceDigest,
    contentDigest: lock.source.contentDigest,
    resourceGeneration,
    intentDigest,
  });
}

export function normalizePluginPackageActivationIntent(
  value: unknown,
): Readonly<PluginPackageActivationIntent> {
  const intent = dataRecord(value, 'activation intent');
  exactKeys(
    intent,
    [
      'schema',
      'installationId',
      'projectId',
      'packageName',
      'lockDigest',
      'targetGeneration',
      'previousActiveLockDigest',
      'stageRef',
      'stageReceiptDigest',
      'stageEvidenceDigest',
      'contentDigest',
      'resourceGeneration',
      'intentDigest',
    ],
    'activation intent',
  );
  if (intent.schema !== PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA) {
    throw new InvalidPluginPackageInstallError(
      'activation intent schema is invalid',
    );
  }
  const identity = normalizeIdentity({
    projectId: intent.projectId as string,
    packageName: intent.packageName as string,
    installationId: intent.installationId as string,
  });
  const targetGeneration = timestamp(
    intent.targetGeneration,
    'activation target generation',
  );
  if (
    targetGeneration < 1 ||
    targetGeneration > MAX_PLUGIN_PACKAGE_INSTALL_VERSION
  ) {
    throw new InvalidPluginPackageInstallError(
      'activation target generation is invalid',
    );
  }
  const previousActiveLockDigest =
    intent.previousActiveLockDigest === null
      ? null
      : digest(
          intent.previousActiveLockDigest,
          'activation previous lock digest',
        );
  const lockDigest = digest(intent.lockDigest, 'activation lock digest');
  const contentDigest = digest(
    intent.contentDigest,
    'activation content digest',
  );
  const resourceGeneration = normalizePluginPackageResourceGeneration(
    intent.resourceGeneration,
  );
  if (
    resourceGeneration.installationId !== identity.installationId ||
    resourceGeneration.projectId !== identity.projectId ||
    resourceGeneration.packageName !== identity.packageName ||
    resourceGeneration.lockDigest !== lockDigest ||
    resourceGeneration.generation !== targetGeneration ||
    resourceGeneration.previousActiveLockDigest !== previousActiveLockDigest ||
    resourceGeneration.contentDigest !== contentDigest
  ) {
    throw new InvalidPluginPackageInstallError(
      'activation resource generation does not match its intent',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_ACTIVATION_INTENT_SCHEMA,
    ...identity,
    lockDigest,
    targetGeneration,
    previousActiveLockDigest,
    stageRef: identifier(intent.stageRef, 'activation stage reference'),
    stageReceiptDigest: digest(
      intent.stageReceiptDigest,
      'activation stage receipt digest',
    ),
    stageEvidenceDigest: digest(
      intent.stageEvidenceDigest,
      'activation stage evidence digest',
    ),
    contentDigest,
    resourceGeneration,
    intentDigest: digest(intent.intentDigest, 'activation intent digest'),
  });
}

function normalizePublishedReceipt(
  intent: Readonly<PluginPackageActivationIntent>,
  value: PluginPackageActivationReceipt,
): Readonly<PluginPackageActivationReceipt> {
  const receipt = normalizePluginPackageActivationReceipt(value);
  if (
    receipt.intentDigest !== intent.intentDigest ||
    receipt.generation !== intent.targetGeneration ||
    receipt.contentDigest !== intent.contentDigest
  ) {
    throw new PluginPackageActivationConflictError();
  }
  return receipt;
}

function normalizeObservation(
  intent: Readonly<PluginPackageActivationIntent>,
  value: PluginPackageActivationObservation,
): Readonly<PluginPackageActivationObservation> {
  const observation = dataRecord(value, 'activation observation');
  if (observation.status === 'not_published') {
    exactKeys(observation, ['status'], 'activation observation');
    return Object.freeze({ status: 'not_published' });
  }
  if (observation.status === 'published') {
    exactKeys(observation, ['status', 'receipt'], 'activation observation');
    return Object.freeze({
      status: 'published',
      receipt: normalizePublishedReceipt(
        intent,
        (
          value as Extract<
            PluginPackageActivationObservation,
            { status: 'published' }
          >
        ).receipt,
      ),
    });
  }
  throw new InvalidPluginPackageInstallError(
    'activation observation status is invalid',
  );
}

function unavailable(error: unknown): PluginPackageActivationUnavailableError {
  if (error instanceof PluginPackageActivationUnavailableError) return error;
  return new PluginPackageActivationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class PluginPackageActivationCoordinator {
  readonly #repository: PluginPackageInstallRepository;
  readonly #publisher: PluginPackageActivationPublisher;

  constructor(options: {
    readonly repository: PluginPackageInstallRepository;
    readonly publisher: PluginPackageActivationPublisher;
  }) {
    const value = dataRecord(options, 'activation coordinator options');
    exactKeys(
      value,
      ['repository', 'publisher'],
      'activation coordinator options',
    );
    if (
      !options.repository ||
      typeof options.repository.find !== 'function' ||
      typeof options.repository.findLock !== 'function' ||
      typeof options.repository.commit !== 'function' ||
      !options.publisher ||
      typeof options.publisher.inspect !== 'function' ||
      typeof options.publisher.publish !== 'function'
    ) {
      throw new InvalidPluginPackageInstallError(
        'activation coordinator authority is invalid',
      );
    }
    this.#repository = options.repository;
    this.#publisher = options.publisher;
  }

  async #load(
    identity: Readonly<{
      projectId: string;
      packageName: string;
      installationId: string;
    }>,
  ): Promise<
    Readonly<{
      lock: Readonly<PluginPackageLock>;
      record: Readonly<PluginPackageInstallRecord>;
    }>
  > {
    const record = await this.#repository.find(
      identity.projectId,
      identity.packageName,
    );
    if (!record || record.installationId !== identity.installationId) {
      throw new PluginPackageInstallTransitionConflictError();
    }
    const lock = await this.#repository.findLock(record.lockDigest);
    if (!lock) throw new PluginPackageInstallUnavailableError();
    assertPluginPackageInstallMatchesLock(lock, record);
    return Object.freeze({ lock, record });
  }

  async #commitPublished(
    lock: Readonly<PluginPackageLock>,
    record: Readonly<PluginPackageInstallRecord>,
    receipt: Readonly<PluginPackageActivationReceipt>,
    mutationId: string,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const next = transitionPluginPackageInstall(lock, record, {
      type: 'activation_committed',
      mutationId,
      occurredAtMs: receipt.activatedAtMs,
      activationRef: receipt.activationRef,
      intentDigest: receipt.intentDigest,
      generation: receipt.generation,
      contentDigest: receipt.contentDigest,
    });
    return (
      await this.#repository.commit(pluginPackageInstallCommit(record, next))
    ).record;
  }

  async #commitFailure(
    lock: Readonly<PluginPackageLock>,
    record: Readonly<PluginPackageInstallRecord>,
    mutationId: string,
    occurredAtMs: number,
    reason: 'activation_failed' | 'activation_fact_conflict',
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const next = transitionPluginPackageInstall(lock, record, {
      type: 'failed',
      mutationId,
      occurredAtMs,
      reason,
    });
    return (
      await this.#repository.commit(pluginPackageInstallCommit(record, next))
    ).record;
  }

  async activate(
    options: ActivatePluginPackageOptions,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const value = dataRecord(options, 'activation options');
    exactKeys(
      value,
      [
        'projectId',
        'packageName',
        'installationId',
        'activationStartedMutationId',
        'activationCommittedMutationId',
        'startedAtMs',
      ],
      'activation options',
    );
    const identity = normalizeIdentity(options);
    const activationStartedMutationId = identifier(
      options.activationStartedMutationId,
      'activation started mutation id',
    );
    const activationCommittedMutationId = identifier(
      options.activationCommittedMutationId,
      'activation committed mutation id',
    );
    const startedAtMs = timestamp(options.startedAtMs, 'activation start time');
    const loaded = await this.#load(identity);
    if (loaded.record.state !== 'staged') {
      if (
        loaded.record.state === 'active' ||
        loaded.record.state === 'failed'
      ) {
        return loaded.record;
      }
      throw new PluginPackageInstallTransitionConflictError();
    }
    const activating = transitionPluginPackageInstall(
      loaded.lock,
      loaded.record,
      {
        type: 'activation_started',
        mutationId: activationStartedMutationId,
        occurredAtMs: startedAtMs,
      },
    );
    const durable = (
      await this.#repository.commit(
        pluginPackageInstallCommit(loaded.record, activating),
      )
    ).record;
    if (durable.state === 'active' || durable.state === 'failed')
      return durable;
    if (durable.state !== 'activating') {
      throw new PluginPackageInstallTransitionConflictError();
    }
    const intent = createPluginPackageActivationIntent(loaded.lock, durable);
    let receipt: Readonly<PluginPackageActivationReceipt>;
    try {
      receipt = normalizePublishedReceipt(
        intent,
        await this.#publisher.publish(intent),
      );
    } catch (error) {
      if (error instanceof PluginPackageActivationConflictError) {
        return this.#commitFailure(
          loaded.lock,
          durable,
          activationCommittedMutationId,
          startedAtMs,
          'activation_fact_conflict',
        );
      }
      throw unavailable(error);
    }
    return this.#commitPublished(
      loaded.lock,
      durable,
      receipt,
      activationCommittedMutationId,
    );
  }

  async inspect(
    options: InspectPluginPackageActivationOptions,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const value = dataRecord(options, 'activation inspection options');
    exactKeys(
      value,
      [
        'projectId',
        'packageName',
        'installationId',
        'activationCommittedMutationId',
        'activationFailedMutationId',
        'observedAtMs',
      ],
      'activation inspection options',
    );
    const identity = normalizeIdentity(options);
    const activationCommittedMutationId = identifier(
      options.activationCommittedMutationId,
      'activation committed mutation id',
    );
    const activationFailedMutationId = identifier(
      options.activationFailedMutationId,
      'activation failed mutation id',
    );
    const observedAtMs = timestamp(options.observedAtMs, 'observation time');
    const loaded = await this.#load(identity);
    if (loaded.record.state === 'active' || loaded.record.state === 'failed') {
      return loaded.record;
    }
    if (loaded.record.state !== 'activating') {
      throw new PluginPackageInstallTransitionConflictError();
    }
    const intent = createPluginPackageActivationIntent(
      loaded.lock,
      loaded.record,
    );
    let observation: Readonly<PluginPackageActivationObservation>;
    try {
      observation = normalizeObservation(
        intent,
        await this.#publisher.inspect(intent),
      );
    } catch (error) {
      if (error instanceof PluginPackageActivationConflictError) {
        return this.#commitFailure(
          loaded.lock,
          loaded.record,
          activationFailedMutationId,
          observedAtMs,
          'activation_fact_conflict',
        );
      }
      throw unavailable(error);
    }
    if (observation.status === 'not_published') {
      return this.#commitFailure(
        loaded.lock,
        loaded.record,
        activationFailedMutationId,
        observedAtMs,
        'activation_failed',
      );
    }
    return this.#commitPublished(
      loaded.lock,
      loaded.record,
      observation.receipt,
      activationCommittedMutationId,
    );
  }
}
