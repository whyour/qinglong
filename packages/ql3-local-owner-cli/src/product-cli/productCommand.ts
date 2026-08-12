import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface QingLong3ProductCommandDefinition {
  readonly name: string;
  readonly binary: string;
  readonly target: string;
  readonly description: string;
}

export type QingLong3ProductCommandResolution =
  | Readonly<{ kind: 'help'; output: string }>
  | Readonly<{ kind: 'version'; output: string }>
  | Readonly<{
      kind: 'invoke';
      command: QingLong3ProductCommandDefinition;
      targetFilePath: string;
      argv: readonly string[];
    }>
  | Readonly<{
      kind: 'invalid';
      code: 'QL3_PRODUCT_CLI_USAGE_INVALID';
      message: string;
    }>;

const PACKAGE_NAME = '@qinglong/local-owner-cli';
const MAXIMUM_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const QINGLONG3_PRODUCT_COMMANDS: readonly QingLong3ProductCommandDefinition[] =
  Object.freeze([
    Object.freeze({
      name: 'setup',
      binary: 'ql3-local-setup',
      target: 'lifecycle/localSetupCli.js',
      description: 'prepare Local storage and owner material',
    }),
    Object.freeze({
      name: 'readiness',
      binary: 'ql3-local-readiness',
      target: 'lifecycle/localReadinessCli.js',
      description: 'inspect Local schema and runtime readiness',
    }),
    Object.freeze({
      name: 'deploy',
      binary: 'ql3-local-deploy',
      target: 'deployment/localDeploymentCli.js',
      description: 'run the bounded Local deployment ceremony',
    }),
    Object.freeze({
      name: 'owner',
      binary: 'ql3-owner',
      target: 'cli.js',
      description: 'manage the Local Owner ceremony',
    }),
    Object.freeze({
      name: 'identity',
      binary: 'ql3-identity',
      target: 'security-management/identityCredentialCli.js',
      description: 'manage identities and API credentials',
    }),
    Object.freeze({
      name: 'policy',
      binary: 'ql3-policy',
      target: 'security-management/projectPolicyCli.js',
      description: 'manage Project policy and lifecycle',
    }),
    Object.freeze({
      name: 'audit',
      binary: 'ql3-audit',
      target: 'security-management/securityAuditQueryCli.js',
      description: 'query bounded security audit facts',
    }),
    Object.freeze({
      name: 'secret',
      binary: 'ql3-secret',
      target: 'security-management/secretCli.js',
      description: 'manage Local Secret references',
    }),
    Object.freeze({
      name: 'task',
      binary: 'ql3-task',
      target: 'automation-management/taskDefinitionCli.js',
      description: 'manage Task definitions',
    }),
    Object.freeze({
      name: 'run',
      binary: 'ql3-run',
      target: 'run-management/runManagementCli.js',
      description: 'retry or stop Runs under strong local authentication',
    }),
    Object.freeze({
      name: 'trigger',
      binary: 'ql3-trigger',
      target: 'automation-management/triggerCli.js',
      description: 'manage Trigger definitions',
    }),
    Object.freeze({
      name: 'workflow',
      binary: 'ql3-workflow',
      target: 'plugin-package/pluginPackageWorkflowCli.js',
      description: 'inspect, start, and control Package workflows',
    }),
    Object.freeze({
      name: 'approval',
      binary: 'ql3-approval',
      target: 'approval-management/approvalCli.js',
      description: 'inspect and decide Approved Actions',
    }),
    Object.freeze({
      name: 'package',
      binary: 'ql3-package',
      target: 'plugin-package/pluginPackageCli.js',
      description: 'manage Plugin Package lifecycle',
    }),
    Object.freeze({
      name: 'package-catalog',
      binary: 'ql3-package-catalog',
      target: 'plugin-package/pluginPackageCatalogCli.js',
      description: 'inspect the installed Package catalog',
    }),
    Object.freeze({
      name: 'package-trust',
      binary: 'ql3-package-trust',
      target: 'plugin-package/pluginPackagePublisherTrustCli.js',
      description: 'manage trusted Package publishers',
    }),
    Object.freeze({
      name: 'ai-feature',
      binary: 'ql3-ai-feature',
      target: 'ai-management/aiFeatureCli.js',
      description: 'activate or deactivate optional Local AI',
    }),
    Object.freeze({
      name: 'model-price',
      binary: 'ql3-model-price',
      target: 'ai-management/modelPriceCatalogCli.js',
      description: 'manage the model price catalog',
    }),
    Object.freeze({
      name: 'model-credential',
      binary: 'ql3-model-credential',
      target: 'ai-management/modelProviderCredentialCli.js',
      description: 'manage model provider credentials',
    }),
    Object.freeze({
      name: 'prompt',
      binary: 'ql3-prompt',
      target: 'plugin-package/pluginPackagePromptCli.js',
      description: 'inspect and execute Package prompts',
    }),
    Object.freeze({
      name: 'adoption',
      binary: 'ql3-adoption',
      target: 'lifecycle/adoptionCli.js',
      description: 'review and commit legacy task adoption',
    }),
  ]);

