import {
  InvalidPluginPackageResourceMaterializationError,
  PluginPackageResourceMaterializationConflictError,
  PluginPackageResourceMaterializationUnavailableError,
  materializeActivePluginPackageResources,
  normalizePluginPackageMaterializedRevision,
  type PluginPackageMaterializedRevisionRepository,
  type PluginPackageResourceByteSource,
  type PluginPackageResourceLockSource,
} from './pluginPackageResourceMaterialization';
import type { PluginPackageResourceGenerationSource } from './pluginPackageResourceGeneration';
import {
  InvalidPluginPackageTaskReconciliationError,
  PluginPackageTaskReconciliationConflictError,
  PluginPackageTaskReconciliationUnavailableError,
  type PluginPackageTaskReconciliationReceipt,
  type PluginPackageTaskReconciliationRepository,
} from './pluginPackageTaskReconciliation';
import { TaskSpecSemanticRegistry } from '../task-definition/taskSpecSemantic';

export const MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE = 64;
export const MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES = 64;

export interface PluginPackageTaskPublicationPendingCandidate {
  readonly projectId: string;
  readonly packageName: string;
}

export interface PluginPackageTaskPublicationRecoveryCursor {
  readonly projectId: string;
  readonly packageName: string;
}

export interface PluginPackageTaskPublicationRecoveryPage {
  readonly candidates: readonly Readonly<PluginPackageTaskPublicationPendingCandidate>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageTaskPublicationRecoveryCursor>;
}

export interface PluginPackageTaskPublicationRecoverySource {
  listPendingPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageTaskPublicationRecoveryCursor>;
  }): Promise<Readonly<PluginPackageTaskPublicationRecoveryPage>>;
}

export interface PluginPackageTaskPublicationCurrentResult {
  readonly status: 'current';
  readonly materialized: 'created' | 'existing';
  readonly reconciled: 'created' | 'existing';
  readonly generationDigest: string;
  readonly revisionDigest: string;
  readonly receipt: Readonly<PluginPackageTaskReconciliationReceipt>;
}

export interface PluginPackageTaskPublicationAbsentResult {
  readonly status: 'absent';
}

export interface PluginPackageTaskPublicationSupersededResult {
  readonly status: 'superseded';
  readonly generationDigest: string;
}

export type PluginPackageTaskPublicationResult =
  | Readonly<PluginPackageTaskPublicationCurrentResult>
  | Readonly<PluginPackageTaskPublicationAbsentResult>
  | Readonly<PluginPackageTaskPublicationSupersededResult>;

export type PluginPackageTaskPublicationRecoveryItemStatus =
  | 'manual_required'
  | 'retry'
  | 'settled'
  | 'superseded';

export interface PluginPackageTaskPublicationRecoveryItem {
  readonly projectId: string;
  readonly packageName: string;
  readonly status: PluginPackageTaskPublicationRecoveryItemStatus;
}

export interface PluginPackageTaskPublicationRecoveryCycleResult {
  readonly pages: number;
  readonly scanned: number;
  readonly settled: number;
  readonly retry: number;
  readonly manualRequired: number;
  readonly superseded: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

export class InvalidPluginPackageTaskPublicationError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_TASK_PUBLICATION_INVALID';

  constructor(message: string) {
    super(`Plugin Package Task publication is invalid: ${message}`);
    this.name = 'InvalidPluginPackageTaskPublicationError';
  }
}

export class PluginPackageTaskPublicationConflictError extends Error {
  readonly code = 'PLUGIN_PACKAGE_TASK_PUBLICATION_CONFLICT';

  constructor(message: string, options?: ErrorOptions) {
    super(`Plugin Package Task publication conflicts with state: ${message}`, options);
    this.name = 'PluginPackageTaskPublicationConflictError';
  }
}

export class PluginPackageTaskPublicationUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_TASK_PUBLICATION_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package Task publication is unavailable', options);
    this.name = 'PluginPackageTaskPublicationUnavailableError';
  }
}

const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid(message: string): never {
  throw new InvalidPluginPackageTaskPublicationError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== 'string') ||
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof key === 'string' && !allowed.has(key))
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function projectId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 128
  ) {
    return invalid('projectId is invalid');
  }
  return value;
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    return invalid('packageName is invalid');
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    return invalid(`${label} is invalid`);
  }
  return value as number;
}

function normalizeCandidate(
  value: PluginPackageTaskPublicationPendingCandidate,
): Readonly<PluginPackageTaskPublicationPendingCandidate> {
  const candidate = record(value, 'pending candidate');
  exactKeys(candidate, ['packageName', 'projectId'], [], 'pending candidate');
  return Object.freeze({
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
  });
}

