import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
  createSingletonApiCredentialPepperKeyring,
  normalizeApiCredentialPepperKeyring,
  type ApiCredentialPepperKeyring,
} from '@qinglong/runtime-core/api-credential-pepper-keyring';
import { LEGACY_API_CREDENTIAL_PEPPER_KEY_ID } from '@qinglong/runtime-core/api-credential';
import {
  normalizeApiCredentialPepperReferenceKeyId,
  normalizeApiCredentialPepperReferenceLimit,
  type ApiCredentialPepperReferenceRepository,
} from '@qinglong/runtime-core/api-credential-pepper-reference';
import { normalizeIdentityAdministrationSubject } from '@qinglong/runtime-core/identity-administration';
import {
  normalizeSecurityAuditQuery,
  type SecurityAuditQuery,
  type SecurityAuditQueryPage,
  type SecurityAuditQueryRepository,
} from '@qinglong/runtime-core/security-audit-query';
import type {
  SecurityPrincipal,
  SecuritySubject,
} from '@qinglong/runtime-core/security';
import { type ClusterAdministrationService } from './clusterAdministration';
import {
  CLUSTER_ADMINISTRATION_COMMAND_RUNTIME_DEPENDENCIES,
  ClusterAdministrationCommandError,
  clusterAdministrationCommandFileBeforeAdmission,
  normalizeClusterAdministrationCommandPaths,
  publishClusterAdministrationCredentialDelivery,
} from './clusterAdministrationCommandRuntime';

export {
  ClusterAdministrationCommandError,
  publishClusterAdministrationCredentialDelivery,
};

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_VERSION = 2_147_483_646;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_PEPPER_BYTES = 256;
const MAX_PEPPER_KEYRING_BYTES = 2 * 1024;

export type ClusterAdministrationCommandOperation =
  | 'identity.register'
  | 'identity.enable'
  | 'identity.disable'
  | 'credential.issue'
  | 'credential.rotate'
  | 'credential.revoke'
  | 'pepper.references'
  | 'audit.list';

interface BaseMutationRequest {
  readonly mutationId: string;
  readonly requestId: string;
  readonly expectedCurrentVersion: number;
  readonly subject: SecuritySubject;
}

interface IdentityCommand {
  readonly schemaVersion: 1;
  readonly operation:
    | 'identity.register'
    | 'identity.enable'
    | 'identity.disable';
  readonly request: BaseMutationRequest;
}

interface CredentialCommand {
  readonly schemaVersion: 1;
  readonly operation:
    | 'credential.issue'
    | 'credential.rotate'
    | 'credential.revoke';
  readonly request: BaseMutationRequest & {
    readonly credentialId: string;
    readonly notBeforeAtMs?: number;
    readonly expiresAtMs?: number;
  };
}

interface AuditCommand {
  readonly schemaVersion: 1;
  readonly operation: 'audit.list';
  readonly request: SecurityAuditQuery;
}

interface PepperReferenceCommand {
  readonly schemaVersion: 1;
  readonly operation: 'pepper.references';
  readonly request: Readonly<{
    readonly pepperKeyId: string;
    readonly limit: number;
  }>;
}

export type ClusterAdministrationCommand =
  | IdentityCommand
  | CredentialCommand
  | PepperReferenceCommand
  | AuditCommand;

export interface ClusterAdministrationCommandPaths {
  readonly commandFile: string;
  readonly assertionFile: string;
  readonly keysetFile: string;
  readonly pepperFile?: string;
  readonly pepperKeyringFile?: string;
  readonly deliveryFile?: string;
}

export type ClusterAdministrationCommandResult =
  | Readonly<{
      schemaVersion: 1;
      operation: IdentityCommand['operation'];
      status: 'inserted' | 'existing';
      subject: Readonly<SecuritySubject>;
      version: number;
      identityStatus: 'active' | 'disabled';
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: CredentialCommand['operation'];
      status: 'inserted' | 'existing';
      subject: Readonly<SecuritySubject>;
      credentialId: string;
      version: number;
      state: 'active' | 'revoked';
      delivery?: Readonly<{ fileName: string; digest: string }>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'audit.list';
      page: Readonly<SecurityAuditQueryPage>;
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: 'pepper.references';
      pepperKeyId: string;
      observedAtMs: number;
      credentialIds: readonly string[];
      hasMore: boolean;
    }>;

