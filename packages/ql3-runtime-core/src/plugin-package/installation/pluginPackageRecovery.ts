import { createHash } from 'node:crypto';

import {
  PluginPackageActivationCoordinator,
  PluginPackageActivationUnavailableError,
  type PluginPackageActivationPublisher,
} from './pluginPackageActivation';
import {
  InvalidPluginPackageInstallError,
  MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
  PluginPackageInstallMutationConflictError,
  PluginPackageInstallTransitionConflictError,
  PluginPackageInstallUnavailableError,
  assertPluginPackageInstallMatchesLock,
  assertPluginPackageInstallRecoveryPageSize,
  normalizePluginPackageInstallRecord,
  normalizePluginPackageInstallRecoveryCursor,
  pluginPackageInstallCommit,
  pluginPackageInstallRecoveryAction,
  transitionPluginPackageInstall,
  type PluginPackageInstallRecord,
  type PluginPackageInstallRecoveryAction,
  type PluginPackageInstallRecoveryCursor,
  type PluginPackageInstallRecoveryPage,
  type PluginPackageInstallRepository,
} from './pluginPackageInstall';
import {
  normalizePluginPackageStageEvidence,
  type PluginPackageStageProvider,
} from './pluginPackageInstallation';

/** Bounds one recovery cycle independently of the deployment profile. */
export const MAX_PLUGIN_PACKAGE_RECOVERY_PAGES = 64;

export const PLUGIN_PACKAGE_RECOVERY_ITEM_STATUSES = [
  'settled',
  'retry',
  'manual_required',
  'superseded',
] as const;

export type PluginPackageRecoveryItemStatus =
  (typeof PLUGIN_PACKAGE_RECOVERY_ITEM_STATUSES)[number];

export interface PluginPackageRecoveryItemResult {
  readonly projectId: string;
  readonly packageName: string;
  readonly installationId: string;
  readonly action: Exclude<PluginPackageInstallRecoveryAction, 'none'>;
  readonly status: PluginPackageRecoveryItemStatus;
  readonly state: PluginPackageInstallRecord['state'];
}

export interface PluginPackageRecoveryPageResult {
  readonly items: readonly Readonly<PluginPackageRecoveryItemResult>[];
  readonly truncated: boolean;
  readonly next?: Readonly<PluginPackageInstallRecoveryCursor>;
}

export interface PluginPackageRecoveryCycleResult {
  readonly pages: number;
  readonly scanned: number;
  readonly settled: number;
  readonly retry: number;
  readonly manualRequired: number;
  readonly superseded: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

const RECOVERABLE_STATES = new Set(['queued', 'staged', 'activating']);

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
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new InvalidPluginPackageInstallError(`${label} shape is invalid`);
  }
}

