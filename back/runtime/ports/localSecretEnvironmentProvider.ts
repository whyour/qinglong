import type { RunDispatchCandidate } from '../domain/runDispatchCandidate';

export interface LocalSecretEnvironmentRequest {
  candidate: Readonly<RunDispatchCandidate>;
  secretRefs: readonly string[];
}

/** Returns plaintext only in memory, positionally aligned to secretRefs. */
export interface LocalSecretEnvironmentProvider {
  resolve(
    request: Readonly<LocalSecretEnvironmentRequest>,
  ): Promise<readonly string[] | null>;
}