export function normalizePluginPackageTaskPublicationRecoveryCursor(
  value: PluginPackageTaskPublicationRecoveryCursor,
): Readonly<PluginPackageTaskPublicationRecoveryCursor> {
  const cursor = record(value, 'recovery cursor');
  exactKeys(cursor, ['packageName', 'projectId'], [], 'recovery cursor');
  return Object.freeze({
    projectId: projectId(value.projectId),
    packageName: packageName(value.packageName),
  });
}

export function assertPluginPackageTaskPublicationRecoveryPageSize(
  value: number,
): void {
  positiveInteger(
    value,
    MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
    'recovery page size',
  );
}

function compareCandidates(
  left: Readonly<PluginPackageTaskPublicationPendingCandidate>,
  right: Readonly<PluginPackageTaskPublicationPendingCandidate>,
): number {
  return (
    left.projectId.localeCompare(right.projectId) ||
    left.packageName.localeCompare(right.packageName)
  );
}

function normalizePage(
  value: PluginPackageTaskPublicationRecoveryPage,
  limit: number,
): Readonly<PluginPackageTaskPublicationRecoveryPage> {
  const page = record(value, 'recovery page');
  exactKeys(page, ['candidates', 'truncated'], ['next'], 'recovery page');
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > limit ||
    typeof value.truncated !== 'boolean'
  ) {
    return invalid('recovery page is invalid');
  }
  const candidates = Object.freeze(value.candidates.map(normalizeCandidate));
  if (
    candidates.some(
      (candidate, index) =>
        index > 0 &&
        compareCandidates(candidates[index - 1]!, candidate) >= 0,
    )
  ) {
    return invalid('recovery candidates must be uniquely sorted');
  }
  const next =
    value.next === undefined
      ? undefined
      : normalizePluginPackageTaskPublicationRecoveryCursor(value.next);
  const last = candidates.at(-1);
  if (
    value.truncated !== (next !== undefined) ||
    (next &&
      (!last ||
        next.projectId !== last.projectId ||
        next.packageName !== last.packageName))
  ) {
    return invalid('recovery continuation is invalid');
  }
  return Object.freeze({
    candidates,
    truncated: value.truncated,
    ...(next ? { next } : {}),
  });
}

function publicationAuthorities(options: {
  readonly generationSource: PluginPackageResourceGenerationSource;
  readonly lockSource: PluginPackageResourceLockSource;
  readonly byteSource: PluginPackageResourceByteSource;
  readonly materializedRepository: PluginPackageMaterializedRevisionRepository;
  readonly reconciliationRepository: PluginPackageTaskReconciliationRepository;
  readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
}): void {
  const value = record(options, 'publication coordinator options');
  exactKeys(
    value,
    [
      'byteSource',
      'generationSource',
      'lockSource',
      'materializedRepository',
      'reconciliationRepository',
      'taskSpecSemanticRegistry',
    ],
    [],
    'publication coordinator options',
  );
  if (
    !options.generationSource ||
    typeof options.generationSource.findActiveResourceGeneration !== 'function' ||
    !options.lockSource ||
    typeof options.lockSource.findLock !== 'function' ||
    !options.byteSource ||
    typeof options.byteSource.open !== 'function' ||
    !options.materializedRepository ||
    typeof options.materializedRepository.find !== 'function' ||
    typeof options.materializedRepository.publish !== 'function' ||
    !options.reconciliationRepository ||
    typeof options.reconciliationRepository.find !== 'function' ||
    typeof options.reconciliationRepository.reconcile !== 'function' ||
    !(options.taskSpecSemanticRegistry instanceof TaskSpecSemanticRegistry)
  ) {
    invalid('publication coordinator authority is invalid');
  }
}

export class PluginPackageTaskPublicationCoordinator {
  readonly #generationSource: PluginPackageResourceGenerationSource;
  readonly #lockSource: PluginPackageResourceLockSource;
  readonly #byteSource: PluginPackageResourceByteSource;
  readonly #materializedRepository: PluginPackageMaterializedRevisionRepository;
  readonly #reconciliationRepository: PluginPackageTaskReconciliationRepository;
  readonly #registry: TaskSpecSemanticRegistry;

