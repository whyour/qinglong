import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import {
  API_CREDENTIAL_SECRET_BYTES,
  FileLocalCredentialAdministrationDelivery,
  LocalIdentityCredentialAdministrationUnavailableError,
  LocalOwnerPepperKeyringFileProvider,
  apiCredentialSecretDigest,
  createLocalIdentityCredentialAdministrationService,
  establishAuthenticatedLocalCommand,
  openLocalSqliteIdentityCredentialAdministrationDatabase,
  type ApiCredentialRecord,
  type AuthenticatedLocalCommand,
  type LocalCredentialAdministrationDeliveryRecord,
} from './executionAuthority';
import {
  LocalIdentityCredentialCommandConfigurationError,
  LocalIdentityCredentialCommandCurrentCredentialError,
  LocalIdentityCredentialCommandPepperUnavailableError,
  type LocalApiCredentialInspectionCommand,
  type LocalApiCredentialIssueCommand,
  type LocalApiCredentialRevokeCommand,
  type LocalCredentialDeliveryAcknowledgeCommand,
  type LocalIdentityAdministrationCommand,
  type LocalIdentityCredentialCommandResult,
  type LocalIdentityCredentialCommandRunner,
  type LocalIdentityCredentialCommandRunnerDependencies,
  type LocalIdentityInspectionCommand,
} from './contracts';
import { readCommandFile } from './codec';
import {
  activateFence,
  activeCredentialResult,
  clock,
  dependencies,
  failureAudit,
  sameSubject,
} from './executionSupport';

