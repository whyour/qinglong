// Cluster Plugin Package executor boundary; keep process composition explicit.
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
  PostgresPool,
} from '@qinglong/runtime-core';
import type {
  ApprovedActionDispatchBatchSummary,
  ApprovedActionDispatcher,
} from '@qinglong/runtime-core/approved-action-dispatcher';
import { isAbsolute, normalize, parse } from 'node:path';
import {
  assertPostgresPackageExecutorSchemaReady,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/package-executor';

import {
  createClusterPluginPackageApprovedActionDispatcher,
  type ClusterPluginPackageApprovedActionDispatcherOptions,
} from './pluginPackageApprovedAction';
import {
  consumeClusterPluginPackagePublisherRevocationApprovals,
  type ClusterPluginPackagePublisherRevocationApprovalSummary,
  type ConsumeClusterPluginPackagePublisherRevocationApprovalsOptions,
} from '../publisher/pluginPackagePublisherRevocationApprovalConsumer';
import {
  consumeClusterPluginPackagePublisherTrustTransitionApprovals,
  type ClusterPluginPackagePublisherTrustTransitionApprovalSummary,
  type ConsumeClusterPluginPackagePublisherTrustTransitionApprovalsOptions,
} from '../publisher/pluginPackagePublisherTrustTransitionApprovalConsumer';
import {
  consumeClusterPluginPackageSecretBindingApprovals,
  type ClusterPluginPackageSecretBindingApprovalSummary,
  type ConsumeClusterPluginPackageSecretBindingApprovalsOptions,
} from '../secret-binding/pluginPackageSecretBindingApprovalConsumer';
import { ProjectedPluginPackageSecretExistenceInspector } from '../secret-binding/projectedSecretExistenceInspector';
import {
  runClusterPluginPackagePublisherRevocation,
} from '../publisher/pluginPackagePublisherRevocation';

export type ClusterPluginPackageExecutorProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ClusterPluginPackageExecutorProcessConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      owner: string;
      approvalBatchSize: number;
      dispatchBatchSize: number;
      maxBatches: number;
      leaseDurationMs: number;
      revocationPageSize: number;
      revocationMaxPages: number;
      secretProjectionRoot: string | null;
      database: Readonly<{
        connection: PostgresConnectionOptions;
        pool: PostgresPoolOptions;
      }>;
    }>;

export interface ClusterPluginPackageExecutorBatchResult {
  readonly approvals: Readonly<ClusterPluginPackagePublisherRevocationApprovalSummary>;
  readonly trustTransitionApprovals: Readonly<ClusterPluginPackagePublisherTrustTransitionApprovalSummary>;
  readonly secretBindingApprovals: Readonly<ClusterPluginPackageSecretBindingApprovalSummary>;
  readonly dispatch: Readonly<ApprovedActionDispatchBatchSummary>;
}

export type ClusterPluginPackageExecutorProcessResult =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{
      status: 'completed';
      database: PostgresSchemaReadinessReport;
      batches: readonly Readonly<ClusterPluginPackageExecutorBatchResult>[];
    }>;

export interface RunClusterPluginPackageExecutorProcessOptions {
  readonly environment: ClusterPluginPackageExecutorProcessEnvironment;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly consumeApprovals?: (
    options: ConsumeClusterPluginPackagePublisherRevocationApprovalsOptions,
  ) => Promise<
    Readonly<ClusterPluginPackagePublisherRevocationApprovalSummary>
  >;
  readonly consumeTrustTransitionApprovals?: (
    options: ConsumeClusterPluginPackagePublisherTrustTransitionApprovalsOptions,
  ) => Promise<
    Readonly<ClusterPluginPackagePublisherTrustTransitionApprovalSummary>
  >;
  readonly consumeSecretBindingApprovals?: (
    options: ConsumeClusterPluginPackageSecretBindingApprovalsOptions,
  ) => Promise<Readonly<ClusterPluginPackageSecretBindingApprovalSummary>>;
  readonly createDispatcher?: (
    options: ClusterPluginPackageApprovedActionDispatcherOptions,
  ) => ApprovedActionDispatcher;
  readonly now?: () => number;
}

export class ClusterPluginPackageExecutorProcessConfigError extends TypeError {
  readonly code = 'QL3_PLUGIN_PACKAGE_EXECUTOR_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package executor process configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageExecutorProcessConfigError';
  }
}

const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function enabledValue(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
): boolean {
  const value = environment.QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new ClusterPluginPackageExecutorProcessConfigError(
    'QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED must be true or false',
  );
}

function boundedValue(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
  name: string,
  maximumLength: number,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') return undefined;
  if (value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      `${name} is invalid`,
    );
  }
  return value;
}

