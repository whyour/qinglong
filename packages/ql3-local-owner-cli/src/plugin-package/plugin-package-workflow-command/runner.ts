import {
  type AuthenticatedLocalCommand,
  type LocalPluginPackageWorkflowAdministrationService,
  createLocalPluginPackageWorkflowAdministrationService,
  establishAuthenticatedLocalCommand,
  openLocalSqlitePluginPackageWorkflowAdministrationDatabase,
} from './runnerAuthority';
import {
  type LocalPluginPackageWorkflowCommandResult,
  type LocalPluginPackageWorkflowCommandRunner,
  type LocalPluginPackageWorkflowCommandRunnerDependencies,
} from './contracts';
import { readCommandFile } from './codec';
import { activateFence, dependencies, failureAudit } from './executionSupport';

export function createLocalPluginPackageWorkflowCommandRunner(
  candidateDependencies: LocalPluginPackageWorkflowCommandRunnerDependencies = {
    openDatabase: openLocalSqlitePluginPackageWorkflowAdministrationDatabase,
    authenticate: establishAuthenticatedLocalCommand,
    createService: createLocalPluginPackageWorkflowAdministrationService,
    now: Date.now,
  },
): LocalPluginPackageWorkflowCommandRunner {
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
            authenticationNamespace: 'local_plugin_package_workflow',
          });
          await activateFence(database, authenticated);
          const service: LocalPluginPackageWorkflowAdministrationService =
            adapters.createService(
              database.projectPolicy,
              database.automationPublications,
              database.materializedRevisions,
              database.workflowAdministration,
              database.securityAudit,
              { now: adapters.now },
            );
          if (command.operation === 'workflow.inspect') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.inspect({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: command.request.projectId,
              packageName: command.request.packageName,
              ...result,
            });
          }
          if (command.operation === 'workflow.cancel') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.cancel({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              ...result,
            });
          }
          if (command.operation === 'workflow.run.inspect') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.inspectRun({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: result.projectId,
              packageName: result.packageName,
              workflowId: result.workflowId,
              runId: result.runId,
              found: result.found,
              run: result.run,
              stepCount: result.stepCount,
              stepStatusCounts: result.stepStatusCounts,
            });
          }
          if (command.operation === 'workflow.run.list') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.listRuns({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: result.projectId,
              packageName: result.packageName,
              workflowId: result.workflowId,
              after: result.after,
              runs: result.runs,
              truncated: result.truncated,
              next: result.next,
            });
          }
          if (command.operation === 'workflow.step.list') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.listStepRuns({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: result.projectId,
              packageName: result.packageName,
              workflowId: result.workflowId,
              runId: result.runId,
              found: result.found,
              stepRuns: result.stepRuns,
              truncated: result.truncated,
              next: result.next,
            });
          }
          if (command.operation === 'workflow.event.list') {
            const { failureAuditEventId: _failure, ...request } =
              command.request;
            const result = await service.listRunEvents({
              ...request,
              principal: authenticated.principal,
            });
            return Object.freeze({
              schemaVersion: 1 as const,
              operation: command.operation,
              projectId: result.projectId,
              packageName: result.packageName,
              workflowId: result.workflowId,
              runId: result.runId,
              found: result.found,
              afterSequence: result.afterSequence,
              headSequence: result.headSequence,
              events: result.events,
              truncated: result.truncated,
              nextAfterSequence: result.nextAfterSequence,
            });
          }
          const { failureAuditEventId: _failure, ...request } = command.request;
          const result = await service.start({
            ...request,
            principal: authenticated.principal,
          });
          return Object.freeze({
            schemaVersion: 1 as const,
            operation: command.operation,
            status: result.status,
            projectId: result.plan.target.projectId,
            packageName: result.plan.target.packageName,
            workflowId: result.plan.target.workflowId,
            runId: result.plan.runId,
            stepCount: result.plan.steps.length,
            admittedAtMs: result.receipt.admittedAtMs,
          });
        } catch (error) {
          const audit = failureAudit(
            command,
            authenticated,
            error,
            adapters.now(),
          );
          if (audit) await database.securityAudit.record(audit);
          throw error;
        }
      } finally {
        await database.close();
      }
    },
  });
}

export function runLocalPluginPackageWorkflowCommandFile(
  commandFilePath: string,
): Promise<LocalPluginPackageWorkflowCommandResult> {
  return createLocalPluginPackageWorkflowCommandRunner().run(commandFilePath);
}
