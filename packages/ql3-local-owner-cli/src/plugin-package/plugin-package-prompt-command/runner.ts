import {
  type ActiveModelGatewayCapability,
  type AuthenticatedLocalCommand,
  type AuthorizedPluginPackagePromptExecutionInspection,
  LocalModelInvocationFeatureActivationRepository,
  LocalModelInvocationRepository,
  LocalModelPriceCatalogRepository,
  LocalPluginPackagePromptAdmissionRepository,
  LocalPluginPackagePromptExecutionInspectionRepository,
  LocalPluginPackagePromptExecutionOutputReferenceRepository,
  LocalPluginPackagePromptOutputArtifactRepository,
  LocalPluginPackagePromptOutputRetentionRepository,
  type LocalSqliteAuthenticatedUserCredentialFence,
  LocalSqliteAuthenticatedManagementFenceError,
  PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError,
  type PluginPackagePromptExecutionPlan,
  PluginPackagePromptExecutionOutputReadService,
  PluginPackagePromptExecutor,
  type PluginPackagePromptOutputArtifactReadAuthorizer,
  type PluginPackagePromptOutputCompletionCapability,
  PluginPackagePromptOutputCompletionCoordinator,
  PluginPackagePromptOutputFileKeyring,
  PluginPackagePromptOutputReadService,
  ProjectPolicyEngine,
  assertLocalModelInvocationFeatureActive,
  bootstrapModelGatewayProfile,
  commitLocalSqliteSecurityAuditInTransaction,
  confirmLocalSqliteAuthenticatedUserCredentialFence,
  confirmLocalSqliteProjectPolicyFence,
  createPluginPackagePromptCatalogResult,
  establishAuthenticatedLocalCommand,
  normalizeSecurityAuditRecord,
  openLocalSqliteOptionalFeatureRuntimeDatabase,
} from './runnerAuthority';
import {
  LocalPluginPackagePromptAuthenticationError,
  LocalPluginPackagePromptAuthorizationError,
  type LocalPluginPackagePromptCommandResult,
  LocalPluginPackagePromptCommandConfigurationError,
  type LocalPluginPackagePromptCommandRunner,
  type LocalPluginPackagePromptCommandRunnerDependencies,
  LocalPluginPackagePromptNotFoundError,
  LocalPluginPackagePromptUnavailableError,
} from './contracts';
import { readCommandFile } from './codec';
import {
  PROMPT_PERMISSIONS,
  allowedAudit,
  authorize,
  sameFence,
} from './authorization';
import {
  assertReplayRequest,
  defaultLoadProviders,
  dependencies,
  stopGateway,
} from './executionSupport';