export interface ClusterAdministrationCommandAuthority {
  readonly administration: ClusterAdministrationService;
  readonly audit: SecurityAuditQueryRepository;
  readonly pepperReferences: ApiCredentialPepperReferenceRepository;
  close(): Promise<void>;
}

export interface ClusterAdministrationCommandDependencies {
  readonly openAuthority: (
    environment: Readonly<Record<string, string | undefined>>,
    pepperKeyring: Readonly<ApiCredentialPepperKeyring>,
  ) => Promise<Readonly<ClusterAdministrationCommandAuthority>>;
  readonly authenticate: (
    keysetFile: string,
    assertion: string,
  ) => Promise<Readonly<SecurityPrincipal>>;
  readonly readFile: (
    filePath: string,
    maximumBytes: number,
    privateMaterial: boolean,
  ) => Buffer;
  readonly publishDelivery: (filePath: string, bytes: Buffer) => void;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAdministrationCommandError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterAdministrationCommandError(`${label} shape is invalid`);
  }
}

function strictUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ClusterAdministrationCommandError(
      `${label} must be strict UTF-8`,
      error,
    );
  }
}

function normalizeMutationRequest(
  value: unknown,
  activeCredential: boolean,
  credential: boolean,
): BaseMutationRequest & {
  readonly credentialId?: string;
  readonly notBeforeAtMs?: number;
  readonly expiresAtMs?: number;
} {
  exactObject(
    value,
    [
      'expectedCurrentVersion',
      'mutationId',
      'requestId',
      'subject',
      ...(credential ? ['credentialId'] : []),
      ...(activeCredential ? ['notBeforeAtMs', 'expiresAtMs'] : []),
    ],
    'request',
  );
  let subject: Readonly<SecuritySubject>;
  try {
    subject = normalizeIdentityAdministrationSubject(
      value.subject as SecuritySubject,
    );
  } catch (error) {
    throw new ClusterAdministrationCommandError('subject is invalid', error);
  }
  if (
    typeof value.mutationId !== 'string' ||
    !UUID_V4_PATTERN.test(value.mutationId) ||
    typeof value.requestId !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !Number.isSafeInteger(value.expectedCurrentVersion) ||
    (value.expectedCurrentVersion as number) < 0 ||
    (value.expectedCurrentVersion as number) > MAX_VERSION ||
    (credential &&
      (typeof value.credentialId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.credentialId))) ||
    (activeCredential &&
      (!Number.isSafeInteger(value.notBeforeAtMs) ||
        (value.notBeforeAtMs as number) < 0 ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        (value.expiresAtMs as number) <= (value.notBeforeAtMs as number)))
  ) {
    throw new ClusterAdministrationCommandError('mutation request is invalid');
  }
  return Object.freeze({
    mutationId: value.mutationId,
    requestId: value.requestId,
    expectedCurrentVersion: value.expectedCurrentVersion as number,
    subject,
    ...(credential ? { credentialId: value.credentialId as string } : {}),
    ...(activeCredential
      ? {
          notBeforeAtMs: value.notBeforeAtMs as number,
          expiresAtMs: value.expiresAtMs as number,
        }
      : {}),
  });
}

