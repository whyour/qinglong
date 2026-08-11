/** Content-free Prompt Output external recovery verifier boundary. */
import {
  verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial,
  type PluginPackagePromptOutputAuthorizedExternalRecoveryProof,
} from '@qinglong/ai/plugin-package-prompt-output-external-recovery-authorization';

import type { ClusterPromptOutputExternalRecoveryInput } from './promptOutputExternalRecoveryInput';

export class ClusterPromptOutputExternalRecoveryVerifierConfigError extends TypeError {
  readonly code = 'QL3_PROMPT_OUTPUT_EXTERNAL_RECOVERY_VERIFIER_CONFIG_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Prompt output external recovery verifier configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPromptOutputExternalRecoveryVerifierConfigError';
  }
}

export function runClusterPromptOutputExternalRecoveryVerifier(
  input: Readonly<ClusterPromptOutputExternalRecoveryInput>,
  verifiedAtMs = Date.now(),
): Readonly<PluginPackagePromptOutputAuthorizedExternalRecoveryProof> {
  if (!Number.isSafeInteger(verifiedAtMs) || verifiedAtMs < 0) {
    throw new ClusterPromptOutputExternalRecoveryVerifierConfigError(
      'verification time is invalid',
    );
  }
  try {
    return verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial({
      authorization: input.authorization,
      trustedApprovers: input.approverPublicKeys,
      receipt: input.receipt,
      trustedCustodyPublicKey: input.custodyPublicKey,
      wrappedMaterial: input.wrappedMaterial,
      durableKeyFact: input.durableKeyFact,
      material: input.material,
      artifact: input.artifact,
      verifiedAtMs,
    });
  } catch (cause) {
    throw new ClusterPromptOutputExternalRecoveryVerifierConfigError(
      'recovery evidence is untrusted',
      cause,
    );
  }
}
