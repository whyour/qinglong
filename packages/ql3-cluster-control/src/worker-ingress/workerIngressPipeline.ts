// Cluster Control Worker Ingress boundary; keep authenticated admission routing explicit.
import { randomUUID } from 'node:crypto';
import {
  WorkerSessionConflictError,
  WorkerSessionFenceRejectedError,
} from '@qinglong/runtime-core';
import type {
  AuthenticatedWorkerSessionRepository,
} from '@qinglong/runtime-core/worker-credential-delivery';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
} from '@qinglong/runtime-core/worker-credential-delivery';
import {
  InvalidWorkerSessionTransportError,
  createWorkerSessionHeartbeatResponseBody,
  createWorkerSessionRegisterResponseBody,
  createWorkerSessionTransitionResponseBody,
  parseWorkerSessionHeartbeatRequestBody,
  parseWorkerSessionRegisterRequestBody,
  parseWorkerSessionTransitionRequestBody,
} from '@qinglong/runtime-core/worker-session-transport';
import {
  WorkerExecutionAttestationFenceRejectedError,
  WorkerExecutionAttestationUnavailableError,
  type WorkerExecutionAttestationRepository,
} from '@qinglong/runtime-core/worker-attestation';
import {
  WorkerCredentialUnavailableError,
} from '@qinglong/runtime-core/worker-credential';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditSink,
} from '@qinglong/runtime-core/security-audit';
import type {
  ClusterControlAdmissionMetadata,
  ClusterControlAdmissionPipeline,
  ClusterControlAdmissionResponse,
  ClusterControlStreamingAdmissionBody,
} from '../transport/httpSurface';
import type {
  AuthenticatedWorkerPrincipal,
  WorkerCredentialAuthenticator,
} from './workerCredentialAuthenticator';
import {
  ClusterRemoteWorkerOfferFenceRejectedError,
  type ClusterRemoteWorkerOfferClaimService,
} from '../remote-execution/remoteWorkerDispatcher';
import {
  RemoteRunActivationFenceRejectedError,
  RemoteRunActivationUnavailableError,
} from '@qinglong/runtime-core/remote-activation';
import {
  createRemoteRunActivationResponseBody,
  InvalidRemoteRunActivationDeliveryError,
} from '@qinglong/runtime-core/remote-activation-delivery';
import type { ClusterRemoteRunActivationService } from '../remote-execution/remoteRunActivationService';
import {
  createRemoteExecutionOfferPullBody,
  InvalidRemoteExecutionOfferDeliveryError,
} from '@qinglong/runtime-core/remote-offer-delivery';
import {
  createRemoteWorkerSecretDeliveryResponseBody,
  InvalidRemoteWorkerSecretDeliveryError,
  REMOTE_SECRET_DELIVERY_SCHEMA,
  RemoteWorkerSecretDeliveryFenceRejectedError,
  RemoteWorkerSecretDeliveryUnavailableError,
} from '@qinglong/runtime-core/remote-secret-delivery';
import type { ClusterRemoteWorkerSecretDeliveryService } from '../remote-execution/remoteWorkerSecretDeliveryService';
import {
  InvalidRemoteWorkerCompletionError,
  MAX_REMOTE_WORKER_ARTIFACT_BYTES,
  MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES,
  REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
  RemoteWorkerCompletionFenceRejectedError,
  RemoteWorkerCompletionUnavailableError,
  createRemoteWorkerArtifactUploadResponseBody,
  createRemoteWorkerCompletionResponseBody,
  parseRemoteWorkerCompletionRequestBody,
} from '@qinglong/runtime-core/remote-worker-completion';
import type {
  ClusterRemoteWorkerArtifactService,
  ClusterRemoteWorkerCompletionService,
} from '../remote-execution/remoteWorkerCompletionService';
import {
  InvalidRemoteWorkerLeaseControlError,
  RemoteWorkerLeaseControlFenceRejectedError,
  RemoteWorkerLeaseControlUnavailableError,
  createRemoteWorkerLeaseControlResponseBody,
  parseRemoteWorkerLeaseControlRequestBody,
} from '@qinglong/runtime-core/remote-worker-lease-control';
import type { ClusterRemoteWorkerLeaseControlService } from '../remote-execution/remoteWorkerLeaseControlService';