export function normalizeClusterAdministrationCommand(
  value: unknown,
): Readonly<ClusterAdministrationCommand> {
  exactObject(value, ['operation', 'request', 'schemaVersion'], 'command');
  const operations: readonly ClusterAdministrationCommandOperation[] = [
    'identity.register',
    'identity.enable',
    'identity.disable',
    'credential.issue',
    'credential.rotate',
    'credential.revoke',
    'pepper.references',
    'audit.list',
  ];
  if (
    value.schemaVersion !== 1 ||
    typeof value.operation !== 'string' ||
    !operations.includes(
      value.operation as ClusterAdministrationCommandOperation,
    )
  ) {
    throw new ClusterAdministrationCommandError(
      'command version or operation is invalid',
    );
  }
  const operation = value.operation as ClusterAdministrationCommandOperation;
  if (operation === 'pepper.references') {
    exactObject(value.request, ['limit', 'pepperKeyId'], 'pepper reference');
    try {
      return Object.freeze({
        schemaVersion: 1 as const,
        operation,
        request: Object.freeze({
          pepperKeyId: normalizeApiCredentialPepperReferenceKeyId(
            value.request.pepperKeyId as string,
          ),
          limit: normalizeApiCredentialPepperReferenceLimit(
            value.request.limit as number,
          ),
        }),
      });
    } catch (error) {
      throw new ClusterAdministrationCommandError(
        'pepper reference query is invalid',
        error,
      );
    }
  }
  if (operation === 'audit.list') {
    let request: Readonly<SecurityAuditQuery>;
    try {
      request = normalizeSecurityAuditQuery(
        value.request as SecurityAuditQuery,
      );
    } catch (error) {
      throw new ClusterAdministrationCommandError(
        'audit query is invalid',
        error,
      );
    }
    return Object.freeze({ schemaVersion: 1, operation, request });
  }
  const credential = operation.startsWith('credential.');
  const activeCredential =
    operation === 'credential.issue' || operation === 'credential.rotate';
  return Object.freeze({
    schemaVersion: 1,
    operation,
    request: normalizeMutationRequest(
      value.request,
      activeCredential,
      credential,
    ),
  } as ClusterAdministrationCommand);
}

function parseCommand(bytes: Buffer): Readonly<ClusterAdministrationCommand> {
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8(bytes, 'command file'));
  } catch (error) {
    if (error instanceof ClusterAdministrationCommandError) throw error;
    throw new ClusterAdministrationCommandError(
      'command file must contain JSON',
      error,
    );
  }
  return normalizeClusterAdministrationCommand(value);
}

