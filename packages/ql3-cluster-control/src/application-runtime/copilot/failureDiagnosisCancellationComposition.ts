import { CopilotFailureDiagnosisCancellationService } from '@qinglong/ai/failure-diagnosis-cancellation';
import { PostgresCopilotFailureDiagnosisAdmissionRepository } from '@qinglong/ai/postgres-failure-diagnosis-admission-storage';
import {
  PostgresCopilotFailureDiagnosisPreModelTerminalizationRepository,
  terminalizeCopilotFailureDiagnosisBeforeModel,
} from '@qinglong/ai/failure-diagnosis-pre-model-terminalization';
import {
  PostgresClusterRunCancellationRepository,
  type QingLongPostgresPool,
} from '@qinglong/cluster-postgres/runtime';

export interface CreateProductionClusterCopilotFailureDiagnosisCancellationOptions {
  readonly pool: QingLongPostgresPool;
}

/**
 * Reuses the AI Pool and existing Run/admission ledgers. The cancellation
 * capability owns no connection, timer, listener or background lifecycle.
 */
export function createProductionClusterCopilotFailureDiagnosisCancellation(
  options: CreateProductionClusterCopilotFailureDiagnosisCancellationOptions,
): Readonly<CopilotFailureDiagnosisCancellationService> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.pool?.query !== 'function' ||
    typeof options.pool?.connect !== 'function'
  ) {
    throw new TypeError(
      'Production Cluster Copilot failure diagnosis cancellation dependencies are invalid',
    );
  }
  const admissions = new PostgresCopilotFailureDiagnosisAdmissionRepository(
    options.pool,
  );
  const terminalizations =
    new PostgresCopilotFailureDiagnosisPreModelTerminalizationRepository(
      options.pool,
    );
  return new CopilotFailureDiagnosisCancellationService({
    admissions,
    cancellations: new PostgresClusterRunCancellationRepository(options.pool),
    terminalizations: Object.freeze({ repository: terminalizations }),
    terminalizeBeforeModel: terminalizeCopilotFailureDiagnosisBeforeModel,
  });
}
