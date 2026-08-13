import type { DatabaseSync } from 'node:sqlite';

import {
  MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_JSON_BYTES,
  normalizePluginPackageSecretBindingTransitionReceipt,
  type PluginPackageSecretBindingTransitionReceipt,
  type PluginPackageSecretBindingTransitionReceiptRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';
import {
  PluginPackageSecretBindingConflictError,
  PluginPackageSecretBindingUnavailableError,
} from '@qinglong/runtime-core/plugin-package-secret-binding';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;
const DIGEST = /^[0-9a-f]{64}$/;

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new TypeError(
      'Secret binding transition generation digest is invalid',
    );
  }
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new PluginPackageSecretBindingUnavailableError();
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw new PluginPackageSecretBindingUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PluginPackageSecretBindingUnavailableError();
  }
  return value as number;
}

function mapStorageError(error: unknown): Error {
  if (
    error instanceof PluginPackageSecretBindingConflictError ||
    error instanceof PluginPackageSecretBindingUnavailableError ||
    error instanceof TypeError
  ) {
    return error;
  }
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  ) {
    return new PluginPackageSecretBindingConflictError(
      'durable transition receipt identity is already bound',
    );
  }
  return new PluginPackageSecretBindingUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalSqlitePluginPackageSecretBindingTransitionReceiptRepository
  implements PluginPackageSecretBindingTransitionReceiptRepository
{
  constructor(
    readonly authority: LocalSqliteOperationAuthority | DatabaseSync,
  ) {
    this.authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  private parse(
    row: Row,
  ): Readonly<PluginPackageSecretBindingTransitionReceipt> {
    try {
      const receipt = normalizePluginPackageSecretBindingTransitionReceipt(
        JSON.parse(text(row, 'receiptJson')),
      );
      if (
        receipt.transitionPlan.nextTarget.generationDigest !==
          text(row, 'generationDigest') ||
        receipt.transitionPlan.transitionDigest !==
          text(row, 'transitionDigest') ||
        receipt.transitionPlan.nextTarget.projectId !==
          text(row, 'projectId') ||
        receipt.transitionPlan.nextTarget.packageName !==
          text(row, 'packageName') ||
        receipt.transitionPlan.nextTarget.installationId !==
          text(row, 'installationId') ||
        receipt.transitionPlan.nextTarget.lockDigest !==
          text(row, 'lockDigest') ||
        receipt.transitionPlan.nextTarget.generation !==
          integer(row, 'generation') ||
        receipt.transitionPlan.nextTarget.manifestDigest !==
          text(row, 'manifestDigest') ||
        receipt.transitionPlan.previousActiveLockDigest !==
          text(row, 'previousActiveLockDigest') ||
        receipt.authority.kind !== text(row, 'authorityKind') ||
        receipt.authority.evidenceDigest !== text(row, 'evidenceDigest') ||
        receipt.bindingDigest !== nullableText(row, 'bindingDigest') ||
        receipt.committedAtMs !== integer(row, 'committedAtMs') ||
        receipt.receiptDigest !== text(row, 'receiptDigest')
      ) {
        throw new PluginPackageSecretBindingUnavailableError();
      }
      return receipt;
    } catch (error) {
      if (error instanceof PluginPackageSecretBindingUnavailableError)
        throw error;
      throw new PluginPackageSecretBindingUnavailableError({
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private findStored(
    generationDigest: string,
  ): Readonly<PluginPackageSecretBindingTransitionReceipt> | null {
    const row = (this.authority as LocalSqliteOperationAuthority).client
      .prepare(
        `SELECT generation_digest AS "generationDigest",
                transition_digest AS "transitionDigest",
                project_id AS "projectId", package_name AS "packageName",
                installation_id AS "installationId", lock_digest AS "lockDigest",
                generation, manifest_digest AS "manifestDigest",
                previous_active_lock_digest AS "previousActiveLockDigest",
                authority_kind AS "authorityKind", evidence_digest AS "evidenceDigest",
                binding_digest AS "bindingDigest", committed_at_ms AS "committedAtMs",
                receipt_digest AS "receiptDigest", receipt_json AS "receiptJson"
         FROM "QingLong3PluginPackageSecretBindingTransitionReceipts"
         WHERE generation_digest = ?`,
      )
      .get(generationDigest) as Row | undefined;
    return row ? this.parse(row) : null;
  }

  findInTransaction(
    generationDigestValue: string,
  ): Readonly<PluginPackageSecretBindingTransitionReceipt> | null {
    try {
      return this.findStored(digest(generationDigestValue));
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async find(
    generationDigestValue: string,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionReceipt> | null> {
    const normalized = digest(generationDigestValue);
    return (this.authority as LocalSqliteOperationAuthority).enqueue(
      async () => this.findStored(normalized),
      () => new PluginPackageSecretBindingUnavailableError(),
    );
  }

  publishInTransaction(
    value: Readonly<PluginPackageSecretBindingTransitionReceipt>,
  ): Readonly<{
    status: 'created' | 'existing';
    receipt: Readonly<PluginPackageSecretBindingTransitionReceipt>;
  }> {
    const receipt = normalizePluginPackageSecretBindingTransitionReceipt(value);
    const receiptJson = JSON.stringify(receipt);
    if (
      Buffer.byteLength(receiptJson, 'utf8') >
      MAX_PLUGIN_PACKAGE_SECRET_BINDING_TRANSITION_RECEIPT_JSON_BYTES
    ) {
      throw new TypeError(
        'Secret binding transition receipt exceeds durable budget',
      );
    }
    try {
      const existing = this.findStored(
        receipt.transitionPlan.nextTarget.generationDigest,
      );
      if (existing) {
        if (JSON.stringify(existing) !== receiptJson) {
          throw new PluginPackageSecretBindingConflictError(
            'generation is bound to another transition receipt',
          );
        }
        return Object.freeze({
          status: 'existing' as const,
          receipt: existing,
        });
      }
      const target = receipt.transitionPlan.nextTarget;
      const result = (this.authority as LocalSqliteOperationAuthority).client
        .prepare(
          `INSERT INTO "QingLong3PluginPackageSecretBindingTransitionReceipts" (
             generation_digest, transition_digest, project_id, package_name,
             installation_id, lock_digest, generation, manifest_digest,
             previous_active_lock_digest, authority_kind, evidence_digest,
             binding_digest, committed_at_ms, receipt_digest, receipt_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (generation_digest) DO NOTHING`,
        )
        .run(
          target.generationDigest,
          receipt.transitionPlan.transitionDigest,
          target.projectId,
          target.packageName,
          target.installationId,
          target.lockDigest,
          target.generation,
          target.manifestDigest,
          receipt.transitionPlan.previousActiveLockDigest,
          receipt.authority.kind,
          receipt.authority.evidenceDigest,
          receipt.bindingDigest,
          receipt.committedAtMs,
          receipt.receiptDigest,
          receiptJson,
        );
      const stored = this.findStored(target.generationDigest);
      if (!stored || JSON.stringify(stored) !== receiptJson) {
        throw new PluginPackageSecretBindingConflictError(
          'transition receipt target is not the reviewed staged generation',
        );
      }
      return Object.freeze({
        status:
          result.changes === 1 ? ('created' as const) : ('existing' as const),
        receipt: stored,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}