function credentialDelivery(
  command: CredentialCommand,
  token: string,
  result: Awaited<ReturnType<ClusterAdministrationService['issueCredential']>>,
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-cluster-api-credential-delivery',
      operation: command.operation,
      mutationId: command.request.mutationId,
      requestId: command.request.requestId,
      credentialId: result.credential.credentialId,
      subject: result.credential.subject,
      version: result.credential.version,
      token,
      notBeforeAtMs: result.credential.notBeforeAtMs,
      expiresAtMs: result.credential.expiresAtMs,
    })}\n`,
    'utf8',
  );
}

export function createClusterAdministrationCommandRunner(
  dependencies: ClusterAdministrationCommandDependencies = CLUSTER_ADMINISTRATION_COMMAND_RUNTIME_DEPENDENCIES,
): Readonly<{
  run(
    paths: ClusterAdministrationCommandPaths,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<Readonly<ClusterAdministrationCommandResult>>;
}> {
  exactObject(
    dependencies,
    ['authenticate', 'openAuthority', 'publishDelivery', 'readFile'],
    'dependencies',
  );
  if (
    typeof dependencies.openAuthority !== 'function' ||
    typeof dependencies.authenticate !== 'function' ||
    typeof dependencies.readFile !== 'function' ||
    typeof dependencies.publishDelivery !== 'function'
  ) {
    throw new ClusterAdministrationCommandError('dependencies are invalid');
  }
  return Object.freeze({
    async run(pathsValue, environment) {
      const commandFile =
        clusterAdministrationCommandFileBeforeAdmission(pathsValue);
      const commandBytes = dependencies.readFile(
        commandFile,
        MAX_COMMAND_BYTES,
        true,
      );
      let command: Readonly<ClusterAdministrationCommand>;
      try {
        command = parseCommand(commandBytes);
      } finally {
        commandBytes.fill(0);
      }
      const requiresDelivery =
        command.operation === 'credential.issue' ||
        command.operation === 'credential.rotate';
      const paths = normalizeClusterAdministrationCommandPaths(
        pathsValue,
        requiresDelivery,
      );
      const assertionBytes = dependencies.readFile(
        paths.assertionFile,
        MAX_ASSERTION_BYTES,
        true,
      );
      const pepperKeyringBytes = dependencies.readFile(
        paths.pepperKeyringFile ?? paths.pepperFile!,
        paths.pepperKeyringFile === undefined
          ? MAX_PEPPER_BYTES
          : MAX_PEPPER_KEYRING_BYTES,
        true,
      );
      let authority:
        | Readonly<ClusterAdministrationCommandAuthority>
        | undefined;
      try {
        const assertion = strictUtf8(assertionBytes, 'assertion file').trim();
        let pepperKeyring: Readonly<ApiCredentialPepperKeyring>;
        if (paths.pepperKeyringFile === undefined) {
          pepperKeyring = createSingletonApiCredentialPepperKeyring(
            strictUtf8(pepperKeyringBytes, 'pepper file').trim(),
            LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
          );
        } else {
          try {
            pepperKeyring = normalizeApiCredentialPepperKeyring(
              JSON.parse(
                strictUtf8(pepperKeyringBytes, 'pepper keyring file'),
              ),
            );
          } catch (error) {
            throw new ClusterAdministrationCommandError(
              'pepper keyring file is invalid',
              error,
            );
          }
        }
        const principal = await dependencies.authenticate(
          paths.keysetFile,
          assertion,
        );
        authority = await dependencies.openAuthority(
          environment,
          pepperKeyring,
        );
        if (command.operation === 'pepper.references') {
          void principal;
          const inspection = await authority.pepperReferences.inspect(
            command.request.pepperKeyId,
            command.request.limit,
          );
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            ...inspection,
          });
        }
        if (command.operation === 'audit.list') {
          // Successful verification is the short-lived admin admission. Audit
          // queries remain read-only and use the repository's bounded contract.
          void principal;
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            page: await authority.audit.list(command.request),
          });
        }
        if (command.operation.startsWith('identity.')) {
          const identityCommand = command as Readonly<IdentityCommand>;
          const operation = identityCommand.operation.slice(
            'identity.'.length,
          ) as 'register' | 'enable' | 'disable';
          const result = await authority.administration[
            operation === 'register'
              ? 'registerIdentity'
              : operation === 'enable'
              ? 'enableIdentity'
              : 'disableIdentity'
          ]({ ...identityCommand.request, principal });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: identityCommand.operation,
            status: result.status,
            subject: result.identity.subject,
            version: result.identity.version,
            identityStatus: result.identity.status,
          });
        }
        const credentialCommand = command as Readonly<CredentialCommand>;
        const method =
          credentialCommand.operation === 'credential.issue'
            ? 'issueCredential'
            : credentialCommand.operation === 'credential.rotate'
            ? 'rotateCredential'
            : 'revokeCredential';
        const result = await authority.administration[method]({
          ...credentialCommand.request,
          principal,
        } as never);
        let delivery:
          | Readonly<{ fileName: string; digest: string }>
          | undefined;
        if (typeof result.token === 'string') {
          const bytes = credentialDelivery(
            credentialCommand,
            result.token,
            result,
          );
          try {
            dependencies.publishDelivery(paths.deliveryFile!, bytes);
            delivery = Object.freeze({
              fileName: basename(paths.deliveryFile!),
              digest: createHash('sha256').update(bytes).digest('hex'),
            });
          } finally {
            bytes.fill(0);
          }
        }
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: credentialCommand.operation,
          status: result.status,
          subject: result.credential.subject,
          credentialId: result.credential.credentialId,
          version: result.credential.version,
          state: result.credential.state,
          ...(delivery === undefined ? {} : { delivery }),
        });
      } finally {
        assertionBytes.fill(0);
        pepperKeyringBytes.fill(0);
        await authority?.close();
      }
    },
  });
}