export interface WorkerIngressPipelineOptions {
  readonly authenticator: WorkerCredentialAuthenticator;
  readonly workers: AuthenticatedWorkerSessionRepository;
  readonly attestations: WorkerExecutionAttestationRepository;
  readonly audit: SecurityAuditSink;
  readonly offers?: Pick<ClusterRemoteWorkerOfferClaimService, 'claimNext'>;
  readonly activation?: Pick<
    ClusterRemoteRunActivationService,
    'acknowledgeStarting' | 'acknowledgeRunning' | 'failStart'
  >;
  readonly secrets?: Pick<ClusterRemoteWorkerSecretDeliveryService, 'deliver'>;
  readonly artifacts?: Pick<ClusterRemoteWorkerArtifactService, 'upload'>;
  readonly completion?: Pick<ClusterRemoteWorkerCompletionService, 'complete'>;
  readonly leaseControl?: Pick<ClusterRemoteWorkerLeaseControlService, 'control'>;
  readonly now?: () => number;
}

type Operation =
  | 'register'
  | 'heartbeat'
  | 'transition'
  | 'attestations'
  | 'offers'
  | 'starting'
  | 'running'
  | 'start-failure'
  | 'secrets'
  | 'artifacts'
  | 'completion'
  | 'lease-control';

interface ResolvedRoute {
  readonly workerId: string;
  readonly sessionId: string;
  readonly operation: Operation;
}

const ROUTE = /^\/api\/v3\/worker-ingress\/workers\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(register|heartbeat|transition|attestations|offers|starting|running|start-failure|secrets|artifacts|completion|lease-control)$/;

function failure(statusCode: number, code: string): Error {
  return Object.assign(new Error(code), { statusCode, code });
}

function route(metadata: ClusterControlAdmissionMetadata): ResolvedRoute {
  if (metadata.method !== 'POST' || Object.keys(metadata.query).length !== 0) {
    throw failure(404, 'worker_route_not_found');
  }
  const match = ROUTE.exec(metadata.path);
  if (!match) throw failure(404, 'worker_route_not_found');
  return Object.freeze({
    workerId: match[1]!,
    sessionId: match[2]!,
    operation: match[3]! as Operation,
  });
}

function objectBody(body: unknown | null, keys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw failure(400, 'invalid_worker_request');
  }
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) throw failure(400, 'invalid_worker_request');
  return body as Record<string, unknown>;
}

async function audit(
  sink: SecurityAuditSink,
  metadata: ClusterControlAdmissionMetadata,
  operation: Operation,
  principal: Readonly<AuthenticatedWorkerPrincipal> | null,
  outcome: 'authentication_rejected' | 'authentication_unavailable' | 'allowed',
  now: () => number,
): Promise<void> {
  await sink.record(normalizeSecurityAuditRecord({
    eventId: randomUUID(),
    requestId: metadata.requestId,
    operationId: `worker.${operation}`,
    projectId: null,
    subject: principal ? { type: 'worker', id: principal.workerId } : null,
    authenticationId: principal?.authenticationId ?? null,
    outcome,
    reasons: [outcome === 'allowed' ? 'worker_credential' : outcome],
    fence: null,
    occurredAtMs: now(),
  }));
}

function response(statusCode: number, body: unknown): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body });
}

function mapIngressFailure(error: unknown): never {
  if (error && typeof error === 'object' && 'statusCode' in error) throw error;
  if (
    error instanceof WorkerSessionConflictError ||
    error instanceof WorkerSessionFenceRejectedError ||
    error instanceof WorkerCredentialDeliveryConflictError
  ) throw failure(409, 'worker_session_fenced');
  if (error instanceof WorkerExecutionAttestationFenceRejectedError) {
    throw failure(409, 'worker_attestation_fenced');
  }
  if (error instanceof ClusterRemoteWorkerOfferFenceRejectedError) {
    throw failure(409, 'worker_offer_fenced');
  }
  if (error instanceof RemoteRunActivationFenceRejectedError) {
    throw failure(409, 'worker_activation_fenced');
  }
  if (error instanceof RemoteWorkerSecretDeliveryFenceRejectedError) {
    throw failure(409, 'worker_secret_delivery_fenced');
  }
  if (error instanceof RemoteWorkerCompletionFenceRejectedError) {
    throw failure(409, 'worker_completion_fenced');
  }
  if (error instanceof RemoteWorkerLeaseControlFenceRejectedError) {
    throw failure(409, 'worker_lease_control_fenced');
  }
  if (error instanceof InvalidRemoteWorkerCompletionError) {
    throw failure(400, 'invalid_worker_request');
  }
  if (error instanceof InvalidRemoteWorkerLeaseControlError) {
    throw failure(400, 'invalid_worker_request');
  }
  if (error instanceof InvalidWorkerSessionTransportError) {
    throw failure(400, 'invalid_worker_request');
  }
  if (
    error instanceof InvalidRemoteExecutionOfferDeliveryError ||
    error instanceof InvalidRemoteRunActivationDeliveryError ||
    error instanceof InvalidRemoteWorkerSecretDeliveryError
  ) throw failure(503, 'worker_ingress_unavailable');
  if (
    error instanceof WorkerExecutionAttestationUnavailableError ||
    error instanceof WorkerCredentialUnavailableError ||
    error instanceof WorkerCredentialDeliveryUnavailableError ||
    error instanceof RemoteRunActivationUnavailableError ||
    error instanceof RemoteWorkerSecretDeliveryUnavailableError ||
    error instanceof RemoteWorkerCompletionUnavailableError ||
    error instanceof RemoteWorkerLeaseControlUnavailableError
  ) throw failure(503, 'worker_ingress_unavailable');
  if (error instanceof TypeError || error instanceof RangeError) {
    throw failure(400, 'invalid_worker_request');
  }
  throw failure(503, 'worker_ingress_unavailable');
}