export function createLocalIdentityCredentialCommandRunner(
  candidateDependencies: LocalIdentityCredentialCommandRunnerDependencies = {
    openDatabase: openLocalSqliteIdentityCredentialAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalIdentityCredentialAdministrationService,
    createDelivery: (directory) =>
      new FileLocalCredentialAdministrationDelivery(directory),
    createPepperProvider: (directory) =>
      new LocalOwnerPepperKeyringFileProvider(directory),
    randomBytes: cryptoRandomBytes,
    now: Date.now,
  },
): LocalIdentityCredentialCommandRunner {
  const adapters = dependencies(candidateDependencies);
  return Object.freeze({
    async run(commandFilePath: string) {
      const command = readCommandFile(commandFilePath);
      const database = await adapters.openDatabase({
        databasePath: command.options.databasePath,
        profile: command.options.profile,
        ...(command.options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: command.options.busyTimeoutMs }),
      });
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      try {
        try {
          authenticated = await adapters.authenticate(database, {
            deploymentRoot: command.options.deploymentRoot,
            databasePath: command.options.databasePath,
            ownerPepperKeyringDirectory:
              command.options.ownerPepperKeyringDirectory,
            credentialFilePath: command.options.credentialFilePath,
            authenticationNamespace: 'local_identity_admin',
          });
          await activateFence(database, authenticated);
          const commandNowMs = clock(adapters.now);
          const service = adapters.createService(
            database.projectPolicy,
            database.identityCredentialAdministration,
            { now: () => commandNowMs },
          );

          if (command.operation === 'identity.inspect') {
            const inspectCommand =
              command as Readonly<LocalIdentityInspectionCommand>;
            const result = await service.inspectIdentity({
              projectId: inspectCommand.request.projectId,
              target: inspectCommand.request.target,
              auditEventId: inspectCommand.request.auditEventId,
              requestId: inspectCommand.request.requestId,
              principal: authenticated.principal,
            });
            if (!result.identity) {
              return Object.freeze({
                schemaVersion: 1 as const,
                operation: inspectCommand.operation,
                projectId: inspectCommand.request.projectId,
                found: false as const,
              });
            }
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: inspectCommand.operation,
              projectId: inspectCommand.request.projectId,
              found: true as const,
              target: result.identity.subject,
              version: result.identity.version,
              identityStatus: result.identity.status,
              createdAtMs: result.identity.createdAtMs,
              updatedAtMs: result.identity.updatedAtMs,
            });
          }

          if (command.operation === 'credential.inspect') {
            const inspectCommand =
              command as Readonly<LocalApiCredentialInspectionCommand>;
            const result = await service.inspectCredential({
              projectId: inspectCommand.request.projectId,
              credentialId: inspectCommand.request.credentialId,
              auditEventId: inspectCommand.request.auditEventId,
              requestId: inspectCommand.request.requestId,
              principal: authenticated.principal,
            });
            if (!result.credential) {
              return Object.freeze({
                schemaVersion: 1 as const,
                operation: inspectCommand.operation,
                projectId: inspectCommand.request.projectId,
                found: false as const,
              });
            }
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: inspectCommand.operation,
              projectId: inspectCommand.request.projectId,
              found: true as const,
              credentialId: result.credential.credentialId,
              target: result.credential.subject,
              version: result.credential.version,
              state: result.credential.state,
              subjectStatus: result.credential.subjectStatus,
              createdAtMs: result.credential.createdAtMs,
              notBeforeAtMs: result.credential.notBeforeAtMs,
              expiresAtMs: result.credential.expiresAtMs,
            });
          }

          if (command.operation.startsWith('identity.')) {
            const identityCommand =
              command as Readonly<LocalIdentityAdministrationCommand>;
            const result = await service.changeIdentity({
              projectId: identityCommand.request.projectId,
              operation: identityCommand.operation.slice('identity.'.length) as
                | 'register'
                | 'enable'
                | 'disable',
              target: identityCommand.request.target,
              expectedCurrentVersion:
                identityCommand.request.expectedCurrentVersion,
              mutationId: identityCommand.request.mutationId,
              requestId: identityCommand.request.requestId,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: identityCommand.operation,
              status: result.status,
              projectId: identityCommand.request.projectId,
              target: result.identity.subject,
              version: result.identity.version,
              identityStatus: result.identity.status,
            });
          }

          if (
            command.operation === 'credential.issue' ||
            command.operation === 'credential.rotate'
          ) {
            const credentialCommand =
              command as Readonly<LocalApiCredentialIssueCommand>;
            const active = await database.ownerPepper.resolveActive();
            if (!active) {
              throw new LocalIdentityCredentialCommandPepperUnavailableError();
            }
            const key = await database.ownerPepper.resolveKey(
              active.activePepperKeyId,
            );
            const pepper = adapters
              .createPepperProvider(
                credentialCommand.options.ownerPepperKeyringDirectory,
              )
              .resolve(active.activePepperKeyId);
            if (
              !key ||
              key.state !== 'active' ||
              key.materialDigest !== active.materialDigest ||
              !pepper ||
              pepper.summary.digest !== active.materialDigest
            ) {
              throw new LocalIdentityCredentialCommandPepperUnavailableError();
            }
            const material = adapters.randomBytes(API_CREDENTIAL_SECRET_BYTES);
            if (
              !Buffer.isBuffer(material) ||
              material.byteLength !== API_CREDENTIAL_SECRET_BYTES
            ) {
              material?.fill?.(0);
              throw new LocalIdentityCredentialCommandConfigurationError(
                'random source returned invalid credential material',
              );
            }
            let prepared: Readonly<LocalCredentialAdministrationDeliveryRecord>;
            try {
              const delivery = adapters.createDelivery(
                credentialCommand.options.credentialDeliveryDirectory,
              );
              prepared = delivery.prepare({
                schemaVersion: 1,
                kind: 'qinglong3-local-managed-credential-delivery',
                mutationId: credentialCommand.request.mutationId,
                requestId: credentialCommand.request.requestId,
                projectId: credentialCommand.request.projectId,
                subject: credentialCommand.request.target,
                credentialId: credentialCommand.request.credentialId,
                secret: material.toString('base64url'),
                notBeforeAtMs: commandNowMs,
                expiresAtMs:
                  commandNowMs + credentialCommand.request.lifetimeMs,
              });
              const deliveryDigest = delivery.digest(prepared);
              const result = await service.changeCredential({
                projectId: credentialCommand.request.projectId,
                operation:
                  credentialCommand.operation === 'credential.issue'
                    ? 'issue'
                    : 'rotate',
                credentialId: credentialCommand.request.credentialId,
                target: credentialCommand.request.target,
                expectedCurrentVersion:
                  credentialCommand.request.expectedCurrentVersion,
                pepperKeyId: active.activePepperKeyId,
                secretDigest: apiCredentialSecretDigest(
                  pepper.pepper,
                  credentialCommand.request.credentialId,
                  prepared.secret,
                ),
                deliveryDigest,
                notBeforeAtMs: prepared.notBeforeAtMs,
                expiresAtMs: prepared.expiresAtMs,
                mutationId: credentialCommand.request.mutationId,
                requestId: credentialCommand.request.requestId,
                principal: authenticated.principal,
              });
              const published = delivery.publish(prepared, deliveryDigest);
              return activeCredentialResult(
                credentialCommand,
                result,
                published,
              );
            } finally {
              material.fill(0);
            }
          }

          if (command.operation === 'credential.revoke') {
            const credentialCommand =
              command as Readonly<LocalApiCredentialRevokeCommand>;
            const current: Readonly<ApiCredentialRecord> | null =
              await database.apiCredentials.resolve(
                credentialCommand.request.credentialId,
              );
            if (
              !current ||
              !sameSubject(current.subject, credentialCommand.request.target)
            ) {
              throw new LocalIdentityCredentialCommandCurrentCredentialError();
            }
            const result = await service.changeCredential({
              projectId: credentialCommand.request.projectId,
              operation: 'revoke',
              credentialId: credentialCommand.request.credentialId,
              target: credentialCommand.request.target,
              expectedCurrentVersion:
                credentialCommand.request.expectedCurrentVersion,
              pepperKeyId: current.pepperKeyId,
              mutationId: credentialCommand.request.mutationId,
              requestId: credentialCommand.request.requestId,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: credentialCommand.operation,
              status: result.status,
              projectId: credentialCommand.request.projectId,
              target: result.credential.subject,
              credentialId: result.credential.credentialId,
              version: result.credential.version,
              state: result.credential.state,
              expiresAtMs: result.credential.expiresAtMs,
            });
          }

          const acknowledgementCommand =
            command as Readonly<LocalCredentialDeliveryAcknowledgeCommand>;
          const result = await service.acknowledgeCredentialDelivery({
            projectId: acknowledgementCommand.request.projectId,
            credentialMutationId:
              acknowledgementCommand.request.credentialMutationId,
            expectedDeliveryDigest:
              acknowledgementCommand.request.expectedDeliveryDigest,
            mutationId: acknowledgementCommand.request.mutationId,
            requestId: acknowledgementCommand.request.requestId,
            principal: authenticated.principal,
          });
          const acknowledgement = result.acknowledgement;
          if (
            acknowledgement.credentialMutationId !==
              acknowledgementCommand.request.credentialMutationId ||
            acknowledgement.acknowledgementMutationId !==
              acknowledgementCommand.request.mutationId ||
            acknowledgement.projectId !==
              acknowledgementCommand.request.projectId ||
            acknowledgement.deliveryDigest !==
              acknowledgementCommand.request.expectedDeliveryDigest
          ) {
            throw new LocalIdentityCredentialAdministrationUnavailableError();
          }
          const cleanup = adapters
            .createDelivery(
              acknowledgementCommand.options.credentialDeliveryDirectory,
            )
            .removeAcknowledged(
              acknowledgement.credentialMutationId,
              acknowledgement.deliveryDigest,
            );
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: acknowledgementCommand.operation,
            status: result.status,
            projectId: acknowledgement.projectId,
            credentialMutationId: acknowledgement.credentialMutationId,
            acknowledgementMutationId:
              acknowledgement.acknowledgementMutationId,
            deliveryDigest: acknowledgement.deliveryDigest,
            cleanup,
          });
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            clock(adapters.now),
          );
          if (audit) {
            await database.identityCredentialAdministration.record(audit);
          }
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalIdentityCredentialCommandFile(
  commandFilePath: string,
): Promise<Readonly<LocalIdentityCredentialCommandResult>> {
  return createLocalIdentityCredentialCommandRunner().run(commandFilePath);
}
