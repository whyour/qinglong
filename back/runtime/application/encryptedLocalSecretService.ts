import { timingSafeEqual } from 'crypto';
import {
  decodeLocalSecretPlaintext,
  decryptLocalSecretEnvelopeToBuffer,
  encryptLocalSecretEnvelope,
  type LocalSecretNonceFactory,
} from '../adapters/crypto/aes256GcmLocalSecret';
import {
  LOCAL_SECRET_ALGORITHM,
  LocalSecretMutationConflictError,
  LocalSecretUnavailableError,
  LocalSecretVersionConflictError,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
  assertLocalSecretKeyId,
  createLocalSecretRef,
  parseLocalSecretRef,
  type LocalSecretEnvelope,
} from '../domain/localSecret';
import { assertRunDispatchCandidate } from '../domain/runDispatchCandidate';
import type { LocalSecretEnvelopeRepository } from '../ports/localSecretEnvelopeRepository';
import type {
  LocalSecretEnvironmentProvider,
  LocalSecretEnvironmentRequest,
} from '../ports/localSecretEnvironmentProvider';
import type {
  LocalSecretKeyMaterial,
  LocalSecretKeyProvider,
} from '../ports/localSecretKeyProvider';

export interface PutEncryptedLocalSecretCommand {
  projectId: string;
  name: string;
  plaintext: string;
  mutationId: string;
  expectedCurrentVersion: number;
  createdAtMs: number;
}

export interface PutEncryptedLocalSecretResult {
  status: 'inserted' | 'existing';
  version: number;
  secretRef: string;
}

export { LocalSecretMutationConflictError, LocalSecretVersionConflictError };

function assertPutCommand(command: PutEncryptedLocalSecretCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Local Secret write command must be an object');
  }
  assertLocalSecretProjectId(command.projectId);
  assertLocalSecretName(command.name);
  assertLocalSecretPlaintext(command.plaintext);
  assertLocalSecretMutationId(command.mutationId);
  if (
    !Number.isSafeInteger(command.expectedCurrentVersion) ||
    command.expectedCurrentVersion < 0 ||
    command.expectedCurrentVersion >= 2_147_483_647
  ) {
    throw new TypeError('Local Secret expected current version is invalid');
  }
  if (!Number.isSafeInteger(command.createdAtMs) || command.createdAtMs < 0) {
    throw new TypeError('Local Secret creation time is invalid');
  }
}

function ownedKeyMaterial(
  material: LocalSecretKeyMaterial | null,
  expectedKeyId?: string,
): { keyId: string; key: Buffer } {
  if (!material || !(material.key instanceof Uint8Array)) {
    throw new LocalSecretUnavailableError();
  }
  try {
    assertLocalSecretKeyId(material.keyId);
    if (
      (expectedKeyId !== undefined && material.keyId !== expectedKeyId) ||
      material.key.byteLength !== 32
    ) {
      throw new LocalSecretUnavailableError();
    }
    return { keyId: material.keyId, key: Buffer.from(material.key) };
  } catch {
    throw new LocalSecretUnavailableError();
  } finally {
    material.key.fill(0);
  }
}

function plaintextMatches(
  envelope: LocalSecretEnvelope,
  key: Uint8Array,
  expected: string,
): boolean {
  const actual = decryptLocalSecretEnvelopeToBuffer(envelope, key);
  const wanted = Buffer.from(expected, 'utf8');
  try {
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  } finally {
    actual.fill(0);
    wanted.fill(0);
  }
}

