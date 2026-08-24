// Remote execution owns offer-bound Secret delivery without retaining plaintext authority.
import {
  InvalidRemoteWorkerSecretDeliveryError,
  RemoteWorkerSecretDeliveryFenceRejectedError,
  RemoteWorkerSecretDeliveryUnavailableError,
  createRemoteWorkerSecretDeliveryResponseBody,
  normalizeRemoteWorkerSecretDeliveryAuthority,
  normalizeRemoteWorkerSecretDeliveryCommand,
  type RemoteWorkerSecretDeliveryAuthorityRepository,
  type RemoteWorkerSecretDeliveryCommand,
  type RemoteWorkerSecretDeliveryResult,
  type RemoteWorkerSecretValueProvider,
} from '@qinglong/runtime-core/remote-secret-delivery';

export interface ClusterRemoteWorkerSecretDeliveryPrincipal {
  readonly workerId: string;
}

export type ClusterRemoteWorkerSecretDeliveryCommand = Omit<
  RemoteWorkerSecretDeliveryCommand,
  'workerId'
>;

export class ClusterRemoteWorkerSecretDeliveryService {
  constructor(
    private readonly authority: RemoteWorkerSecretDeliveryAuthorityRepository,
    private readonly secrets: RemoteWorkerSecretValueProvider,
  ) {
    if (
      !authority ||
      typeof authority.authorize !== 'function' ||
      !secrets ||
      typeof secrets.resolve !== 'function'
    ) throw new TypeError('Remote Worker Secret delivery service is invalid');
  }

  async deliver(
    principal: ClusterRemoteWorkerSecretDeliveryPrincipal,
    input: ClusterRemoteWorkerSecretDeliveryCommand,
  ): Promise<Readonly<RemoteWorkerSecretDeliveryResult>> {
    if (
      !principal ||
      typeof principal !== 'object' ||
      Array.isArray(principal) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal.workerId)
    ) throw new TypeError('Remote Worker Secret delivery principal is invalid');
    const command = normalizeRemoteWorkerSecretDeliveryCommand({
      ...input,
      workerId: principal.workerId,
    });
    let authorized;
    try {
      authorized = normalizeRemoteWorkerSecretDeliveryAuthority(
        await this.authority.authorize(command),
      );
      if (
        authorized.workerId !== command.workerId ||
        authorized.workerSessionId !== command.workerSessionId ||
        authorized.workerGeneration !== command.workerGeneration ||
        authorized.runId !== command.runId ||
        authorized.attemptId !== command.attemptId ||
        authorized.projectId !== command.projectId ||
        authorized.taskId !== command.taskId ||
        authorized.taskRevision !== command.taskRevision ||
        authorized.executionDigest !== command.executionDigest ||
        authorized.offerId !== command.offerId ||
        authorized.leaseGeneration !== command.leaseGeneration ||
        authorized.leaseVersion !== command.expectedLeaseVersion ||
        JSON.stringify(authorized.secretRefs) !== JSON.stringify(command.secretRefs) ||
        JSON.stringify(authorized.environmentBundleRefs) !==
          JSON.stringify(command.environmentBundleRefs)
      ) throw new InvalidRemoteWorkerSecretDeliveryError(
        'repository authority does not match command',
      );
    } catch (error) {
      if (
        error instanceof RemoteWorkerSecretDeliveryFenceRejectedError ||
        error instanceof RemoteWorkerSecretDeliveryUnavailableError
      ) throw error;
      throw new RemoteWorkerSecretDeliveryUnavailableError();
    }
    let resolution;
    try {
      resolution = await this.secrets.resolve(authorized);
    } catch {
      throw new RemoteWorkerSecretDeliveryUnavailableError();
    }
    if (!resolution) throw new RemoteWorkerSecretDeliveryUnavailableError();
    try {
      if (
        typeof resolution !== 'object' ||
        Array.isArray(resolution) ||
        Object.keys(resolution).some((key) =>
          key !== 'values' && key !== 'environmentBundles' && key !== 'dispose') ||
        (resolution.dispose !== undefined &&
          typeof resolution.dispose !== 'function')
      ) throw new InvalidRemoteWorkerSecretDeliveryError(
        'provider response shape is invalid',
      );
      const body = createRemoteWorkerSecretDeliveryResponseBody({
        runId: authorized.runId,
        attemptId: authorized.attemptId,
        offerId: authorized.offerId,
        executionDigest: authorized.executionDigest,
        values: resolution.values,
        environmentBundles: resolution.environmentBundles,
      }, {
        secretRefs: authorized.secretRefs,
        environmentBundleRefs: authorized.environmentBundleRefs,
      });
      return Object.freeze({
        runId: body.runId,
        attemptId: body.attemptId,
        offerId: body.offerId,
        executionDigest: body.executionDigest,
        values: body.values,
        environmentBundles: body.environmentBundles,
        ...(resolution.dispose === undefined
          ? {}
          : { dispose: resolution.dispose }),
      });
    } catch (error) {
      try { await resolution.dispose?.(); } catch { /* preserve root */ }
      if (error instanceof InvalidRemoteWorkerSecretDeliveryError) {
        throw new RemoteWorkerSecretDeliveryUnavailableError();
      }
      throw error;
    }
  }
}
