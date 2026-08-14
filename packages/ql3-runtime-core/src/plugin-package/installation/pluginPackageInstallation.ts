import {
  PluginPackageActivationCoordinator,
  type PluginPackageActivationPublisher,
} from './pluginPackageActivation';
import {
  InvalidPluginPackageInstallError,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallUnavailableError,
  assertPluginPackageInstallMatchesLock,
  normalizePluginPackageLock,
  pluginPackageInstallCommit,
  transitionPluginPackageInstall,
  type PluginPackageInstallRecord,
  type PluginPackageLock,
} from './pluginPackageInstall';
import type { PluginPackageAdmissionRepository } from './pluginPackageAdmission';
import type { ApprovedActionExecutionRecord } from '../../approved-action/approvedActionExecution';
import type { SecurityAuditRecord } from '../../security/audit/securityAudit';

export interface PluginPackageStageEvidence {
  readonly stageRef: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly contentDigest: string;
  readonly evidenceDigest: string;
}

export interface PluginPackageStageProvider {
  /**
   * Produces or re-opens one exact content-addressed stage. A thrown
   * availability error leaves the durable install queued for explicit retry.
   */
  stage(
    lock: Readonly<PluginPackageLock>,
  ): Promise<Readonly<PluginPackageStageEvidence>>;
}

export type PluginPackageActivationPrerequisiteObservation =
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'deferred';
      reason: 'secret_binding_transition_required';
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'activation_fact_conflict';
    }>;

export interface PluginPackageActivationPrerequisite {
  inspect(
    record: Readonly<PluginPackageInstallRecord>,
    lock: Readonly<PluginPackageLock>,
  ): Promise<Readonly<PluginPackageActivationPrerequisiteObservation>>;
}

export function sequencePluginPackageActivationPrerequisites(
  prerequisites: readonly PluginPackageActivationPrerequisite[],
): PluginPackageActivationPrerequisite {
  if (
    !Array.isArray(prerequisites) ||
    prerequisites.length < 1 ||
    prerequisites.length > 8 ||
    prerequisites.some(
      (prerequisite) =>
        !prerequisite || typeof prerequisite.inspect !== 'function',
    )
  ) {
    throw new InvalidPluginPackageInstallError(
      'activation prerequisite sequence is invalid',
    );
  }
  const sequence = Object.freeze([...prerequisites]);
  return Object.freeze({
    async inspect(
      record: Readonly<PluginPackageInstallRecord>,
      lock: Readonly<PluginPackageLock>,
    ): Promise<Readonly<PluginPackageActivationPrerequisiteObservation>> {
      for (const prerequisite of sequence) {
        const observation = await prerequisite.inspect(record, lock);
        if (observation.status !== 'ready') return observation;
      }
      return Object.freeze({ status: 'ready' as const });
    },
  });
}

export interface InstallPluginPackageOptions {
  readonly lock: PluginPackageLock;
  readonly proposalDigest: string;
  readonly execution: ApprovedActionExecutionRecord;
  readonly installationId: string;
  readonly createMutationId: string;
  readonly createdAtMs: number;
  readonly stageMutationId: string;
  readonly stagedAtMs: number;
  readonly activationStartedMutationId: string;
  readonly activationCommittedMutationId: string;
  readonly activationFailedMutationId: string;
  readonly activationStartedAtMs: number;
  readonly activationObservedAtMs: number;
  readonly admissionAudit: SecurityAuditRecord;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

function normalizeStageEvidence(
  value: PluginPackageStageEvidence,
): Readonly<PluginPackageStageEvidence> {
  const evidence = dataRecord(value, 'stage evidence');
  exactKeys(
    evidence,
    [
      'stageRef',
      'artifactDigest',
      'manifestDigest',
      'contentDigest',
      'evidenceDigest',
    ],
    'stage evidence',
  );
  const stageRef = identifier(value.stageRef, 'stage reference');
  for (const [label, candidate] of [
    ['artifact digest', value.artifactDigest],
    ['manifest digest', value.manifestDigest],
    ['content digest', value.contentDigest],
    ['evidence digest', value.evidenceDigest],
  ] as const) {
    if (typeof candidate !== 'string' || !DIGEST_PATTERN.test(candidate)) {
      throw new InvalidPluginPackageInstallError(`${label} is invalid`);
    }
  }
  return Object.freeze({
    stageRef,
    artifactDigest: value.artifactDigest,
    manifestDigest: value.manifestDigest,
    contentDigest: value.contentDigest,
    evidenceDigest: value.evidenceDigest,
  });
}

export function normalizePluginPackageStageEvidence(
  value: PluginPackageStageEvidence,
): Readonly<PluginPackageStageEvidence> {
  return normalizeStageEvidence(value);
}

export class PluginPackageInstallationCoordinator {
  readonly #repository: PluginPackageAdmissionRepository;
  readonly #activation: PluginPackageActivationCoordinator;
  readonly #activationPrerequisite?: PluginPackageActivationPrerequisite;

