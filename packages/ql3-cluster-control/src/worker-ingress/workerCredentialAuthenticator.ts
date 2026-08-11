// Cluster Control Worker Ingress boundary; keep Worker credential authentication explicit.
import { timingSafeEqual } from 'node:crypto';
import {
  WorkerCredentialUnavailableError,
  normalizeWorkerCredentialRecord,
  type WorkerCredentialRepository,
} from '@qinglong/runtime-core/worker-credential';
import {
  assertWorkerCredentialPepper,
  workerCredentialSecretDigest,
} from '@qinglong/runtime-core/worker-credential-token';
import type { ClusterControlAdmissionMetadata } from '../transport/httpSurface';

export interface AuthenticatedWorkerPrincipal {
  readonly workerId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly authenticationId: string;
  readonly authenticatedAtMs: number;
  readonly expiresAtMs: number;
}

export interface WorkerCredentialAuthenticator {
  authenticate(
    metadata: ClusterControlAdmissionMetadata,
  ): Promise<Readonly<AuthenticatedWorkerPrincipal> | null>;
}

const AUTHORIZATION =
  /^Worker ql3w_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;

export function createWorkerCredentialAuthenticator(
  repository: WorkerCredentialRepository,
  pepper: string,
  options: Readonly<{ now?: () => number; principalTtlMs?: number }> = {},
): WorkerCredentialAuthenticator {
  if (!repository || typeof repository.resolve !== 'function') {
    throw new TypeError('Worker credential authenticator repository is invalid');
  }
  assertWorkerCredentialPepper(pepper);
  const now = options.now ?? Date.now;
  const principalTtlMs = options.principalTtlMs ?? 60_000;
  if (
    !Number.isSafeInteger(principalTtlMs) ||
    principalTtlMs < 1_000 ||
    principalTtlMs > 300_000
  ) {
    throw new RangeError('Worker credential principal TTL is invalid');
  }

  return Object.freeze({
    async authenticate(metadata: ClusterControlAdmissionMetadata) {
      const header = metadata.headers.authorization;
      if (typeof header !== 'string') return null;
      const match = AUTHORIZATION.exec(header);
      if (!match) return null;
      let presented: Buffer | undefined;
      try {
        presented = Buffer.from(
          workerCredentialSecretDigest(pepper, match[1]!, match[2]!),
          'hex',
        );
        const candidate = await repository.resolve(match[1]!);
        if (metadata.signal.aborted) throw new WorkerCredentialUnavailableError();
        const record = candidate ? normalizeWorkerCredentialRecord(candidate) : null;
        const stored = record
          ? Buffer.from(record.secretDigest, 'hex')
          : Buffer.alloc(32);
        const matches = timingSafeEqual(presented, stored);
        stored.fill(0);
        if (!record || !matches) return null;
        const nowMs = now();
        if (
          !Number.isSafeInteger(nowMs) ||
          nowMs < 0 ||
          record.state !== 'active' ||
          record.notBeforeAtMs > nowMs ||
          record.expiresAtMs <= nowMs
        ) return null;
        return Object.freeze({
          workerId: record.workerId,
          credentialId: record.credentialId,
          credentialVersion: record.version,
          authenticationId: `worker_credential:${record.credentialId}:${record.version}`,
          authenticatedAtMs: nowMs,
          expiresAtMs: Math.min(record.expiresAtMs, nowMs + principalTtlMs),
        });
      } catch (error) {
        if (error instanceof WorkerCredentialUnavailableError) throw error;
        throw new WorkerCredentialUnavailableError();
      } finally {
        presented?.fill(0);
      }
    },
  });
}
