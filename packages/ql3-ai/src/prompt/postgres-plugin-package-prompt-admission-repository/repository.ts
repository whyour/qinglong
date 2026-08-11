import type { PostgresPool } from '@qinglong/runtime-core';

import {
  normalizePluginPackagePromptExecutionPlan,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptAdmissionRepository,
  type PluginPackagePromptExecutionPlan,
  type PluginPackagePromptFinalizationReceipt,
} from '../pluginPackagePromptExecution';
import {
  admitOperation,
  type PostgresPluginPackagePromptAdmissionMutationGuard,
} from './admissionOperation';
import { findAdmission } from './admissionRecords';
import { identity, mapStorageError, unavailable } from './authority';
import { finalizeOperation, findFinalization } from './finalizationOperations';
import { runTransaction } from './transaction';

export type { PostgresPluginPackagePromptAdmissionMutationGuard } from './admissionOperation';

export class PostgresPluginPackagePromptAdmissionRepository
  implements PluginPackagePromptAdmissionRepository
{
  constructor(
    private readonly pool: PostgresPool,
    private readonly mutationGuard?: PostgresPluginPackagePromptAdmissionMutationGuard,
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      (mutationGuard !== undefined &&
        (!mutationGuard || typeof mutationGuard.confirm !== 'function'))
    ) {
      throw unavailable();
    }
  }

  async findByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    try {
      return (
        (await findAdmission(this.pool, 'request_id', requestId))?.receipt ??
        null
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findPlanByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptExecutionPlan> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    try {
      return (
        (await findAdmission(this.pool, 'request_id', requestId))?.plan ?? null
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByInvocationId(
    invocationIdValue: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null> {
    const invocationId = identity(invocationIdValue, 'invocationId');
    try {
      return (
        (await findAdmission(this.pool, 'invocation_id', invocationId))
          ?.receipt ?? null
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findFinalizationByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptFinalizationReceipt> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    try {
      return await findFinalization(this.pool, requestId);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  admit(planValue: Readonly<PluginPackagePromptExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
    }>
  > {
    const plan = normalizePluginPackagePromptExecutionPlan(planValue);
    return runTransaction(this.pool, (client) =>
      admitOperation(client, this.mutationGuard, plan),
    );
  }

  finalize(requestIdValue: string): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
    }>
  > {
    const requestId = identity(requestIdValue, 'requestId');
    return runTransaction(this.pool, (client) =>
      finalizeOperation(client, requestId),
    );
  }
}