  constructor(options: {
    readonly repository: PluginPackageAdmissionRepository;
    readonly publisher: PluginPackageActivationPublisher;
    readonly activationPrerequisite?: PluginPackageActivationPrerequisite;
  }) {
    const value = dataRecord(options, 'installation coordinator options');
    exactKeys(
      value,
      [
        'repository',
        'publisher',
        ...(options.activationPrerequisite === undefined
          ? []
          : ['activationPrerequisite']),
      ],
      'installation coordinator options',
    );
    if (
      !options.repository ||
      typeof options.repository.find !== 'function' ||
      typeof options.repository.findLock !== 'function' ||
      typeof options.repository.create !== 'function' ||
      typeof options.repository.commit !== 'function' ||
      typeof options.repository.admit !== 'function' ||
      typeof options.repository.findAdmissionReceipt !== 'function' ||
      (options.activationPrerequisite !== undefined &&
        (!options.activationPrerequisite ||
          typeof options.activationPrerequisite.inspect !== 'function'))
    ) {
      throw new InvalidPluginPackageInstallError(
        'installation coordinator authority is invalid',
      );
    }
    this.#repository = options.repository;
    this.#activation = new PluginPackageActivationCoordinator({
      repository: options.repository,
      publisher: options.publisher,
    });
    if (options.activationPrerequisite !== undefined) {
      this.#activationPrerequisite = options.activationPrerequisite;
    }
  }

  async #convergeActivation(
    record: Readonly<PluginPackageInstallRecord>,
    options: Readonly<{
      activationStartedMutationId: string;
      activationCommittedMutationId: string;
      activationFailedMutationId: string;
      activationStartedAtMs: number;
      activationObservedAtMs: number;
    }>,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const identity = {
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
    };
    if (record.state === 'staged') {
      const lock = await this.#repository.findLock(record.lockDigest);
      if (!lock) throw new PluginPackageInstallUnavailableError();
      assertPluginPackageInstallMatchesLock(lock, record);
      const prerequisite = await this.#activationPrerequisite?.inspect(
        record,
        lock,
      );
      if (prerequisite?.status === 'deferred') return record;
      if (prerequisite?.status === 'rejected') {
        const failed = transitionPluginPackageInstall(lock, record, {
          type: 'failed',
          mutationId: options.activationFailedMutationId,
          occurredAtMs: options.activationObservedAtMs,
          reason: prerequisite.reason,
        });
        return (
          await this.#repository.commit(
            pluginPackageInstallCommit(record, failed),
          )
        ).record;
      }
      return this.#activation.activate({
        ...identity,
        activationStartedMutationId: options.activationStartedMutationId,
        activationCommittedMutationId: options.activationCommittedMutationId,
        startedAtMs: options.activationStartedAtMs,
      });
    }
    if (record.state === 'activating') {
      return this.#activation.inspect({
        ...identity,
        activationCommittedMutationId: options.activationCommittedMutationId,
        activationFailedMutationId: options.activationFailedMutationId,
        observedAtMs: options.activationObservedAtMs,
      });
    }
    if (record.state === 'active' || record.state === 'failed') return record;
    throw new PluginPackageInstallTransitionConflictError();
  }

  async install(
    options: InstallPluginPackageOptions,
    stageProvider: PluginPackageStageProvider,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const value = dataRecord(options, 'installation options');
    exactKeys(
      value,
      [
        'lock',
        'proposalDigest',
        'execution',
        'installationId',
        'createMutationId',
        'createdAtMs',
        'stageMutationId',
        'stagedAtMs',
        'activationStartedMutationId',
        'activationCommittedMutationId',
        'activationFailedMutationId',
        'activationStartedAtMs',
        'activationObservedAtMs',
        'admissionAudit',
      ],
      'installation options',
    );
    if (!stageProvider || typeof stageProvider.stage !== 'function') {
      throw new InvalidPluginPackageInstallError('stage provider is invalid');
    }
    const lock = normalizePluginPackageLock(options.lock);
    const installationId = identifier(
      options.installationId,
      'installation id',
    );
    const createMutationId = identifier(
      options.createMutationId,
      'create mutation id',
    );
    const stageMutationId = identifier(
      options.stageMutationId,
      'stage mutation id',
    );
    const activationStartedMutationId = identifier(
      options.activationStartedMutationId,
      'activation started mutation id',
    );
    const activationCommittedMutationId = identifier(
      options.activationCommittedMutationId,
      'activation committed mutation id',
    );
    const activationFailedMutationId = identifier(
      options.activationFailedMutationId,
      'activation failed mutation id',
    );
    const createdAtMs = timestamp(options.createdAtMs, 'creation time');
    const stagedAtMs = timestamp(options.stagedAtMs, 'staged time');
    const activationStartedAtMs = timestamp(
      options.activationStartedAtMs,
      'activation start time',
    );
    const activationObservedAtMs = timestamp(
      options.activationObservedAtMs,
      'activation observation time',
    );

    let record: Readonly<PluginPackageInstallRecord> = (
      await this.#repository.admit({
        lock,
        proposalDigest: options.proposalDigest,
        execution: options.execution,
        installationId,
        mutationId: createMutationId,
        admittedAtMs: createdAtMs,
        audit: options.admissionAudit,
      })
    ).record;
    if (record.state !== 'queued') {
      return this.#convergeActivation(record, {
        activationStartedMutationId,
        activationCommittedMutationId,
        activationFailedMutationId,
        activationStartedAtMs,
        activationObservedAtMs,
      });
    }

    const evidence = normalizeStageEvidence(await stageProvider.stage(lock));
    const staged = transitionPluginPackageInstall(lock, record, {
      type: 'stage_completed',
      mutationId: stageMutationId,
      occurredAtMs: stagedAtMs,
      ...evidence,
    });
    record = (
      await this.#repository.commit(pluginPackageInstallCommit(record, staged))
    ).record;
    return this.#convergeActivation(record, {
      activationStartedMutationId,
      activationCommittedMutationId,
      activationFailedMutationId,
      activationStartedAtMs,
      activationObservedAtMs,
    });
  }
}
