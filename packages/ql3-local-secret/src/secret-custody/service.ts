import { normalizeLocalDispatchCandidate } from '@qinglong/runtime-core/local-dispatch';
import {
  LOCAL_SECRET_ALGORITHM,
  MAX_LOCAL_SECRET_BATCH_SIZE,
  LocalSecretMutationConflictError,
  LocalSecretUnavailableError,
  LocalSecretVersionConflictError,
  assertLocalSecretExpectedVersion,
  assertLocalSecretMutationId,
  assertLocalSecretName,
  assertLocalSecretPlaintext,
  assertLocalSecretProjectId,
  createLocalSecretRef,
  parseLocalSecretRef,
  type LocalSecretEnvelope,
  type LocalSecretEnvelopeRepository,
  type LocalSecretEnvironmentProvider,
  type LocalSecretKeyProvider,
  type PutEncryptedLocalSecretCommand,
  type PutEncryptedLocalSecretResult,
} from '@qinglong/runtime-core/local-secret';
import {
  decodeLocalSecretPlaintext,
  decryptLocalSecretEnvelopeToBuffer,
  encryptLocalSecretEnvelope,
  type LocalSecretNonceFactory,
} from './crypto';
import {
  localSecretPlaintextMatches,
  ownedLocalSecretKeyMaterial,
} from './keyMaterial';

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function assertPutCommand(command: PutEncryptedLocalSecretCommand): void {
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    !exactKeys(command, [
      'projectId',
      'name',
      'plaintext',
      'mutationId',
      'expectedCurrentVersion',
      'createdAtMs',
    ])
  ) {
    throw new TypeError('Local Secret write command is invalid');
  }
  assertLocalSecretProjectId(command.projectId);
  assertLocalSecretName(command.name);
  assertLocalSecretPlaintext(command.plaintext);
  assertLocalSecretMutationId(command.mutationId);
  assertLocalSecretExpectedVersion(command.expectedCurrentVersion);
  if (!Number.isSafeInteger(command.createdAtMs) || command.createdAtMs < 0) {
    throw new TypeError('Local Secret creation time is invalid');
  }
}

export interface LocalProjectSecretMaterialRequest {
  readonly projectId: string;
  readonly secretRef: string;
  readonly signal?: AbortSignal;
}

export interface LocalProjectSecretMaterial {
  readonly secretRef: string;
  readonly bytes: Uint8Array;
  dispose(): void | Promise<void>;
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
    const existing = await this.envelopes.findLocalSecretEnvelopeByMutation(
      command.projectId,
      command.name,
      command.mutationId,
    );
    if (existing) {
      const material = ownedLocalSecretKeyMaterial(
        await this.keys.resolve(existing.keyId),
        existing.keyId,
      );
      try {
        if (
          existing.version !== command.expectedCurrentVersion + 1 ||
          !localSecretPlaintextMatches(
            existing,
            material.key,
            command.plaintext,
          )
        ) {
          throw new LocalSecretMutationConflictError();
        }
      } finally {
        material.key.fill(0);
      }
      return this.result('existing', existing);
    }

    const material = ownedLocalSecretKeyMaterial(await this.keys.active());
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
      const appended = await this.envelopes.appendLocalSecretEnvelope({
        envelope,
        expectedCurrentVersion: command.expectedCurrentVersion,
      });
      if (appended.status === 'existing') {
        const existingMaterial =
          appended.envelope.keyId === material.keyId
            ? material
            : ownedLocalSecretKeyMaterial(
                await this.keys.resolve(appended.envelope.keyId),
                appended.envelope.keyId,
              );
        try {
          if (
            appended.envelope.version !== command.expectedCurrentVersion + 1 ||
            !localSecretPlaintextMatches(
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

  async resolveLocalSecretEnvironment(request: {
    readonly candidate: Parameters<
      LocalSecretEnvironmentProvider['resolveLocalSecretEnvironment']
    >[0]['candidate'];
    readonly secretRefs: readonly string[];
  }): Promise<readonly string[] | null> {
    const cachedKeys = new Map<string, Buffer>();
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new LocalSecretUnavailableError();
      }
      const candidate = normalizeLocalDispatchCandidate(request.candidate);
      if (
        !Array.isArray(request.secretRefs) ||
        request.secretRefs.length > MAX_LOCAL_SECRET_BATCH_SIZE
      ) {
        throw new LocalSecretUnavailableError();
      }
      const references = request.secretRefs.map(parseLocalSecretRef);
      if (
        references.some(
          (reference) => reference.projectId !== candidate.projectId,
        )
      ) {
        throw new LocalSecretUnavailableError();
      }
      const envelopes = await this.envelopes.resolveLocalSecretEnvelopes(
        references,
      );
      if (
        envelopes.length !== references.length ||
        envelopes.some((item) => item === null)
      ) {
        return null;
      }
      const plaintext: string[] = [];
      for (const envelope of envelopes as readonly LocalSecretEnvelope[]) {
        let key = cachedKeys.get(envelope.keyId);
        if (!key) {
          const material = ownedLocalSecretKeyMaterial(
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

  async resolveProjectSecretMaterial(
    request: Readonly<LocalProjectSecretMaterialRequest>,
  ): Promise<Readonly<LocalProjectSecretMaterial> | null> {
    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        !exactKeys(
          request,
          request.signal === undefined
            ? ['projectId', 'secretRef']
            : ['projectId', 'secretRef', 'signal'],
        ) ||
        (request.signal !== undefined &&
          typeof request.signal.aborted !== 'boolean') ||
        request.signal?.aborted
      ) {
        throw new LocalSecretUnavailableError();
      }
      assertLocalSecretProjectId(request.projectId);
      const reference = parseLocalSecretRef(request.secretRef);
      if (reference.projectId !== request.projectId) {
        throw new LocalSecretUnavailableError();
      }
      const [envelope] = await this.envelopes.resolveLocalSecretEnvelopes([
        reference,
      ]);
      if (!envelope) return null;
      const material = ownedLocalSecretKeyMaterial(
        await this.keys.resolve(envelope.keyId),
        envelope.keyId,
      );
      key = material.key;
      plaintext = decryptLocalSecretEnvelopeToBuffer(envelope, key);
      const ownedPlaintext = plaintext;
      plaintext = undefined;
      let disposed = false;
      return Object.freeze({
        secretRef: request.secretRef,
        bytes: ownedPlaintext,
        dispose(): void {
          if (disposed) return;
          disposed = true;
          ownedPlaintext.fill(0);
        },
      });
    } catch (error) {
      plaintext?.fill(0);
      if (error instanceof LocalSecretUnavailableError) throw error;
      throw new LocalSecretUnavailableError();
    } finally {
      key?.fill(0);
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