function integerValue(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      `${name} must be an integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function databaseConfig(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      host: 'QL3_POSTGRES_PACKAGE_EXECUTOR_HOST',
      port: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PORT',
      database: 'QL3_POSTGRES_PACKAGE_EXECUTOR_DATABASE',
      user: 'QL3_POSTGRES_PACKAGE_EXECUTOR_USER',
      password: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PASSWORD',
    });
  } catch (error) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      error instanceof Error
        ? error.message
        : 'PostgreSQL Package executor connection is invalid',
    );
  }
  const tlsMode = environment.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  let tls: PostgresConnectionOptions['tls'];
  if (tlsMode === 'disable') {
    if (environment.QL3_POSTGRES_ALLOW_INSECURE !== 'true') {
      throw new ClusterPluginPackageExecutorProcessConfigError(
        'disabling PostgreSQL TLS requires QL3_POSTGRES_ALLOW_INSECURE=true',
      );
    }
    tls = Object.freeze({ mode: 'disable' });
  } else if (tlsMode === 'verify-full') {
    const servername = boundedValue(
      environment,
      'QL3_POSTGRES_TLS_SERVERNAME',
      253,
    );
    if (!isPostgresTlsDnsServername(servername)) {
      throw new ClusterPluginPackageExecutorProcessConfigError(
        'QL3_POSTGRES_TLS_SERVERNAME must be an explicit DNS name for verify-full',
      );
    }
    const caFile = boundedValue(
      environment,
      'QL3_POSTGRES_TLS_CA_FILE',
      4096,
    );
    let ca: string | undefined;
    if (caFile !== undefined) {
      try {
        ca = loadPostgresCertificateAuthorityFile(caFile);
      } catch {
        throw new ClusterPluginPackageExecutorProcessConfigError(
          'QL3_POSTGRES_TLS_CA_FILE must contain a bounded trusted CA bundle',
        );
      }
    }
    tls = Object.freeze({
      mode: 'verify-full',
      servername,
      ...(ca === undefined ? {} : { ca }),
    });
  } else {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      'QL3_POSTGRES_TLS_MODE must be verify-full or disable',
    );
  }
  const applicationName =
    boundedValue(environment, 'QL3_POSTGRES_APPLICATION_NAME', 63) ??
    'qinglong3-plugin-package-executor';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(applicationName)) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      'QL3_POSTGRES_APPLICATION_NAME is invalid',
    );
  }
  return Object.freeze({
    connection: Object.freeze({ ...connection, tls }),
    pool: Object.freeze({
      applicationName,
      maxConnections: integerValue(
        environment,
        'QL3_POSTGRES_MAX_CONNECTIONS',
        2,
        1,
        4,
      ),
      connectionTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_CONNECTION_TIMEOUT_MS',
        5_000,
        100,
        60_000,
      ),
      idleTimeoutMs: integerValue(
        environment,
        'QL3_POSTGRES_IDLE_TIMEOUT_MS',
        10_000,
        1_000,
        300_000,
      ),
    }),
  });
}

function secretProjectionRoot(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
): string | null {
  const value = boundedValue(
    environment,
    'QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT',
    4096,
  );
  if (value === undefined) return null;
  if (
    !isAbsolute(value) ||
    parse(value).root === value ||
    normalize(value) !== value
  ) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      'QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT must be an exact absolute directory',
    );
  }
  return value;
}

export function loadClusterPluginPackageExecutorProcessConfig(
  environment: ClusterPluginPackageExecutorProcessEnvironment,
): ClusterPluginPackageExecutorProcessConfig {
  if (!environment || typeof environment !== 'object') {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      'environment is required',
    );
  }
  if (!enabledValue(environment)) return Object.freeze({ enabled: false });
  const owner =
    boundedValue(environment, 'QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER', 128) ??
    'cluster_package_executor_1';
  if (!SAFE_OWNER.test(owner)) {
    throw new ClusterPluginPackageExecutorProcessConfigError(
      'QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER is invalid',
    );
  }
  return Object.freeze({
    enabled: true,
    owner,
    approvalBatchSize: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_APPROVAL_BATCH_SIZE',
      8,
      1,
      64,
    ),
    dispatchBatchSize: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_BATCH_SIZE',
      8,
      1,
      64,
    ),
    maxBatches: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_MAX_BATCHES',
      4,
      1,
      64,
    ),
    leaseDurationMs: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS',
      600_000,
      1,
      600_000,
    ),
    revocationPageSize: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_PAGE_SIZE',
      16,
      1,
      128,
    ),
    revocationMaxPages: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_EXECUTOR_REVOCATION_MAX_PAGES',
      16,
      1,
      64,
    ),
    secretProjectionRoot: secretProjectionRoot(environment),
    database: databaseConfig(environment),
  });
}

function borrowedDatabase(
  database: PostgresDatabaseResource,
): OpenPostgresDatabase {
  return async () =>
    Object.freeze({
      pool: database.pool,
      close: async () => undefined,
    });
}

function isIdleBatch(
  batch: Readonly<ClusterPluginPackageExecutorBatchResult>,
): boolean {
  return (
    batch.approvals.scanned === 0 &&
    batch.trustTransitionApprovals.scanned === 0 &&
    batch.secretBindingApprovals.scanned === 0 &&
    batch.dispatch.scanned === 0
  );
}

export async function runClusterPluginPackageExecutorProcess(
  options: RunClusterPluginPackageExecutorProcessOptions,
): Promise<ClusterPluginPackageExecutorProcessResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !options.environment ||
    (options.openDatabase !== undefined &&
      typeof options.openDatabase !== 'function') ||
    (options.consumeApprovals !== undefined &&
      typeof options.consumeApprovals !== 'function') ||
    (options.consumeTrustTransitionApprovals !== undefined &&
      typeof options.consumeTrustTransitionApprovals !== 'function') ||
    (options.consumeSecretBindingApprovals !== undefined &&
      typeof options.consumeSecretBindingApprovals !== 'function') ||
    (options.createDispatcher !== undefined &&
      typeof options.createDispatcher !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('Plugin Package executor process options are invalid');
  }
  const config = loadClusterPluginPackageExecutorProcessConfig(
    options.environment,
  );
  if (!config.enabled) return Object.freeze({ status: 'disabled' });
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'package-executor',
      connection: config.database.connection,
      pool: config.database.pool,
      onPoolError: () => undefined,
    });
  const database = await openDatabase();
  let failure: unknown;
  try {
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const dispatcherFactory =
      options.createDispatcher ??
      createClusterPluginPackageApprovedActionDispatcher;
    const consumeApprovals =
      options.consumeApprovals ??
      consumeClusterPluginPackagePublisherRevocationApprovals;
    const consumeTrustTransitionApprovals =
      options.consumeTrustTransitionApprovals ??
      consumeClusterPluginPackagePublisherTrustTransitionApprovals;
    const consumeSecretBindingApprovals =
      options.consumeSecretBindingApprovals ??
      consumeClusterPluginPackageSecretBindingApprovals;
    const dispatcher = dispatcherFactory({
      pool: database.pool,
      owner: config.owner,
      leaseDurationMs: config.leaseDurationMs,
      defaultBatchSize: config.dispatchBatchSize,
      secretExistenceInspector:
        config.secretProjectionRoot === null
          ? Object.freeze({
              async assertExists(): Promise<never> {
                throw new Error(
                  'Plugin Package Secret projection is not configured',
                );
              },
            })
          : new ProjectedPluginPackageSecretExistenceInspector({
              rootDirectory: config.secretProjectionRoot,
            }),
      ...(options.now ? { clock: options.now } : {}),
      publisherRevocations: {
        async run(receipt) {
          const result = await runClusterPluginPackagePublisherRevocation({
            openDatabase: borrowedDatabase(database),
            receipt,
            // Durable proposal, dispatch, Project Policy fence and trust-head
            // generation are revalidated in the same SERIALIZABLE mutation.
            confirmAuthorization: () => undefined,
            pageSize: config.revocationPageSize,
            maxPages: config.revocationMaxPages,
          });
          return Object.freeze({
            safeToAdmit: result.safeToAdmit,
            receiptDigest: result.receiptDigest,
            impactDigest: result.impactDigest,
          });
        },
      },
    });
    const batches: Readonly<ClusterPluginPackageExecutorBatchResult>[] = [];
    for (let index = 0; index < config.maxBatches; index += 1) {
      const approvals = await consumeApprovals({
        pool: database.pool,
        limit: config.approvalBatchSize,
        ...(options.now ? { now: options.now } : {}),
      });
      const trustTransitionApprovals =
        await consumeTrustTransitionApprovals({
          pool: database.pool,
          limit: config.approvalBatchSize,
          ...(options.now ? { now: options.now } : {}),
        });
      const secretBindingApprovals =
        await consumeSecretBindingApprovals({
          pool: database.pool,
          limit: config.approvalBatchSize,
          ...(options.now ? { now: options.now } : {}),
        });
      const dispatch = await dispatcher.dispatchBatch({
        limit: config.dispatchBatchSize,
      });
      const batch = Object.freeze({
        approvals,
        trustTransitionApprovals,
        secretBindingApprovals,
        dispatch,
      });
      batches.push(batch);
      if (isIdleBatch(batch)) break;
    }
    return Object.freeze({
      status: 'completed',
      database: evidence,
      batches: Object.freeze([...batches]),
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await database.close();
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, closeError],
          'Plugin Package executor process failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
}