export function createLocalPluginPackagePromptCommandRunner(
  candidateDependencies: LocalPluginPackagePromptCommandRunnerDependencies = {
    openDatabase: openLocalSqliteOptionalFeatureRuntimeDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    loadProviders: defaultLoadProviders,
    now: Date.now,
  },
): LocalPluginPackagePromptCommandRunner {
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
      let capability: ActiveModelGatewayCapability | undefined;
      let featureReady = false;
      let authenticated: Readonly<AuthenticatedLocalCommand> | undefined;
      let authorization: Awaited<ReturnType<typeof authorize>> | undefined;
      try {
        const activation =
          command.operation === 'prompt.execute'
            ? assertLocalModelInvocationFeatureActive(database.authority.client)
            : null;
        featureReady = true;
        authenticated = await adapters.authenticate(database, {
          deploymentRoot: command.options.deploymentRoot,
          databasePath: command.options.databasePath,
          ownerPepperKeyringDirectory:
            command.options.ownerPepperKeyringDirectory,
          credentialFilePath: command.options.credentialFilePath,
          authenticationNamespace: 'local_plugin_package_prompt',
        });
        await authenticated.confirm();
        const nowMs = adapters.now();
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          throw new LocalPluginPackagePromptCommandConfigurationError(
            'clock is invalid',
          );
        }
        authorization = await authorize(
          database,
          authenticated.principal,
          command.request.projectId,
          nowMs,
          command.operation === 'prompt.inspect'
            ? Object.freeze(['model.invoke'] as const)
            : command.operation === 'prompt.execution.inspect'
            ? Object.freeze(['run.read'] as const)
            : command.operation === 'prompt.execution.output.read'
            ? Object.freeze(['artifact.read'] as const)
            : PROMPT_PERMISSIONS,
        );
        const authorized = authorization;
        const credentialFence =
          authenticated.databaseFence as Readonly<LocalSqliteAuthenticatedUserCredentialFence>;
        const audit = allowedAudit(
          command,
          authorized.principal,
          authorized.decision,
          nowMs,
        );
        if (command.operation === 'prompt.inspect') {
          await database.securityAudit.record(audit);
          const publication = await database.automationPublications.findCurrent(
            command.request.projectId,
            command.request.packageName,
          );
          const catalog = createPluginPackagePromptCatalogResult(
            command.request.projectId,
            command.request.packageName,
            publication,
          );
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            projectId: catalog.projectId,
            packageName: catalog.packageName,
            found: catalog.found,
            publicationState: catalog.publicationState,
            prompts: catalog.prompts,
          });
        }
        if (command.operation === 'prompt.execution.inspect') {
          const inspections =
            new LocalPluginPackagePromptExecutionInspectionRepository(
              database.authority,
              Object.freeze({
                confirm(
                  inspection: Readonly<AuthorizedPluginPackagePromptExecutionInspection>,
                  auditReplay: boolean,
                ) {
                  try {
                    if (
                      inspection.actor.type !==
                        authorized.principal.subject.type ||
                      inspection.actor.id !== authorized.principal.subject.id ||
                      inspection.projectId !== command.request.projectId ||
                      !sameFence(inspection.fence, authorized.decision.fence)
                    ) {
                      throw new LocalSqliteAuthenticatedManagementFenceError();
                    }
                    confirmLocalSqliteAuthenticatedUserCredentialFence(
                      database.authority,
                      credentialFence,
                    );
                    confirmLocalSqliteProjectPolicyFence(
                      database.authority,
                      inspection.projectId,
                      inspection.actor,
                      inspection.fence,
                    );
                    commitLocalSqliteSecurityAuditInTransaction(
                      database.authority,
                      inspection.audit,
                      auditReplay,
                    );
                  } catch {
                    throw new PluginPackagePromptExecutionInspectionAuthorizationFenceConflictError();
                  }
                },
              }),
            );
          const result = await inspections.inspectAuthorized({
            projectId: command.request.projectId,
            packageName: command.request.packageName,
            promptId: command.request.promptId,
            executionRequestId: command.request.executionRequestId,
            actor: authorized.principal.subject,
            fence: authorized.decision.fence,
            audit,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            projectId: result.projectId,
            packageName: result.packageName,
            promptId: result.promptId,
            executionRequestId: result.executionRequestId,
            found: result.found,
            execution: result.execution,
          });
        }
        if (command.operation === 'prompt.execution.output.read') {
          await database.securityAudit.record(audit);
          const policy = new ProjectPolicyEngine(database.projectPolicy);
          const outputReader = new PluginPackagePromptOutputReadService({
            artifacts: new LocalPluginPackagePromptOutputArtifactRepository(
              database.authority,
            ),
            authorizer: Object.freeze({
              async authorize(
                request: Parameters<
                  PluginPackagePromptOutputArtifactReadAuthorizer['authorize']
                >[0],
              ) {
                const decision = await policy.authorize(
                  request.principal,
                  request.projectId,
                  'artifact.read',
                );
                return decision.effect === 'allow'
                  ? Object.freeze({ effect: 'allow' as const })
                  : Object.freeze({
                      effect: decision.effect,
                      reasonCode: 'artifact_read_denied',
                    });
              },
            }),
            retention: new LocalPluginPackagePromptOutputRetentionRepository(
              database.authority,
            ),
            keys: new PluginPackagePromptOutputFileKeyring(
              command.options.promptOutputKeyringPath,
            ),
            now: adapters.now,
          });
          const result =
            await new PluginPackagePromptExecutionOutputReadService({
              references:
                new LocalPluginPackagePromptExecutionOutputReferenceRepository(
                  database.authority,
                ),
              outputs: outputReader,
            }).read({
              principal: authorized.principal,
              projectId: command.request.projectId,
              packageName: command.request.packageName,
              promptId: command.request.promptId,
              executionRequestId: command.request.executionRequestId,
            });
          const target = Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            projectId: result.projectId,
            packageName: result.packageName,
            promptId: result.promptId,
            executionRequestId: result.executionRequestId,
          });
          return result.status === 'not_found'
            ? Object.freeze({ ...target, status: 'not_found' as const })
            : Object.freeze({
                ...target,
                status: 'available' as const,
                reference: result.reference,
                result: result.result,
              });
        }
        const admissions = new LocalPluginPackagePromptAdmissionRepository(
          database.authority,
          Object.freeze({
            confirm(
              plan: Readonly<PluginPackagePromptExecutionPlan>,
              replay: boolean,
            ) {
              if (
                plan.requestedBySubject.type !==
                  authorized.principal.subject.type ||
                plan.requestedBySubject.id !==
                  authorized.principal.subject.id ||
                plan.target.projectId !== command.request.projectId ||
                !sameFence(plan.policyFence, authorized.decision.fence)
              ) {
                throw new LocalSqliteAuthenticatedManagementFenceError();
              }
              confirmLocalSqliteAuthenticatedUserCredentialFence(
                database.authority,
                credentialFence,
              );
              confirmLocalSqliteProjectPolicyFence(
                database.authority,
                plan.target.projectId,
                plan.requestedBySubject,
                plan.policyFence,
              );
              commitLocalSqliteSecurityAuditInTransaction(
                database.authority,
                audit,
                replay,
              );
            },
          }),
        );
        const existing = await admissions.findPlanByRequestId(
          command.request.requestId,
        );
        if (existing) assertReplayRequest(existing, command);
        const publication = existing
          ? await database.automationPublications.findByDigest(
              existing.target.publicationDigest,
            )
          : await database.automationPublications.findCurrent(
              command.request.projectId,
              command.request.packageName,
            );
        if (
          !publication ||
          publication.state !== 'active' ||
          publication.target.projectId !== command.request.projectId ||
          publication.target.packageName !== command.request.packageName ||
          !publication.definitions.prompts.some(
            ({ id }) => id === command.request.promptId,
          )
        ) {
          throw new LocalPluginPackagePromptNotFoundError();
        }
        if (
          existing &&
          (!sameFence(existing.policyFence, authorization.decision.fence) ||
            existing.requestedBySubject.type !==
              authorization.principal.subject.type ||
            existing.requestedBySubject.id !==
              authorization.principal.subject.id)
        ) {
          throw new LocalPluginPackagePromptAuthorizationError();
        }
        const repository = new LocalModelInvocationRepository(
          database.authority,
        );
        const pricing = new LocalModelPriceCatalogRepository(
          database.authority,
        );
        let durableOutput:
          | PluginPackagePromptOutputCompletionCapability
          | undefined;
        const outputKeys =
          command.request.output.mode === 'durable_artifact'
            ? new PluginPackagePromptOutputFileKeyring(
                command.options.promptOutputKeyringPath!,
              )
            : undefined;
        const gateway = await bootstrapModelGatewayProfile({
          enabled: true,
          profile: command.options.profile,
          loadStorage: async () =>
            Object.freeze({
              repository,
              pricing,
              close: async () => undefined,
            }),
          loadProviders: () =>
            adapters.loadProviders({
              database,
              command,
              now: adapters.now,
            }),
          ...(outputKeys === undefined
            ? {}
            : {
                createSuccessfulCompletion: (coordinator) => {
                  durableOutput =
                    new PluginPackagePromptOutputCompletionCoordinator({
                      coordinator,
                      keys: outputKeys,
                      now: adapters.now,
                    });
                  return durableOutput;
                },
              }),
          confirmActive: async () => {
            await database.authority.enqueue(
              async () => {
                const current =
                  new LocalModelInvocationFeatureActivationRepository(
                    database.authority.client,
                  ).findCurrent();
                if (
                  activation === null ||
                  current?.state !== 'active' ||
                  current.generation !== activation.generation ||
                  current.transitionDigest !== activation.transitionDigest
                ) {
                  throw new LocalPluginPackagePromptUnavailableError();
                }
              },
              () => new LocalPluginPackagePromptUnavailableError(),
            );
          },
          audit: async () => undefined,
          maxConcurrent: 1,
          recoveryLimit: command.options.profile === 'edge' ? 4 : 16,
          now: adapters.now,
        });
        if (gateway.status !== 'active') {
          throw new LocalPluginPackagePromptUnavailableError();
        }
        capability = gateway.capability;
        const executor = new PluginPackagePromptExecutor({
          admissions,
          invocations: repository,
          gateway: capability,
          ...(durableOutput === undefined ? {} : { durableOutput }),
        });
        const plannedAtMs = existing?.plannedAtMs ?? nowMs;
        const deadlineAtMs =
          existing?.deadlineAtMs ?? plannedAtMs + command.request.timeoutMs;
        const executed = await executor.execute({
          publication,
          expectedPublicationDigest: publication.publicationDigest,
          promptId: command.request.promptId,
          requestId: command.request.requestId,
          traceId: command.request.traceId,
          requestedBySubject: authorization.principal.subject,
          policyFence: authorization.decision.fence as Readonly<{
            projectVersion: number;
            bindingVersion: number;
          }>,
          parameters: command.request.parameters,
          provider: command.request.provider,
          model: command.request.model,
          maxOutputTokens: command.request.maxOutputTokens,
          ...(command.request.temperature === undefined
            ? {}
            : { temperature: command.request.temperature }),
          plannedAtMs,
          deadlineAtMs,
          output: command.request.output,
        });
        return Object.freeze({
          schemaVersion: 1 as const,
          operation: command.operation,
          status: executed.status,
          projectId: command.request.projectId,
          packageName: command.request.packageName,
          promptId: command.request.promptId,
          requestId: executed.admission.requestId,
          invocationId: executed.admission.invocationId,
          runId: executed.admission.runId,
          stepRunId: executed.admission.stepRunId,
          planDigest: executed.admission.planDigest,
          receiptDigest: executed.admission.receiptDigest,
          finalizationDigest: executed.finalization.receiptDigest,
          runStatus: executed.finalization.runStatus,
          result: executed.result,
          ...(executed.outputArtifact === undefined
            ? {}
            : { outputArtifact: executed.outputArtifact }),
        });
      } catch (error) {
        if (featureReady) {
          const occurredAtMs = adapters.now();
          if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) {
            throw new LocalPluginPackagePromptUnavailableError();
          }
          const outcome = !authenticated
            ? ('authentication_rejected' as const)
            : error instanceof LocalPluginPackagePromptAuthorizationError
            ? ('denied' as const)
            : ('authorization_unavailable' as const);
          try {
            await database.securityAudit.record(
              normalizeSecurityAuditRecord({
                eventId: command.request.failureAuditEventId,
                requestId: command.request.requestId,
                operationId: command.operation,
                projectId: command.request.projectId,
                subject: authenticated?.principal.subject ?? null,
                authenticationId:
                  authenticated?.principal.authenticationId ?? null,
                outcome,
                reasons: [
                  !authenticated
                    ? 'strong_authentication_required'
                    : outcome === 'denied'
                    ? 'permission_missing'
                    : command.operation === 'prompt.inspect'
                    ? 'prompt_catalog_unavailable'
                    : command.operation === 'prompt.execution.inspect'
                    ? 'prompt_execution_inspection_unavailable'
                    : command.operation === 'prompt.execution.output.read'
                    ? 'prompt_execution_output_read_unavailable'
                    : 'prompt_execution_unavailable',
                ],
                fence: authorization?.decision.fence ?? null,
                occurredAtMs,
              }),
            );
          } catch (auditError) {
            throw new LocalPluginPackagePromptUnavailableError({
              cause: auditError instanceof Error ? auditError : undefined,
            });
          }
        }
        if (
          error instanceof LocalPluginPackagePromptCommandConfigurationError ||
          error instanceof LocalPluginPackagePromptAuthenticationError ||
          error instanceof LocalPluginPackagePromptAuthorizationError ||
          error instanceof LocalPluginPackagePromptNotFoundError
        ) {
          throw error;
        }
        throw new LocalPluginPackagePromptUnavailableError({
          cause: error instanceof Error ? error : undefined,
        });
      } finally {
        let stopError: unknown;
        try {
          await stopGateway(capability);
        } catch (error) {
          stopError = error;
        }
        await database.close();
        if (stopError) throw stopError;
      }
    },
  });
}

export function runLocalPluginPackagePromptCommandFile(
  commandFilePath: string,
): Promise<LocalPluginPackagePromptCommandResult> {
  return createLocalPluginPackagePromptCommandRunner().run(commandFilePath);
}
