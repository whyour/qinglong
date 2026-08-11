import {
  type ActiveModelGatewayCapability,
  BoundModelProviderCredentialProvider,
  EncryptedLocalSecretService,
  LocalModelProviderCredentialRepository,
  LocalSecretKeyringFileProvider,
  type LocalSqliteOptionalFeatureRuntimeDatabase,
  type ModelGatewayProviderAuthority,
  type PluginPackagePromptExecutionPlan,
  loadProjectedModelGatewayProviderAuthority,
} from './supportAuthority';
import {
  type ExecuteLocalPluginPackagePromptCommand,
  LocalPluginPackagePromptCommandConfigurationError,
  type LocalPluginPackagePromptCommandRunnerDependencies,
  LocalPluginPackagePromptUnavailableError,
} from './contracts';

export async function defaultLoadProviders(
  input: Readonly<{
    database: LocalSqliteOptionalFeatureRuntimeDatabase;
    command: Readonly<ExecuteLocalPluginPackagePromptCommand>;
    now: () => number;
  }>,
): Promise<ModelGatewayProviderAuthority> {
  const credentials = new LocalModelProviderCredentialRepository(
    input.database.authority,
    { now: input.now },
  );
  const secrets = new EncryptedLocalSecretService(
    input.database.localSecrets,
    new LocalSecretKeyringFileProvider(input.command.options.secretKeyringPath),
  );
  return loadProjectedModelGatewayProviderAuthority({
    configFile: input.command.options.providerAuthorityFilePath,
    credentials: new BoundModelProviderCredentialProvider({
      bindings: credentials,
      audit: credentials,
      secrets,
      now: input.now,
    }),
  });
}

export function dependencies(
  value: LocalPluginPackagePromptCommandRunnerDependencies,
): Readonly<LocalPluginPackagePromptCommandRunnerDependencies> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['authenticate', 'loadProviders', 'now', 'openDatabase']
        .sort()
        .join('\0') ||
    typeof value.openDatabase !== 'function' ||
    typeof value.authenticate !== 'function' ||
    typeof value.loadProviders !== 'function' ||
    typeof value.now !== 'function'
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'runner dependencies are invalid',
    );
  }
  return Object.freeze({ ...value });
}

export async function stopGateway(
  capability: ActiveModelGatewayCapability | undefined,
): Promise<void> {
  if (!capability) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await capability.stop()) === 'stopped') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new LocalPluginPackagePromptUnavailableError();
}

export function assertReplayRequest(
  plan: Readonly<PluginPackagePromptExecutionPlan>,
  command: Readonly<ExecuteLocalPluginPackagePromptCommand>,
): void {
  const request = command.request;
  if (
    plan.target.projectId !== request.projectId ||
    plan.target.packageName !== request.packageName ||
    plan.target.promptId !== request.promptId ||
    plan.traceId !== request.traceId ||
    plan.provider !== request.provider ||
    plan.model !== request.model ||
    plan.maxOutputTokens !== request.maxOutputTokens ||
    plan.temperature !== (request.temperature ?? null) ||
    plan.output?.mode !== request.output.mode ||
    (request.output.mode === 'durable_artifact' &&
      (plan.output?.mode !== 'durable_artifact' ||
        JSON.stringify(plan.output.retentionPolicy) !==
          JSON.stringify(request.output.retentionPolicy)))
  ) {
    throw new LocalPluginPackagePromptCommandConfigurationError(
      'request conflicts with the durable Prompt plan',
    );
  }
}
