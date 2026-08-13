import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
  normalizePluginPackageSecretBindingTransitionReceipt,
  type PluginPackageSecretBindingTransitionReceipt,
  type PluginPackageSecretBindingTransitionReceiptRepository,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt';
import {
  normalizePluginPackageSecretBindingTransitionPlan,
  type PluginPackageSecretBindingTransitionPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-plan';
import {
  PluginPackageSecretBindingConflictError,
  PluginPackageSecretBindingUnavailableError,
  normalizePluginPackageSecretBinding,
  type PluginPackageSecretBinding,
} from '@qinglong/runtime-core/plugin-package-secret-binding';

import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../../repository/definitionRepositorySupport';
import { PostgresPluginPackageSecretBindingRepository } from '../installation/pluginPackageSecretBindingRepository';

type Row = Record<string, unknown>;
const DIGEST = /^[0-9a-f]{64}$/;

export interface ApplyPostgresPluginPackageSecretBindingTransitionInput {
  readonly transitionPlan: Readonly<PluginPackageSecretBindingTransitionPlan>;
  readonly evidenceDigest: string;
  readonly committedAtMs: number;
}

export interface ApplyPostgresPluginPackageSecretBindingTransitionResult {
  readonly status: 'created' | 'existing';
  readonly binding: Readonly<PluginPackageSecretBinding> | null;
  readonly receipt: Readonly<PluginPackageSecretBindingTransitionReceipt>;
}

function unavailable(
  cause?: unknown,
): PluginPackageSecretBindingUnavailableError {
  return new PluginPackageSecretBindingUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function mappedError(error: unknown): Error {
  if (
    error instanceof PluginPackageSecretBindingConflictError ||
    error instanceof PluginPackageSecretBindingUnavailableError ||
    error instanceof TypeError
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (state === '23503' || state === '23505' || state === '23514') {
    return new PluginPackageSecretBindingConflictError(
      'durable transition identity or staged generation conflicts',
    );
  }
  return unavailable(error);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('Secret binding transition commit time is invalid');
  }
  return value as number;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseReceipt(
  row: Row,
): Readonly<PluginPackageSecretBindingTransitionReceipt> {
  try {
    const receipt = normalizePluginPackageSecretBindingTransitionReceipt(
      postgresRequiredJsonObject(
        row.receiptJson,
        unavailable,
      ) as unknown as PluginPackageSecretBindingTransitionReceipt,
    );
    if (
      receipt.receiptDigest !==
      postgresRequiredString(row.receiptDigest, unavailable)
    ) {
      throw unavailable();
    }
    return receipt;
  } catch (error) {
    if (error instanceof PluginPackageSecretBindingUnavailableError)
      throw error;
    throw unavailable(error);
  }
}

export class PostgresPluginPackageSecretBindingTransitionRepository
  implements PluginPackageSecretBindingTransitionReceiptRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Secret binding transition pool is invalid',
      );
    }
  }

  private async findStored(
    queryable: Pick<PostgresPool, 'query'> | Pick<PostgresClient, 'query'>,
    generationDigest: string,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionReceipt> | null> {
    const result = await queryable.query<Row>(
      `SELECT receipt_json AS "receiptJson", receipt_digest AS "receiptDigest"
       FROM "ql3"."plugin_package_secret_binding_transition_receipts"
       WHERE generation_digest = $1
       LIMIT 2`,
      [generationDigest],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw unavailable();
    return parseReceipt(result.rows[0]!);
  }

  async find(
    generationDigestValue: string,
  ): Promise<Readonly<PluginPackageSecretBindingTransitionReceipt> | null> {
    try {
      return await this.findStored(
        this.pool,
        digest(generationDigestValue, 'generation digest'),
      );
    } catch (error) {
      throw mappedError(error);
    }
  }

  async #transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw mappedError(error);
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        throw mappedError(error);
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }

  apply(
    input: Readonly<ApplyPostgresPluginPackageSecretBindingTransitionInput>,
  ): Promise<
    Readonly<ApplyPostgresPluginPackageSecretBindingTransitionResult>
  > {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join('\0') !==
        'committedAtMs\0evidenceDigest\0transitionPlan'
    ) {
      throw new TypeError('Secret binding transition execution is invalid');
    }
    const plan = normalizePluginPackageSecretBindingTransitionPlan(
      input.transitionPlan,
    );
    const evidenceDigest = digest(input.evidenceDigest, 'evidence digest');
    const committedAtMs = timestamp(input.committedAtMs);
    const proposedBinding = createPluginPackageSecretBindingFromTransitionPlan(
      plan,
      'approved-action-execution',
      evidenceDigest,
      committedAtMs,
    );
    const proposedReceipt = createPluginPackageSecretBindingTransitionReceipt({
      transitionPlan: plan,
      authority: {
        kind: 'approved-action-execution',
        evidenceDigest,
      },
      binding: proposedBinding,
      committedAtMs,
    });

    return this.#transaction(async (client) => {
      const existing = await this.findStored(
        client,
        plan.nextTarget.generationDigest,
      );
      if (existing) {
        if (!same(existing, proposedReceipt)) {
          throw new PluginPackageSecretBindingConflictError(
            'generation is committed by another transition authority',
          );
        }
        const binding = existing.bindingDigest
          ? await new PostgresPluginPackageSecretBindingRepository(client).find(
              plan.nextTarget.generationDigest,
            )
          : null;
        if (
          (existing.bindingDigest === null) !== (binding === null) ||
          (binding && binding.bindingDigest !== existing.bindingDigest)
        ) {
          throw unavailable();
        }
        return Object.freeze({
          status: 'existing' as const,
          binding,
          receipt: existing,
        });
      }

      const authority = await client.query<Row>(
        `SELECT previous_binding.binding_json AS "previousBindingJson"
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS install
           ON install.installation_id = head.installation_id
          AND install.project_id = head.project_id
          AND install.package_name = head.package_name
         JOIN "ql3"."plugin_package_installs" AS previous
           ON previous.project_id = install.project_id
          AND previous.package_name = install.package_name
          AND previous.lock_digest = install.previous_active_lock_digest
         LEFT JOIN "ql3"."plugin_package_secret_bindings" AS previous_binding
           ON previous_binding.installation_id = previous.installation_id
          AND previous_binding.project_id = previous.project_id
          AND previous_binding.package_name = previous.package_name
          AND previous_binding.lock_digest = previous.lock_digest
          AND previous_binding.generation = previous.target_generation
         WHERE head.project_id = $1 AND head.package_name = $2
           AND install.installation_id = $3 AND install.lock_digest = $4
           AND install.target_generation = $5
           AND install.lock_json ->> 'manifestDigest' = $6
           AND install.state = 'staged'
           AND install.previous_active_lock_digest = $7
           AND install.active_lock_digest = install.previous_active_lock_digest
           AND install.target_generation = (
             SELECT MAX(history.target_generation)
               FROM "ql3"."plugin_package_installs" AS history
              WHERE history.project_id = install.project_id
                AND history.package_name = install.package_name
           )
           AND previous.state = 'active'
           AND previous.active_lock_digest = previous.lock_digest
           AND previous.installation_id = $8
           AND previous.lock_digest = $7
           AND previous.target_generation = $9
           AND previous.lock_json ->> 'manifestDigest' = $10
         FOR SHARE OF head, install, previous`,
        [
          plan.nextTarget.projectId,
          plan.nextTarget.packageName,
          plan.nextTarget.installationId,
          plan.nextTarget.lockDigest,
          plan.nextTarget.generation,
          plan.nextTarget.manifestDigest,
          plan.previousActiveLockDigest,
          plan.previousTarget.installationId,
          plan.previousTarget.generation,
          plan.previousTarget.manifestDigest,
        ],
      );
      if (authority.rows.length !== 1) {
        throw new PluginPackageSecretBindingConflictError(
          'transition is not the current reviewed staged generation',
        );
      }
      const previousBindingJson = authority.rows[0]!.previousBindingJson;
      const durablePreviousBinding =
        previousBindingJson === null
          ? null
          : normalizePluginPackageSecretBinding(
              postgresRequiredJsonObject(previousBindingJson, unavailable),
            );
      if (!same(durablePreviousBinding, plan.previousBinding)) {
        throw new PluginPackageSecretBindingConflictError(
          'previous active binding changed after transition planning',
        );
      }

      const bindingResult = proposedBinding
        ? await new PostgresPluginPackageSecretBindingRepository(
            client,
          ).publish(proposedBinding)
        : null;
      const receipt = createPluginPackageSecretBindingTransitionReceipt({
        transitionPlan: plan,
        authority: {
          kind: 'approved-action-execution',
          evidenceDigest,
        },
        binding: bindingResult?.binding ?? null,
        committedAtMs,
      });
      const target = plan.nextTarget;
      const inserted = await client.query(
        `INSERT INTO "ql3"."plugin_package_secret_binding_transition_receipts" (
           generation_digest, transition_digest, project_id, package_name,
           installation_id, lock_digest, generation, manifest_digest,
           previous_active_lock_digest, authority_kind, evidence_digest,
           binding_digest, committed_at_ms, receipt_digest, receipt_json
         ) VALUES (
           $1::char(64), $2::char(64), $3::varchar(128), $4::varchar(63),
           $5::varchar(128), $6::char(64), $7::integer, $8::char(64),
           $9::char(64), $10::varchar(32), $11::char(64), $12::char(64),
           $13::bigint, $14::char(64), $15::jsonb
         ) ON CONFLICT (generation_digest) DO NOTHING
         RETURNING generation_digest`,
        [
          target.generationDigest,
          plan.transitionDigest,
          target.projectId,
          target.packageName,
          target.installationId,
          target.lockDigest,
          target.generation,
          target.manifestDigest,
          plan.previousActiveLockDigest,
          receipt.authority.kind,
          receipt.authority.evidenceDigest,
          receipt.bindingDigest,
          receipt.committedAtMs,
          receipt.receiptDigest,
          JSON.stringify(receipt),
        ],
      );
      const stored = await this.findStored(client, target.generationDigest);
      if (!stored || !same(stored, receipt)) {
        throw new PluginPackageSecretBindingConflictError(
          'generation is bound to another transition receipt',
        );
      }
      return Object.freeze({
        status:
          inserted.rows.length === 1
            ? ('created' as const)
            : ('existing' as const),
        binding: bindingResult?.binding ?? null,
        receipt: stored,
      });
    });
  }
}