export class EncryptedLocalSecretService
  implements LocalSecretEnvironmentProvider
{
  constructor(
    private readonly envelopes: LocalSecretEnvelopeRepository,
    private readonly keys: LocalSecretKeyProvider,
    private readonly nonceFactory?: LocalSecretNonceFactory,
  ) {}

  async put(
    command: PutEncryptedLocalSecretCommand,
  ): Promise<PutEncryptedLocalSecretResult> {
    assertPutCommand(command);
    try {
      return await this.putValidated(command);
    } catch (error) {
      if (
        error instanceof LocalSecretVersionConflictError ||
        error instanceof LocalSecretMutationConflictError ||
        error instanceof LocalSecretUnavailableError
      ) {
        throw error;
      }
      throw new LocalSecretUnavailableError();
    }
  }

  private async putValidated(
    command: PutEncryptedLocalSecretCommand,
  ): Promise<PutEncryptedLocalSecretResult> {
    const existing = await this.envelopes.findByMutation(
      command.projectId,
      command.name,
      command.mutationId,
    );
    if (existing) {
      const material = ownedKeyMaterial(
        await this.keys.resolve(existing.keyId),
        existing.keyId,
      );
      try {
        if (
          existing.version !== command.expectedCurrentVersion + 1 ||
          !plaintextMatches(existing, material.key, command.plaintext)
        ) {
          throw new LocalSecretMutationConflictError();
        }
      } finally {
        material.key.fill(0);
      }
      return this.result('existing', existing);
    }

    const material = ownedKeyMaterial(await this.keys.active());
    try {
      const envelope = encryptLocalSecretEnvelope(
        {
          projectId: command.projectId,
          name: command.name,
          version: command.expectedCurrentVersion + 1,
          mutationId: command.mutationId,
          keyId: material.keyId,
          algorithm: LOCAL_SECRET_ALGORITHM,
          createdAtMs: command.createdAtMs,
        },
        command.plaintext,
        material.key,
        this.nonceFactory,
      );
      const appended = await this.envelopes.append({
        envelope,
        expectedCurrentVersion: command.expectedCurrentVersion,
      });
      if (appended.status === 'existing') {
        const existingMaterial =
          appended.envelope.keyId === material.keyId
            ? material
            : ownedKeyMaterial(
                await this.keys.resolve(appended.envelope.keyId),
                appended.envelope.keyId,
              );
        try {
          if (
            appended.envelope.version !== command.expectedCurrentVersion + 1 ||
            !plaintextMatches(
              appended.envelope,
              existingMaterial.key,
              command.plaintext,
            )
          ) {
            throw new LocalSecretMutationConflictError();
          }
        } finally {
          if (existingMaterial !== material) existingMaterial.key.fill(0);
        }
      }
      return this.result(appended.status, appended.envelope);
    } finally {
      material.key.fill(0);
    }
  }

  async resolve(
    request: Readonly<LocalSecretEnvironmentRequest>,
  ): Promise<readonly string[] | null> {
    const cachedKeys = new Map<string, Buffer>();
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new LocalSecretUnavailableError();
      }
      assertRunDispatchCandidate(request.candidate);
      if (
        !Array.isArray(request.secretRefs) ||
        request.secretRefs.length > 64
      ) {
        throw new LocalSecretUnavailableError();
      }
      const references = request.secretRefs.map(parseLocalSecretRef);
      if (
        references.some(
          (reference) => reference.projectId !== request.candidate.projectId,
        )
      ) {
        throw new LocalSecretUnavailableError();
      }
      const envelopes = await this.envelopes.resolveMany(references);
      if (
        envelopes.length !== references.length ||
        envelopes.some((item) => !item)
      ) {
        return null;
      }
      const plaintext: string[] = [];
      for (const envelope of envelopes as readonly LocalSecretEnvelope[]) {
        let key = cachedKeys.get(envelope.keyId);
        if (!key) {
          const material = ownedKeyMaterial(
            await this.keys.resolve(envelope.keyId),
            envelope.keyId,
          );
          key = material.key;
          cachedKeys.set(envelope.keyId, key);
        }
        const bytes = decryptLocalSecretEnvelopeToBuffer(envelope, key);
        try {
          plaintext.push(decodeLocalSecretPlaintext(bytes));
        } finally {
          bytes.fill(0);
        }
      }
      return Object.freeze(plaintext);
    } catch (error) {
      if (error instanceof LocalSecretUnavailableError) throw error;
      throw new LocalSecretUnavailableError();
    } finally {
      for (const key of cachedKeys.values()) key.fill(0);
      cachedKeys.clear();
    }
  }

  private result(
    status: PutEncryptedLocalSecretResult['status'],
    envelope: LocalSecretEnvelope,
  ): PutEncryptedLocalSecretResult {
    return Object.freeze({
      status,
      version: envelope.version,
      secretRef: createLocalSecretRef({
        projectId: envelope.projectId,
        name: envelope.name,
        version: envelope.version,
      }),
    });
  }
}
