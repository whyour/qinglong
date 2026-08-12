import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { resolveQingLong3ClusterProductContextArguments } from './productContext';

export interface QingLong3ClusterProductCommandDefinition {
  readonly name: string;
  readonly binary: string;
  readonly target: string;
  readonly description: string;
}

export type QingLong3ClusterProductCommandResolution =
  | Readonly<{ kind: 'help'; output: string }>
  | Readonly<{ kind: 'version'; output: string }>
  | Readonly<{ kind: 'context-validation'; contextFile: string }>
  | Readonly<{ kind: 'context-probe'; contextFile: string }>
  | Readonly<{
      kind: 'invoke';
      command: QingLong3ClusterProductCommandDefinition;
      targetFilePath: string;
      argv: readonly string[];
    }>
  | Readonly<{
      kind: 'invalid';
      code: 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID';
      message: string;
    }>;

const PACKAGE_NAME = '@qinglong/cluster-admin';
const MAXIMUM_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const QINGLONG3_CLUSTER_PRODUCT_COMMANDS: readonly QingLong3ClusterProductCommandDefinition[] =
  Object.freeze([
    Object.freeze({
      name: 'package',
      binary: 'ql3-plugin-package-client',
      target: 'plugin-package/management/pluginPackageManagementClientCli.js',
      description: 'manage Plugin Packages through the authenticated API',
    }),
    Object.freeze({
      name: 'package-kubernetes',
      binary: 'ql3-plugin-package-client-kubernetes',
      target:
        'plugin-package/management/pluginPackageManagementKubernetesClientCli.js',
      description: 'manage Plugin Packages through a bounded Kubernetes tunnel',
    }),
    Object.freeze({
      name: 'worker-credential',
      binary: 'ql3-worker-credential-client',
      target: 'worker-credential/workerCredentialManagementClientCli.js',
      description: 'manage Worker credentials through the authenticated API',
    }),
    Object.freeze({
      name: 'approval',
      binary: 'ql3-approval-client',
      target: 'approval-management/approvalManagementClientCli.js',
      description: 'inspect and decide human approvals',
    }),
    Object.freeze({
      name: 'run',
      binary: 'ql3-run-client',
      target: 'run-management/runManagementClientCli.js',
      description: 'retry or stop Runs under strong authentication',
    }),
    Object.freeze({
      name: 'automation',
      binary: 'ql3-automation-client',
      target: 'automation-management/automationManagementClientCli.js',
      description: 'manage Task and Trigger definitions',
    }),
    Object.freeze({
      name: 'model-credential',
      binary: 'ql3-provider-credential-client',
      target:
        'model-provider-credential/modelProviderCredentialManagementClientCli.js',
      description: 'manage model provider credentials',
    }),
  ]);