  constructor(options: {
    readonly generationSource: PluginPackageResourceGenerationSource;
    readonly lockSource: PluginPackageResourceLockSource;
    readonly byteSource: PluginPackageResourceByteSource;
    readonly materializedRepository: PluginPackageMaterializedRevisionRepository;
    readonly reconciliationRepository: PluginPackageTaskReconciliationRepository;
    readonly taskSpecSemanticRegistry: TaskSpecSemanticRegistry;
  }) {
    publicationAuthorities(options);
    this.#generationSource = options.generationSource;
    this.#lockSource = options.lockSource;
    this.#byteSource = options.byteSource;
    this.#materializedRepository = options.materializedRepository;
    this.#reconciliationRepository = options.reconciliationRepository;
    this.#registry = options.taskSpecSemanticRegistry;
  }

  async publishActive(
    projectIdValue: string,
    packageNameValue: string,
  ): Promise<Readonly<PluginPackageTaskPublicationResult>> {
    const identity = {
      projectId: projectId(projectIdValue),
      packageName: packageName(packageNameValue),
    };
    try {
      const first = await this.#generationSource.findActiveResourceGeneration(
        identity.projectId,
        identity.packageName,
      );
      if (first === null) return Object.freeze({ status: 'absent' });
      if (
        first.projectId !== identity.projectId ||
        first.packageName !== identity.packageName
      ) {
        throw new PluginPackageTaskPublicationConflictError(
          'generation source returned another Package identity',
        );
      }
      let revision = await this.#materializedRepository.find(
        first.generationDigest,
      );
      let materialized: 'created' | 'existing' = 'existing';
      if (revision === null) {
        const materializedValue = await materializeActivePluginPackageResources({
          ...identity,
          generationSource: this.#generationSource,
          lockSource: this.#lockSource,
          byteSource: this.#byteSource,
          taskSpecSemanticRegistry: this.#registry,
        });
        if (materializedValue === null) {
          return Object.freeze({
            status: 'superseded',
            generationDigest: first.generationDigest,
          });
        }
        if (materializedValue.generation.generationDigest !== first.generationDigest) {
          return Object.freeze({
            status: 'superseded',
            generationDigest: first.generationDigest,
          });
        }
        const publication = await this.#materializedRepository.publish(
          materializedValue,
        );
        materialized = publication.status;
        revision = publication.revision;
      }
      const normalizedRevision = normalizePluginPackageMaterializedRevision(
        revision,
        this.#registry,
      );
      if (
        normalizedRevision.generation.generationDigest !==
          first.generationDigest ||
        normalizedRevision.generation.projectId !== identity.projectId ||
        normalizedRevision.generation.packageName !== identity.packageName
      ) {
        throw new PluginPackageTaskPublicationConflictError(
          'durable materialized revision does not match the active generation',
        );
      }
      const reconciliation = await this.#reconciliationRepository.reconcile(
        normalizedRevision,
        this.#generationSource,
      );
      const finalGeneration =
        await this.#generationSource.findActiveResourceGeneration(
          identity.projectId,
          identity.packageName,
        );
      if (
        finalGeneration === null ||
        finalGeneration.generationDigest !== first.generationDigest
      ) {
        return Object.freeze({
          status: 'superseded',
          generationDigest: first.generationDigest,
        });
      }
      return Object.freeze({
        status: 'current',
        materialized,
        reconciled: reconciliation.status,
        generationDigest: first.generationDigest,
        revisionDigest: normalizedRevision.revisionDigest,
        receipt: reconciliation.receipt,
      });
    } catch (error) {
      if (
        error instanceof InvalidPluginPackageTaskPublicationError ||
        error instanceof PluginPackageTaskPublicationConflictError ||
        error instanceof PluginPackageTaskPublicationUnavailableError
      ) {
        throw error;
      }
      if (
        error instanceof InvalidPluginPackageResourceMaterializationError ||
        error instanceof InvalidPluginPackageTaskReconciliationError
      ) {
        throw new InvalidPluginPackageTaskPublicationError(error.message);
      }
      if (
        error instanceof PluginPackageResourceMaterializationConflictError ||
        error instanceof PluginPackageTaskReconciliationConflictError
      ) {
        throw new PluginPackageTaskPublicationConflictError(
          'active generation publication fence changed',
          { cause: error },
        );
      }
      if (
        error instanceof PluginPackageResourceMaterializationUnavailableError ||
        error instanceof PluginPackageTaskReconciliationUnavailableError
      ) {
        throw new PluginPackageTaskPublicationUnavailableError({ cause: error });
      }
      throw new PluginPackageTaskPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}

