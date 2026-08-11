import { establishAuthenticatedLocalCommand } from '@qinglong/local-owner-console/authenticated-command';
import {
  openLocalSqliteMcpReadDatabase,
  type LocalSqliteMcpReadDatabase,
} from '@qinglong/local-sqlite/mcp-read-database';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import {
  createQingLongLocalMcpServer,
  type QingLongLocalMcpServerDependencies,
} from '../application-runtime/mcpServer';
import { readLocalMcpServerConfig, type LocalMcpServerConfig } from './config';

export interface OpenProductionLocalMcpServerOptions {
  readonly configFilePath: string;
}

export interface ActiveProductionLocalMcpServer {
  readonly config: Readonly<LocalMcpServerConfig>;
  createServer(): ReturnType<typeof createQingLongLocalMcpServer>;
  close(): Promise<void>;
}

export interface ProductionLocalMcpServerAdapters {
  readonly readConfig: typeof readLocalMcpServerConfig;
  readonly openDatabase: typeof openLocalSqliteMcpReadDatabase;
  readonly authenticate: typeof establishAuthenticatedLocalCommand;
}

function validateOptions(options: OpenProductionLocalMcpServerOptions): void {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    typeof options.configFilePath !== 'string'
  ) {
    throw new TypeError('Production local MCP server options are invalid');
  }
}

function validateAdapters(adapters: ProductionLocalMcpServerAdapters): void {
  if (
    !adapters ||
    typeof adapters !== 'object' ||
    Array.isArray(adapters) ||
    typeof adapters.readConfig !== 'function' ||
    typeof adapters.openDatabase !== 'function' ||
    typeof adapters.authenticate !== 'function'
  ) {
    throw new TypeError('Production local MCP server adapters are invalid');
  }
}

/** Opens one optional MCP process authority without starting a network listener. */
export async function openProductionLocalMcpServer(
  options: OpenProductionLocalMcpServerOptions,
  adapters: ProductionLocalMcpServerAdapters = {
    readConfig: readLocalMcpServerConfig,
    openDatabase: openLocalSqliteMcpReadDatabase,
    authenticate: establishAuthenticatedLocalCommand,
  },
): Promise<Readonly<ActiveProductionLocalMcpServer>> {
  validateOptions(options);
  validateAdapters(adapters);
  const config = adapters.readConfig(options.configFilePath);
  let database: LocalSqliteMcpReadDatabase | undefined;
  try {
    database = await adapters.openDatabase({
      databasePath: config.databasePath,
      profile: config.profile,
      ...(config.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: config.busyTimeoutMs }),
    });
    const activeDatabase = database;
    const policy = new ProjectPolicyEngine(activeDatabase.projectPolicy);
    const serverDependencies: QingLongLocalMcpServerDependencies = {
      projectId: config.projectId,
      authenticate: () =>
        adapters.authenticate(activeDatabase, {
          deploymentRoot: config.deploymentRoot,
          databasePath: config.databasePath,
          ownerPepperKeyringDirectory: config.ownerPepperKeyringDirectory,
          credentialFilePath: config.credentialFilePath,
          authenticationNamespace: 'mcp_read',
        }),
      policy,
      audit: activeDatabase.securityAudit,
      runs: activeDatabase.runs,
      stepRuns: activeDatabase.stepRuns,
      taskDefinitions: activeDatabase.taskDefinitions,
      triggers: activeDatabase.triggers,
      approvals: activeDatabase.approvals,
    };
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      config,
      createServer: () => createQingLongLocalMcpServer(serverDependencies),
      close() {
        const closing = closePromise ?? activeDatabase.close();
        closePromise = closing;
        return closing;
      },
    });
  } catch (error) {
    if (database) {
      try {
        await database.close();
      } catch {
        // Preserve the startup failure.
      }
    }
    throw error;
  }
}