function installationPaths(moduleDirectory: string): Readonly<{
  distRoot: string;
  packageManifestPath: string;
}> {
  const distRoot = resolve(moduleDirectory, '..');
  return Object.freeze({
    distRoot,
    packageManifestPath: resolve(distRoot, '..', 'package.json'),
  });
}

function isInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function resolveInstalledTarget(
  distRoot: string,
  definition: QingLong3ProductCommandDefinition,
): string {
  const lexicalTarget = resolve(distRoot, definition.target);
  if (!isInside(distRoot, lexicalTarget)) {
    throw new Error('product command target escapes package dist root');
  }
  const targetStatus = statSync(lexicalTarget, { throwIfNoEntry: false });
  if (targetStatus === undefined || !targetStatus.isFile()) {
    throw new Error('product command target is unavailable');
  }
  const canonicalDistRoot = realpathSync(distRoot);
  const canonicalTarget = realpathSync(lexicalTarget);
  if (!isInside(canonicalDistRoot, canonicalTarget)) {
    throw new Error('product command target escapes canonical package root');
  }
  return lexicalTarget;
}

export function loadQingLong3ProductVersion(moduleDirectory: string): string {
  const { packageManifestPath } = installationPaths(moduleDirectory);
  const status = statSync(packageManifestPath, { throwIfNoEntry: false });
  if (
    status === undefined ||
    !status.isFile() ||
    status.size <= 0 ||
    status.size > MAXIMUM_PACKAGE_MANIFEST_BYTES
  ) {
    throw new Error('product package manifest is unavailable');
  }
  const manifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (
    manifest.name !== PACKAGE_NAME ||
    typeof manifest.version !== 'string' ||
    !SEMVER_PATTERN.test(manifest.version)
  ) {
    throw new Error('product package identity is invalid');
  }
  return manifest.version;
}

export function qingLong3ProductHelp(): string {
  const longestName = Math.max(
    ...QINGLONG3_PRODUCT_COMMANDS.map(({ name }) => name.length),
  );
  const commands = QINGLONG3_PRODUCT_COMMANDS.map(
    ({ name, description }) => `  ${name.padEnd(longestName)}  ${description}`,
  ).join('\n');
  return [
    'Usage: ql3 <command> [arguments]',
    '',
    'Commands:',
    commands,
    '',
    'Use `ql3 <command> --help` for command-specific usage.',
    'Root service mutation remains isolated in `ql3-service-bridge`.',
  ].join('\n');
}

export function resolveQingLong3ProductCommand(
  argv: readonly string[],
  moduleDirectory: string,
): QingLong3ProductCommandResolution {
  if (
    argv.length === 0 ||
    (argv.length === 1 &&
      (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help'))
  ) {
    return Object.freeze({ kind: 'help', output: qingLong3ProductHelp() });
  }
  if (
    argv.length === 1 &&
    (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version')
  ) {
    return Object.freeze({
      kind: 'version',
      output: loadQingLong3ProductVersion(moduleDirectory),
    });
  }
  const commandName = argv[0];
  const command = QINGLONG3_PRODUCT_COMMANDS.find(
    (candidate) => candidate.name === commandName,
  );
  if (command === undefined) {
    return Object.freeze({
      kind: 'invalid',
      code: 'QL3_PRODUCT_CLI_USAGE_INVALID',
      message: 'unknown QingLong 3.0 product command',
    });
  }
  const { distRoot } = installationPaths(moduleDirectory);
  return Object.freeze({
    kind: 'invoke',
    command,
    targetFilePath: resolveInstalledTarget(distRoot, command),
    argv: Object.freeze(argv.slice(1)),
  });
}