export function createWorkerIngressAdmissionPipeline(
  options: WorkerIngressPipelineOptions,
): ClusterControlAdmissionPipeline {
  if (
    !options ||
    typeof options.authenticator?.authenticate !== 'function' ||
    typeof options.workers?.register !== 'function' ||
    typeof options.workers?.heartbeatAuthenticated !== 'function' ||
    typeof options.workers?.transitionAuthenticated !== 'function' ||
    typeof options.attestations?.submit !== 'function' ||
    typeof options.audit?.record !== 'function' ||
    (options.offers !== undefined &&
      typeof options.offers.claimNext !== 'function') ||
    (options.activation !== undefined &&
      (typeof options.activation.acknowledgeStarting !== 'function' ||
        typeof options.activation.acknowledgeRunning !== 'function' ||
        typeof options.activation.failStart !== 'function')) ||
    (options.secrets !== undefined &&
      typeof options.secrets.deliver !== 'function') ||
    (options.artifacts !== undefined &&
      typeof options.artifacts.upload !== 'function') ||
    (options.completion !== undefined &&
      typeof options.completion.complete !== 'function') ||
    (options.leaseControl !== undefined &&
      typeof options.leaseControl.control !== 'function')
  ) throw new TypeError('Worker ingress pipeline options are invalid');
  const now = options.now ?? Date.now;

  return Object.freeze({
    async prepare(metadata: ClusterControlAdmissionMetadata) {
      const resolved = route(metadata);
      let principal: Readonly<AuthenticatedWorkerPrincipal> | null;
      try {
        principal = await options.authenticator.authenticate(metadata);
      } catch {
        try { await audit(options.audit, metadata, resolved.operation, null, 'authentication_unavailable', now); } catch { /* fail below */ }
        throw failure(503, 'worker_authentication_unavailable');
      }
      if (!principal || principal.workerId !== resolved.workerId) {
        try { await audit(options.audit, metadata, resolved.operation, null, 'authentication_rejected', now); } catch { throw failure(503, 'worker_audit_unavailable'); }
        throw failure(401, 'worker_authentication_required');
      }
      try {
        await audit(options.audit, metadata, resolved.operation, principal, 'allowed', now);
      } catch {
        throw failure(503, 'worker_audit_unavailable');
      }

      if (resolved.operation === 'artifacts') {
        return Object.freeze({
          bodyMode: 'stream' as const,
          contentType: REMOTE_WORKER_ARTIFACT_CONTENT_TYPE,
          maximumBodyBytes:
            4 + MAX_REMOTE_WORKER_ARTIFACT_HEADER_BYTES +
            MAX_REMOTE_WORKER_ARTIFACT_BYTES,
          async handleStream(body: ClusterControlStreamingAdmissionBody) {
            try {
              if (!options.artifacts) {
                throw failure(503, 'worker_artifact_unavailable');
              }
              const receipt = await options.artifacts.upload({
                workerId: resolved.workerId,
                workerSessionId: resolved.sessionId,
                contentLength: body.contentLength,
                chunks: body.chunks,
                signal: metadata.signal,
              });
              return response(
                200,
                createRemoteWorkerArtifactUploadResponseBody(receipt),
              );
            } catch (error) {
              return mapIngressFailure(error);
            }
          },
        });
      }

      return Object.freeze({
        async handle(body: unknown | null) {
          try {
            if (resolved.operation === 'register') {
              const command = parseWorkerSessionRegisterRequestBody(body, {
                workerId: resolved.workerId,
                sessionId: resolved.sessionId,
              });
              const result = await options.workers.register(command);
              return response(
                200,
                createWorkerSessionRegisterResponseBody(result),
              );
            }
            if (resolved.operation === 'heartbeat') {
              const command = parseWorkerSessionHeartbeatRequestBody(body, {
                workerId: resolved.workerId,
                sessionId: resolved.sessionId,
              });
              const worker = await options.workers.heartbeatAuthenticated(
                command,
                {
                  workerId: principal.workerId,
                  credentialId: principal.credentialId,
                  credentialVersion: principal.credentialVersion,
                },
              );
              return response(
                200,
                createWorkerSessionHeartbeatResponseBody(worker),
              );
            }
            if (resolved.operation === 'transition') {
              const command = parseWorkerSessionTransitionRequestBody(body, {
                workerId: resolved.workerId,
                sessionId: resolved.sessionId,
              });
              const worker = await options.workers.transitionAuthenticated(
                command,
                {
                  workerId: principal.workerId,
                  credentialId: principal.credentialId,
                  credentialVersion: principal.credentialVersion,
                },
              );
              return response(
                200,
                createWorkerSessionTransitionResponseBody(worker),
              );
            }
            if (resolved.operation === 'offers') {
              if (!options.offers) {
                throw failure(503, 'worker_offer_unavailable');
              }
              const value = objectBody(body, [
                'workerGeneration', 'offerId', 'leaseToken',
              ]);
              const result = await options.offers.claimNext(
                { workerId: resolved.workerId },
                {
                  workerSessionId: resolved.sessionId,
                  workerGeneration: value.workerGeneration as number,
                  offerId: value.offerId as string,
                  leaseToken: value.leaseToken as string,
                },
              );
              return response(200, createRemoteExecutionOfferPullBody(result));
            }
            if (
              resolved.operation === 'starting' ||
              resolved.operation === 'start-failure'
            ) {
              if (!options.activation) {
                throw failure(503, 'worker_activation_unavailable');
              }
              const value = objectBody(body, [
                'runId', 'attemptId', 'workerGeneration', 'offerId',
                'leaseGeneration', 'leaseToken', 'expectedLeaseVersion',
              ]);
              const command = {
                runId: value.runId as string,
                attemptId: value.attemptId as string,
                workerSessionId: resolved.sessionId,
                workerGeneration: value.workerGeneration as number,
                offerId: value.offerId as string,
                leaseGeneration: value.leaseGeneration as number,
                leaseToken: value.leaseToken as string,
                expectedLeaseVersion: value.expectedLeaseVersion as number,
              };
              const activation = resolved.operation === 'starting'
                ? await options.activation.acknowledgeStarting(
                    { workerId: resolved.workerId }, command,
                  )
                : await options.activation.failStart(
                    { workerId: resolved.workerId }, command,
                  );
              return response(
                200,
                createRemoteRunActivationResponseBody(activation),
              );
            }
            if (resolved.operation === 'running') {
              if (!options.activation) {
                throw failure(503, 'worker_activation_unavailable');
              }
              const value = objectBody(body, [
                'runId', 'attemptId', 'workerGeneration', 'offerId',
                'leaseGeneration', 'leaseToken', 'expectedLeaseVersion',
                'executorHandle', 'logArtifactId', 'callbackSequence',
                'callbackTokenDigest',
              ]);
              if (
                value.logArtifactId !== null &&
                typeof value.logArtifactId !== 'string'
              ) throw failure(400, 'invalid_worker_request');
              const activation = await options.activation.acknowledgeRunning(
                { workerId: resolved.workerId },
                {
                  runId: value.runId as string,
                  attemptId: value.attemptId as string,
                  workerSessionId: resolved.sessionId,
                  workerGeneration: value.workerGeneration as number,
                  offerId: value.offerId as string,
                  leaseGeneration: value.leaseGeneration as number,
                  leaseToken: value.leaseToken as string,
                  expectedLeaseVersion: value.expectedLeaseVersion as number,
                  executorHandle: value.executorHandle as string,
                  callbackSequence: value.callbackSequence as number,
                  callbackTokenDigest: value.callbackTokenDigest as string,
                  ...(value.logArtifactId === null
                    ? {}
                    : { logArtifactId: value.logArtifactId }),
                },
              );
              return response(
                200,
                createRemoteRunActivationResponseBody(activation),
              );
            }
            if (resolved.operation === 'secrets') {
              if (!options.secrets) {
                throw failure(503, 'worker_secret_delivery_unavailable');
              }
              const value = objectBody(body, [
                'schema', 'runId', 'attemptId', 'projectId', 'taskId',
                'taskRevision', 'executionDigest', 'workerGeneration',
                'offerId', 'leaseGeneration', 'leaseToken',
                'expectedLeaseVersion', 'secretRefs', 'environmentBundleRefs',
              ]);
              if (value.schema !== REMOTE_SECRET_DELIVERY_SCHEMA) {
                throw failure(400, 'invalid_worker_request');
              }
              const delivered = await options.secrets.deliver(
                { workerId: resolved.workerId },
                {
                  workerSessionId: resolved.sessionId,
                  workerGeneration: value.workerGeneration as number,
                  runId: value.runId as string,
                  attemptId: value.attemptId as string,
                  projectId: value.projectId as string,
                  taskId: value.taskId as string,
                  taskRevision: value.taskRevision as string,
                  executionDigest: value.executionDigest as string,
                  offerId: value.offerId as string,
                  leaseGeneration: value.leaseGeneration as number,
                  leaseToken: value.leaseToken as string,
                  expectedLeaseVersion: value.expectedLeaseVersion as number,
                  secretRefs: value.secretRefs as string[],
                  environmentBundleRefs: value.environmentBundleRefs as string[],
                },
              );
              try {
                const responseBody = createRemoteWorkerSecretDeliveryResponseBody(
                  delivered,
                  {
                    secretRefs: value.secretRefs as string[],
                    environmentBundleRefs: value.environmentBundleRefs as string[],
                  },
                );
                if (
                  responseBody.runId !== value.runId ||
                  responseBody.attemptId !== value.attemptId ||
                  responseBody.offerId !== value.offerId ||
                  responseBody.executionDigest !== value.executionDigest
                ) throw new InvalidRemoteWorkerSecretDeliveryError(
                  'service response authority does not match request',
                );
                return response(
                  200,
                  responseBody,
                );
              } finally {
                try { await delivered.dispose?.(); } catch { /* response remains valid */ }
              }
            }
            if (resolved.operation === 'completion') {
              if (!options.completion) {
                throw failure(503, 'worker_completion_unavailable');
              }
              const command = parseRemoteWorkerCompletionRequestBody(body, {
                workerId: resolved.workerId,
                workerSessionId: resolved.sessionId,
              });
              const completed = await options.completion.complete(
                command,
                metadata.signal,
              );
              return response(
                200,
                createRemoteWorkerCompletionResponseBody(completed),
              );
            }
            if (resolved.operation === 'lease-control') {
              if (!options.leaseControl) {
                throw failure(503, 'worker_lease_control_unavailable');
              }
              const command = parseRemoteWorkerLeaseControlRequestBody(body, {
                workerId: resolved.workerId,
                workerSessionId: resolved.sessionId,
              });
              return response(
                200,
                createRemoteWorkerLeaseControlResponseBody(
                  await options.leaseControl.control(command),
                ),
              );
            }
            const value = objectBody(body, [
              'attestationId', 'runId', 'attemptId', 'sequence', 'state',
              'workerGeneration', 'leaseTokenDigest', 'leaseGeneration',
              'leaseVersion', 'offerId', 'callbackSequence', 'executorHandle',
              'journalRevision',
            ]);
            if (value.workerGeneration === undefined) {
              throw failure(400, 'invalid_worker_request');
            }
            const result = await options.attestations.submit({
              attestationId: value.attestationId as string,
              runId: value.runId as string,
              attemptId: value.attemptId as string,
              sequence: value.sequence as number,
              state: value.state as 'running' | 'stopped',
              workerId: resolved.workerId,
              workerSessionId: resolved.sessionId,
              workerGeneration: value.workerGeneration as number,
              leaseTokenDigest: value.leaseTokenDigest as string,
              leaseGeneration: value.leaseGeneration as number,
              leaseVersion: value.leaseVersion as number,
              offerId: value.offerId as string,
              callbackSequence: value.callbackSequence as number,
              executorHandle: value.executorHandle as string,
              journalRevision: value.journalRevision as number,
            });
            return response(result.status === 'created' ? 201 : 200, {
              attestationId: result.attestation.attestationId,
              sequence: result.attestation.sequence,
              state: result.attestation.state,
              receivedAtMs: result.attestation.receivedAtMs,
              replay: result.status === 'existing',
            });
          } catch (error) {
            return mapIngressFailure(error);
          }
        },
      });
    },
  });
}