function positiveInteger(
  value: unknown,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new InvalidPluginPackageInstallError(`${label} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageInstallUnavailableError();
  }
  return value as number;
}

function compareRecords(
  left: Readonly<PluginPackageInstallRecord>,
  right: Readonly<PluginPackageInstallRecord>,
): number {
  return (
    left.packageName.localeCompare(right.packageName) ||
    left.installationId.localeCompare(right.installationId)
  );
}

function normalizePage(
  value: PluginPackageInstallRecoveryPage,
  limit: number,
): Readonly<PluginPackageInstallRecoveryPage> {
  const page = dataRecord(value, 'recovery page');
  exactKeys(page, ['records', 'truncated'], ['next'], 'recovery page');
  if (
    !Array.isArray(value.records) ||
    value.records.length > limit ||
    typeof value.truncated !== 'boolean'
  ) {
    throw new InvalidPluginPackageInstallError('recovery page is invalid');
  }
  const records = Object.freeze(
    value.records.map((record) => normalizePluginPackageInstallRecord(record)),
  );
  if (
    records.some((record) => !RECOVERABLE_STATES.has(record.state)) ||
    records.some(
      (record, index) =>
        index > 0 && compareRecords(records[index - 1]!, record) >= 0,
    )
  ) {
    throw new InvalidPluginPackageInstallError(
      'recovery page records are invalid',
    );
  }
  const next =
    value.next === undefined
      ? undefined
      : normalizePluginPackageInstallRecoveryCursor(value.next);
  const last = records.at(-1);
  if (
    value.truncated !== (next !== undefined) ||
    (next &&
      (!last ||
        next.packageName !== last.packageName ||
        next.installationId !== last.installationId))
  ) {
    throw new InvalidPluginPackageInstallError(
      'recovery page continuation is invalid',
    );
  }
  return Object.freeze({
    records,
    truncated: value.truncated,
    ...(next ? { next } : {}),
  });
}

function mutationId(
  kind: string,
  record: Readonly<PluginPackageInstallRecord>,
  occurredAtMs: number,
): string {
  const digest = createHash('sha256')
    .update('qinglong/plugin-package-recovery-mutation@v1\0', 'utf8')
    .update(
      JSON.stringify({
        kind,
        installationId: record.installationId,
        version: record.version,
        recordDigest: record.recordDigest,
        occurredAtMs,
      }),
      'utf8',
    )
    .digest('hex');
  return `recovery-${kind}:${digest}`;
}

function result(
  source: Readonly<PluginPackageInstallRecord>,
  action: Exclude<PluginPackageInstallRecoveryAction, 'none'>,
  status: PluginPackageRecoveryItemStatus,
  current: Readonly<PluginPackageInstallRecord> = source,
): Readonly<PluginPackageRecoveryItemResult> {
  return Object.freeze({
    projectId: source.projectId,
    packageName: source.packageName,
    installationId: source.installationId,
    action,
    status,
    state: current.state,
  });
}

export class PluginPackageRecoveryCoordinator {
  readonly #repository: PluginPackageInstallRepository;
  readonly #stageProvider: PluginPackageStageProvider;
  readonly #activation: PluginPackageActivationCoordinator;
  readonly #now: () => number | Promise<number>;

  constructor(options: {
    readonly repository: PluginPackageInstallRepository;
    readonly stageProvider: PluginPackageStageProvider;
    readonly publisher: PluginPackageActivationPublisher;
    readonly now: () => number | Promise<number>;
  }) {
    const value = dataRecord(options, 'recovery coordinator options');
    exactKeys(
      value,
      ['repository', 'stageProvider', 'publisher', 'now'],
      [],
      'recovery coordinator options',
    );
    if (
      !options.repository ||
      typeof options.repository.find !== 'function' ||
      typeof options.repository.findLock !== 'function' ||
      typeof options.repository.commit !== 'function' ||
      typeof options.repository.listRecoveryPage !== 'function' ||
      !options.stageProvider ||
      typeof options.stageProvider.stage !== 'function' ||
      typeof options.now !== 'function'
    ) {
      throw new InvalidPluginPackageInstallError(
        'recovery coordinator authority is invalid',
      );
    }
    this.#repository = options.repository;
    this.#stageProvider = options.stageProvider;
    this.#activation = new PluginPackageActivationCoordinator({
      repository: options.repository,
      publisher: options.publisher,
    });
    this.#now = options.now;
  }

  async #current(
    source: Readonly<PluginPackageInstallRecord>,
  ): Promise<Readonly<PluginPackageInstallRecord> | null> {
    const record = await this.#repository.find(
      source.projectId,
      source.packageName,
    );
    return record ? normalizePluginPackageInstallRecord(record) : null;
  }

  async #convergeActivation(
    record: Readonly<PluginPackageInstallRecord>,
    occurredAtMs: number,
  ): Promise<Readonly<PluginPackageInstallRecord>> {
    const identity = {
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
    };
    if (record.state === 'staged') {
      return this.#activation.activate({
        ...identity,
        activationStartedMutationId: mutationId(
          'activation-start',
          record,
          occurredAtMs,
        ),
        activationCommittedMutationId: mutationId(
          'activation-commit',
          record,
          occurredAtMs,
        ),
        startedAtMs: occurredAtMs,
      });
    }
    if (record.state === 'activating') {
      return this.#activation.inspect({
        ...identity,
        activationCommittedMutationId: mutationId(
          'activation-observed',
          record,
          occurredAtMs,
        ),
        activationFailedMutationId: mutationId(
          'activation-failed',
          record,
          occurredAtMs,
        ),
        observedAtMs: occurredAtMs,
      });
    }
    return record;
  }

  async #recoverRecord(
    sourceValue: Readonly<PluginPackageInstallRecord>,
  ): Promise<Readonly<PluginPackageRecoveryItemResult>> {
    const source = normalizePluginPackageInstallRecord(sourceValue);
    const action = pluginPackageInstallRecoveryAction(source);
    if (action === 'none') {
      throw new InvalidPluginPackageInstallError(
        'terminal record appeared in recovery page',
      );
    }
    let current = source;
    try {
      const occurredAtMs = timestamp(await this.#now());
      if (source.state === 'queued') {
        const lock = await this.#repository.findLock(source.lockDigest);
        if (!lock) throw new PluginPackageInstallUnavailableError();
        assertPluginPackageInstallMatchesLock(lock, source);
        const evidence = normalizePluginPackageStageEvidence(
          await this.#stageProvider.stage(lock),
        );
        const staged = transitionPluginPackageInstall(lock, source, {
          type: 'stage_completed',
          mutationId: mutationId('stage', source, occurredAtMs),
          occurredAtMs,
          ...evidence,
        });
        const committed = normalizePluginPackageInstallRecord(
          (
            await this.#repository.commit(
              pluginPackageInstallCommit(source, staged),
            )
          ).record,
        );
        if (committed.installationId !== source.installationId) {
          return result(source, action, 'superseded', committed);
        }
        if (committed.state === 'active' || committed.state === 'failed') {
          return result(source, action, 'settled', committed);
        }
        if (
          committed.state !== 'staged' ||
          committed.recordDigest !== staged.recordDigest
        ) {
          return result(source, action, 'retry', committed);
        }
        current = committed;
      }
      current = await this.#convergeActivation(current, occurredAtMs);
      if (current.state === 'active' || current.state === 'failed') {
        return result(source, action, 'settled', current);
      }
      return result(source, action, 'retry', current);
    } catch (error) {
      if (
        error instanceof InvalidPluginPackageInstallError ||
        error instanceof PluginPackageInstallMutationConflictError
      ) {
        return result(source, action, 'manual_required', current);
      }
      if (error instanceof PluginPackageInstallTransitionConflictError) {
        try {
          const durable = await this.#current(source);
          if (!durable || durable.installationId !== source.installationId) {
            return result(source, action, 'superseded');
          }
          if (durable.state === 'active' || durable.state === 'failed') {
            return result(source, action, 'settled', durable);
          }
          if (durable.recordDigest !== source.recordDigest) {
            return result(source, action, 'retry', durable);
          }
        } catch {
          return result(source, action, 'retry', current);
        }
        return result(source, action, 'manual_required', current);
      }
      if (
        error instanceof PluginPackageInstallUnavailableError ||
        error instanceof PluginPackageActivationUnavailableError
      ) {
        try {
          const durable = await this.#current(source);
          if (!durable || durable.installationId !== source.installationId) {
            return result(source, action, 'superseded');
          }
          if (durable.state === 'active' || durable.state === 'failed') {
            return result(source, action, 'settled', durable);
          }
          return result(source, action, 'retry', durable);
        } catch {
          return result(source, action, 'retry', current);
        }
      }
      return result(source, action, 'retry', current);
    }
  }

  async recoverPage(options: {
    readonly limit: number;
    readonly after?: Readonly<PluginPackageInstallRecoveryCursor>;
  }): Promise<Readonly<PluginPackageRecoveryPageResult>> {
    const value = dataRecord(options, 'recovery page options');
    exactKeys(value, ['limit'], ['after'], 'recovery page options');
    assertPluginPackageInstallRecoveryPageSize(options.limit);
    const after =
      options.after === undefined
        ? undefined
        : normalizePluginPackageInstallRecoveryCursor(options.after);
    const page = normalizePage(
      await this.#repository.listRecoveryPage({
        limit: options.limit,
        ...(after ? { after } : {}),
      }),
      options.limit,
    );
    const items: Readonly<PluginPackageRecoveryItemResult>[] = [];
    for (const record of page.records) {
      items.push(await this.#recoverRecord(record));
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
  ): Promise<Readonly<PluginPackageRecoveryCycleResult>> {
    const value = dataRecord(options, 'recovery cycle options');
    exactKeys(value, [], ['pageSize', 'maxPages'], 'recovery cycle options');
    const pageSize = positiveInteger(
      options.pageSize ?? 16,
      MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
      'recovery page size',
    );
    const maxPages = positiveInteger(
      options.maxPages ?? 16,
      MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
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
    let after: Readonly<PluginPackageInstallRecoveryCursor> | undefined;
    let exhausted = false;
    while (counts.pages < maxPages) {
      const page = await this.recoverPage({
        limit: pageSize,
        ...(after ? { after } : {}),
      });
      counts.pages += 1;
      counts.scanned += page.items.length;
      for (const item of page.items) {
        switch (item.status) {
          case 'settled':
            counts.settled += 1;
            break;
          case 'retry':
            counts.retry += 1;
            break;
          case 'manual_required':
            counts.manualRequired += 1;
            break;
          case 'superseded':
            counts.superseded += 1;
            break;
        }
      }
      if (!page.truncated) {
        exhausted = true;
        break;
      }
      after = page.next;
    }
    const probe = normalizePage(
      await this.#repository.listRecoveryPage({ limit: 1 }),
      1,
    );
    const remaining = !exhausted || probe.records.length > 0;
    return Object.freeze({
      ...counts,
      remaining,
      safeToAdmit: !remaining && counts.manualRequired === 0,
    });
  }
}
