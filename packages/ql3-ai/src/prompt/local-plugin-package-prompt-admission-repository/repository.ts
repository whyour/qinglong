import type { DatabaseSync } from 'node:sqlite';

import type { LocalModelInvocationOperationAuthority } from '../../model-invocation/localModelInvocationRepository';
import {
  normalizePluginPackagePromptExecutionPlan,
  PluginPackagePromptAdmissionUnavailableError,
  type PluginPackagePromptAdmissionReceipt,
  type PluginPackagePromptAdmissionRepository,
  type PluginPackagePromptExecutionPlan,
  type PluginPackagePromptFinalizationReceipt,
} from '../pluginPackagePromptExecution';
import { admitOperation } from './admissionOperation';
import { findAdmission } from './admissionRecords';
import {
  createAuthority,
  enqueueOperation,
  identity,
  type LocalPluginPackagePromptAdmissionMutationGuard,
} from './authority';
import { finalizeOperation, findFinalization } from './finalizationOperations';

export type { LocalPluginPackagePromptAdmissionMutationGuard } from './authority';

export class LocalPluginPackagePromptAdmissionRepository
  implements PluginPackagePromptAdmissionRepository
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #mutationGuard:
    | LocalPluginPackagePromptAdmissionMutationGuard
    | undefined;

  constructor(
    authority: LocalModelInvocationOperationAuthority | DatabaseSync,
    mutationGuard?: LocalPluginPackagePromptAdmissionMutationGuard,
  ) {
    this.#authority = createAuthority(authority);
    if (
      mutationGuard !== undefined &&
      (!mutationGuard ||
        typeof mutationGuard !== 'object' ||
        typeof mutationGuard.confirm !== 'function')
    ) {
      throw new PluginPackagePromptAdmissionUnavailableError();
    }
    this.#mutationGuard = mutationGuard;
  }

  findByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    return enqueueOperation(
      this.#authority,
      () =>
        findAdmission(this.#authority.client, 'request_id = ?', requestId)
          ?.receipt ?? null,
    );
  }

  findPlanByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptExecutionPlan> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    return enqueueOperation(
      this.#authority,
      () =>
        findAdmission(this.#authority.client, 'request_id = ?', requestId)
          ?.plan ?? null,
    );
  }

  findByInvocationId(
    invocationIdValue: string,
  ): Promise<Readonly<PluginPackagePromptAdmissionReceipt> | null> {
    const invocationId = identity(invocationIdValue, 'invocationId');
    return enqueueOperation(
      this.#authority,
      () =>
        findAdmission(this.#authority.client, 'invocation_id = ?', invocationId)
          ?.receipt ?? null,
    );
  }

  findFinalizationByRequestId(
    requestIdValue: string,
  ): Promise<Readonly<PluginPackagePromptFinalizationReceipt> | null> {
    const requestId = identity(requestIdValue, 'requestId');
    return enqueueOperation(this.#authority, () =>
      findFinalization(this.#authority.client, requestId),
    );
  }

  admit(planValue: Readonly<PluginPackagePromptExecutionPlan>): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptAdmissionReceipt>;
    }>
  > {
    const plan = normalizePluginPackagePromptExecutionPlan(planValue);
    return enqueueOperation(this.#authority, () =>
      admitOperation(this.#authority, this.#mutationGuard, plan),
    );
  }

  finalize(requestIdValue: string): Promise<
    Readonly<{
      status: 'created' | 'existing';
      receipt: Readonly<PluginPackagePromptFinalizationReceipt>;
    }>
  > {
    const requestId = identity(requestIdValue, 'requestId');
    return enqueueOperation(this.#authority, () =>
      finalizeOperation(this.#authority, requestId),
    );
  }
}
