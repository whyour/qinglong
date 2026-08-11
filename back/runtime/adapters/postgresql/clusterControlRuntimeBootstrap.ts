import {
  activateClusterControlRuntime,
  type ClusterControlActivationAudit,
  type ClusterControlActivationStack,
  type ClusterControlReadinessEvidence,
  type ClusterControlRuntimeActivationResult,
  type ClusterControlStopResult,
} from '../../application/clusterControlRuntimeActivation';
import type { DeploymentProfile } from '../../domain/deploymentProfile';
import type {
  PostgresDatabaseResource,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  assertPostgresSchemaReady,
  type PostgresSchemaReadinessReport,
} from '../../../migrations/postgresql/schemaReadiness';
import { PostgresRunRepository } from './runRepository';

export type ClusterControlDatabasePool = PostgresPool;

export type ClusterControlDatabaseResource = PostgresDatabaseResource;

export interface ClusterControlAssemblyInput {
  readonly evidence: ClusterControlReadinessEvidence;
  readonly runs: PostgresRunRepository;
}

export interface ClusterControlRuntimeBootstrapOptions {
  readonly enabled?: boolean;
  readonly profile: DeploymentProfile;
  readonly openDatabase: () => Promise<ClusterControlDatabaseResource>;
  readonly create: (
    input: ClusterControlAssemblyInput,
  ) => ClusterControlActivationStack;
  readonly audit: (
    record: ClusterControlActivationAudit,
  ) => void | Promise<void>;
}

function readinessEvidence(
  report: PostgresSchemaReadinessReport,
): ClusterControlReadinessEvidence {
  return Object.freeze({
    contractName: report.contractName,
    contractVersion: report.contractVersion,
    serverMajor: report.serverMajor,
    migrationIds: Object.freeze([...report.migrationIds]),
  });
}

/**
 * Lazily owns the cluster database around the readiness-first activation gate.
 * A concrete cluster package supplies openDatabase() and the pg.Pool binding;
 * disabled and wrong-profile paths never import or open the database driver.
 */
export async function bootstrapClusterControlRuntime(
  options: ClusterControlRuntimeBootstrapOptions,
): Promise<ClusterControlRuntimeActivationResult> {
  let database: ClusterControlDatabaseResource | undefined;
  let closePromise: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => {
    if (!database) return Promise.resolve();
    closePromise ??= Promise.resolve().then(() => database!.close());
    return closePromise;
  };

  try {
    const activation = await activateClusterControlRuntime({
      enabled: options.enabled,
      profile: options.profile,
      readiness: {
        async assertReady() {
          if (database) {
            throw new Error(
              'Cluster-control database was opened more than once',
            );
          }
          database = await options.openDatabase();
          return readinessEvidence(
            await assertPostgresSchemaReady(database.pool),
          );
        },
      },
      create(evidence) {
        if (!database) {
          throw new Error(
            'Cluster-control database is unavailable after readiness',
          );
        }
        return options.create({
          evidence,
          runs: new PostgresRunRepository(database.pool),
        });
      },
      audit: options.audit,
    });
    if (activation.status === 'disabled') return activation;

    let stopPromise: Promise<ClusterControlStopResult> | undefined;
    return {
      ...activation,
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          let result: ClusterControlStopResult | undefined;
          let primaryError: unknown;
          try {
            result = await activation.stop();
          } catch (error) {
            primaryError = error;
          }
          try {
            await closeDatabase();
          } catch (error) {
            primaryError ??= error;
          }
          if (primaryError) throw primaryError;
          return result!;
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      await closeDatabase();
    } catch {
      // Preserve the readiness/assembly/activation failure.
    }
    throw error;
  }
}