function installationPaths(moduleDirectory: string): Readonly<{
  distRoot: string;
  packageRoot: string;
  packageManifestPath: string;
}> {
  const distRoot = resolve(moduleDirectory, '..');
  const packageRoot = resolve(distRoot, '..');
  return Object.freeze({
    distRoot,
    packageRoot,
    packageManifestPath: resolve(packageRoot, 'package.json'),
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
  definition: QingLong3ClusterProductCommandDefinition,
): string {
  const lexicalTarget = resolve(distRoot, definition.target);
  if (!isInside(distRoot, lexicalTarget)) {
    throw new Error('Cluster product command target escapes package dist root');
  }
  const targetStatus = lstatSync(lexicalTarget, { throwIfNoEntry: false });
  if (
    targetStatus === undefined ||
    !targetStatus.isFile() ||
    targetStatus.isSymbolicLink()
  ) {
    throw new Error('Cluster product command target is unavailable');
  }
  const canonicalDistRoot = realpathSync(distRoot);
  const canonicalTarget = realpathSync(lexicalTarget);
  if (!isInside(canonicalDistRoot, canonicalTarget)) {
    throw new Error(
      'Cluster product command target escapes canonical package root',
    );
  }
  return lexicalTarget;
}

export function loadQingLong3ClusterProductVersion(
  moduleDirectory: string,
): string {
  const { packageRoot, packageManifestPath } =
    installationPaths(moduleDirectory);
  const status = lstatSync(packageManifestPath, { throwIfNoEntry: false });
  if (
    status === undefined ||
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > MAXIMUM_PACKAGE_MANIFEST_BYTES ||
    realpathSync(packageManifestPath) !==
      resolve(realpathSync(packageRoot), 'package.json')
  ) {
    throw new Error('Cluster product package manifest is unavailable');
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
    throw new Error('Cluster product package identity is invalid');
  }
  return manifest.version;
}

export function qingLong3ClusterProductHelp(): string {
  const longestName = Math.max(
    ...QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(({ name }) => name.length),
  );
  const commands = QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(
    ({ name, description }) => `  ${name.padEnd(longestName)}  ${description}`,
  ).join('\n');
  return [
    'Usage: ql3-cluster-admin <command> [arguments]',
    '',
    'Remote client commands:',
    commands,
    '',
    'Local operator commands:',
    '  context validate --context=/absolute/operator-context.json',
    '  context probe    --context=/absolute/operator-context.json',
    '',
    'Use `ql3-cluster-admin <command> --help` for command-specific usage.',
    'Use `--context=/absolute/operator-context.json` to inject only stable client paths.',
    'Command and short-lived assertion files always remain explicit per invocation.',
    'Server, migration, recovery, executor and key-custody authorities remain isolated.',
  ].join('\n');
}

export function resolveQingLong3ClusterProductCommand(
  argv: readonly string[],
  moduleDirectory: string,
): QingLong3ClusterProductCommandResolution {
  if (
    argv.length === 0 ||
    (argv.length === 1 &&
      (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help'))
  ) {
    return Object.freeze({
      kind: 'help',
      output: qingLong3ClusterProductHelp(),
    });
  }
  if (argv[0] === 'context') {
    if (
      argv.length !== 3 ||
      (argv[1] !== 'validate' && argv[1] !== 'probe') ||
      !argv[2]!.startsWith('--context=') ||
      argv[2] === '--context='
    ) {
      return Object.freeze({
        kind: 'invalid',
        code: 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID',
        message: 'QingLong 3.0 Cluster product context command is invalid',
      });
    }
    const { distRoot } = installationPaths(moduleDirectory);
    for (const definition of QINGLONG3_CLUSTER_PRODUCT_COMMANDS) {
      resolveInstalledTarget(distRoot, definition);
    }
    return Object.freeze({
      kind: argv[1] === 'validate' ? 'context-validation' : 'context-probe',
      contextFile: argv[2]!.slice('--context='.length),
    });
  }
  if (
    argv.length === 1 &&
    (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version')
  ) {
    return Object.freeze({
      kind: 'version',
      output: loadQingLong3ClusterProductVersion(moduleDirectory),
    });
  }
  const command = QINGLONG3_CLUSTER_PRODUCT_COMMANDS.find(
    (candidate) => candidate.name === argv[0],
  );
  if (command === undefined) {
    return Object.freeze({
      kind: 'invalid',
      code: 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID',
      message: 'unknown QingLong 3.0 Cluster product command',
    });
  }
  const commandArguments = argv.slice(1);
  const contextArguments = commandArguments.filter(
    (argument) => argument === '--context' || argument.startsWith('--context='),
  );
  if (
    contextArguments.length > 1 ||
    contextArguments[0] === '--context' ||
    contextArguments[0] === '--context='
  ) {
    return Object.freeze({
      kind: 'invalid',
      code: 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID',
      message: 'QingLong 3.0 Cluster product context option is invalid',
    });
  }
  const forwardedArguments =
    contextArguments.length === 0
      ? Object.freeze(commandArguments)
      : resolveQingLong3ClusterProductContextArguments(
          contextArguments[0]!.slice('--context='.length),
          command.name,
          commandArguments.filter(
            (argument) => argument !== contextArguments[0],
          ),
        );
  const { distRoot } = installationPaths(moduleDirectory);
  return Object.freeze({
    kind: 'invoke',
    command,
    targetFilePath: resolveInstalledTarget(distRoot, command),
    argv: forwardedArguments,
  });
}
