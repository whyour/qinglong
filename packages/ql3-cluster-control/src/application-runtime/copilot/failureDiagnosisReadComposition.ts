import { CopilotFailureDiagnosisReadService } from '@qinglong/ai/failure-diagnosis-read-model';
import { PostgresCopilotFailureDiagnosisAdmissionRepository } from '@qinglong/ai/postgres-failure-diagnosis-admission-storage';
import { PostgresCopilotFailureDiagnosisModelRepository } from '@qinglong/ai/postgres-failure-diagnosis-model-execution-storage';
import { PostgresCopilotFailureDiagnosisPreModelTerminalizationRepository } from '@qinglong/ai/failure-diagnosis-pre-model-terminalization';
import {
  PostgresProjectPolicyRepository,
  type QingLongPostgresPool,
} from '@qinglong/cluster-postgres/runtime';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import type { PreparedClusterCopilotFailureDiagnosisProjection } from './failureDiagnosisComposition';

export interface CreateProductionClusterCopilotFailureDiagnosisReadServiceOptions {
  readonly pool: QingLongPostgresPool;
  readonly prepared: PreparedClusterCopilotFailureDiagnosisProjection;
}

/**
 * Reuses the execution Pool, durable repositories and projected output keys;
 * creating this service owns no connection, listener or background lifecycle.
 */
export function createProductionClusterCopilotFailureDiagnosisReadService(
  options: CreateProductionClusterCopilotFailureDiagnosisReadServiceOptions,
): Readonly<CopilotFailureDiagnosisReadService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.pool?.query !== 'function' ||
    typeof options.pool?.connect !== 'function' ||
    typeof options.prepared?.outputKeys?.resolve !== 'function'
  ) {
    throw new TypeError(
      'Production Cluster Copilot failure diagnosis read dependencies are invalid',
    );
  }
  const admissions = new PostgresCopilotFailureDiagnosisAdmissionRepository(
    options.pool,
  );
  const models = new PostgresCopilotFailureDiagnosisModelRepository(
    options.pool,
  );
  const terminalizations =
    new PostgresCopilotFailureDiagnosisPreModelTerminalizationRepository(
      options.pool,
    );
  return new CopilotFailureDiagnosisReadService({
    admissions,
    terminalizations,
    finalizations: models,
    models,
    authorizer: new ProjectPolicyEngine(
      new PostgresProjectPolicyRepository(options.pool),
    ),
    keys: options.prepared.outputKeys,
  });
}