export class PluginPackageTaskPublicationRecoveryCoordinator {
  readonly #source: PluginPackageTaskPublicationRecoverySource;
  readonly #publisher: PluginPackageTaskPublicationCoordinator;

  constructor(options: {
    readonly source: PluginPackageTaskPublicationRecoverySource;
    readonly publisher: PluginPackageTaskPublicationCoordinator;
  }) {
    const value = record(options, 'recovery coordinator options');
    exactKeys(value, ['publisher', 'source'], [], 'recovery coordinator options');
    if (
      !options.source ||
      typeof options.source.listPendingPage !== 'function' ||
      !(options.publisher instanceof PluginPackageTaskPublicationCoordinator)
    ) {
      invalid('recovery coordinator authority is invalid');
    }
    this.#source = options.source;
    this.#publisher = options.publisher;
  }

  async recoverPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageTaskPublicationRecoveryCursor>;
  }): Promise<
    Readonly<{
      items: readonly Readonly<PluginPackageTaskPublicationRecoveryItem>[];
      truncated: boolean;
      next?: Readonly<PluginPackageTaskPublicationRecoveryCursor>;
    }>
  > {
    const value = record(options, 'recovery page options');
    exactKeys(value, ['limit'], ['after'], 'recovery page options');
    assertPluginPackageTaskPublicationRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageTaskPublicationRecoveryCursor(options.after);
    let page: Readonly<PluginPackageTaskPublicationRecoveryPage>;
    try {
      page = normalizePage(
        await this.#source.listPendingPage({
          limit: options.limit,
          ...(after ? { after } : {}),
        }),
        options.limit,
      );
    } catch (error) {
      if (error instanceof InvalidPluginPackageTaskPublicationError) throw error;
      throw new PluginPackageTaskPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const items: Readonly<PluginPackageTaskPublicationRecoveryItem>[] = [];
    for (const candidate of page.candidates) {
      let status: PluginPackageTaskPublicationRecoveryItemStatus;
      try {
        const published = await this.#publisher.publishActive(
          candidate.projectId,
          candidate.packageName,
        );
        status =
          published.status === 'current'
            ? 'settled'
            : published.status === 'superseded'
              ? 'superseded'
              : 'manual_required';
      } catch (error) {
        status =
          error instanceof InvalidPluginPackageTaskPublicationError ||
          error instanceof PluginPackageTaskPublicationConflictError
            ? 'manual_required'
            : 'retry';
      }
      items.push(Object.freeze({ ...candidate, status }));
    }
    return Object.freeze({
      items: Object.freeze(items),
      truncated: page.truncated,
      ...(page.next ? { next: page.next } : {}),
    });
  }

  async recover(
    options: {
      readonly pageSize?: number;
      readonly maxPages?: number;
    } = {},
  ): Promise<Readonly<PluginPackageTaskPublicationRecoveryCycleResult>> {
    const value = record(options, 'recovery cycle options');
    exactKeys(value, [], ['maxPages', 'pageSize'], 'recovery cycle options');
    const pageSize = positiveInteger(
      options.pageSize ?? 8,
      MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
      'recovery page size',
    );
    const maxPages = positiveInteger(
      options.maxPages ?? 8,
      MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
      'recovery page count',
    );
    const counts = {
      pages: 0,
      scanned: 0,
      settled: 0,
      retry: 0,
      manualRequired: 0,
      superseded: 0,
    };
    let after: Readonly<PluginPackageTaskPublicationRecoveryCursor> | undefined;
    let exhausted = false;
    while (counts.pages < maxPages) {
      const page = await this.recoverPage({
        limit: pageSize,
        ...(after ? { after } : {}),
      });
      counts.pages += 1;
      counts.scanned += page.items.length;
      for (const item of page.items) {
        if (item.status === 'settled') counts.settled += 1;
        else if (item.status === 'retry') counts.retry += 1;
        else if (item.status === 'manual_required') counts.manualRequired += 1;
        else counts.superseded += 1;
      }
      if (!page.truncated) {
        exhausted = true;
        break;
      }
      after = page.next;
    }
    let probe: Readonly<PluginPackageTaskPublicationRecoveryPage>;
    try {
      probe = normalizePage(await this.#source.listPendingPage({ limit: 1 }), 1);
    } catch (error) {
      throw new PluginPackageTaskPublicationUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
    const remaining = !exhausted || probe.candidates.length > 0;
    return Object.freeze({
      ...counts,
      remaining,
      safeToAdmit:
        !remaining && counts.retry === 0 && counts.manualRequired === 0,
    });
  }
}
