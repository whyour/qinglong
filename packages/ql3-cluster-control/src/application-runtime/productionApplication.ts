import { randomUUID } from 'node:crypto';
import type {
  ClusterControlStartupRecoverySummary,
  ClusterControlStopResult,
} from '@qinglong/runtime-core';
import type { RemoteWorkerSecretValueProvider } from '@qinglong/runtime-core/remote-secret-delivery';
import {
  startClusterControlApplication,
  type ClusterControlApplicationOptions,
  type ClusterControlApplicationResult,
  type ClusterControlApplicationStack,
} from './application';
import {
  createClusterControlDatabaseBinding,
  type EnabledClusterControlConfig,
} from '../production-process/config';
import {
  createClusterControlAdmissionPipeline,
  createClusterControlProjectPolicyAuthorizer,
} from '../transport/admissionPipeline';
import { createClusterControlRouteRegistry } from '../transport/routeRegistry';
import { CLUSTER_CONTROL_HTTP_DEFAULTS } from '../transport/httpSurface';
import { createClusterControlRunReadRoute } from '../run/runReadRoute';
import { createClusterControlRunListRoute } from '../run/runListRoute';
import { createClusterControlRunEventListRoute } from '../run/runEventListRoute';
import { createClusterControlRunStepListRoute } from '../run/runStepListRoute';
import { createClusterControlRunAttemptLogReadRoute } from '../run/runAttemptLogReadRoute';
import { createClusterControlTaskListRoute } from '../task/taskListRoute';
import { createClusterControlTaskReadRoute } from '../task/taskReadRoute';
import { createClusterControlTaskStartRoute } from '../task/taskStartRoute';
import {
  createClusterControlPluginPackagePromptExecutionRoute,
  type ClusterPluginPackagePromptExecutionCapability,
} from '../plugin-package/prompt/pluginPackagePromptExecutionRoute';
import {
  createClusterControlPluginPackagePromptCatalogRoute,
  type ClusterPluginPackagePromptCatalogCapability,
} from '../plugin-package/prompt/pluginPackagePromptCatalogRoute';
import {
  createClusterControlPluginPackagePromptOutputReadRoute,
  type ClusterPluginPackagePromptOutputReadCapability,
} from '../plugin-package/prompt/pluginPackagePromptOutputReadRoute';
import {
  createClusterControlPluginPackagePromptExecutionInspectionRoute,
  type ClusterPluginPackagePromptExecutionInspectionCapability,
} from '../plugin-package/prompt/pluginPackagePromptExecutionInspectionRoute';
import {
  createClusterControlPluginPackagePromptExecutionOutputReadRoute,
  type ClusterPluginPackagePromptExecutionOutputReadCapability,
} from '../plugin-package/prompt/pluginPackagePromptExecutionOutputReadRoute';
import {
  createClusterControlRunCancellationRoute,
  type ClusterRunCancellationEventIdFactory,
} from '../run/runCancellationRoute';
import type { ClusterControlAssemblyInput } from './clusterControlRuntime';
import type { ClusterRemoteWorkerArtifactStore } from '../remote-execution/remoteWorkerCompletionService';
import type { EnabledClusterWorkerIngressConfig } from '../worker-ingress/workerIngressConfig';
import {
  startProductionClusterWorkerIngress,
  type ProductionClusterWorkerIngressOptions as ProductionClusterWorkerIngressStarterOptions,
} from '../worker-ingress/productionWorkerIngress';
import type { ClusterWorkerIngressApplicationResult } from '../worker-ingress/workerIngressApplication';
import { createClusterControlPluginPackageWorkflowRoutes } from '../plugin-package/workflow/pluginPackageWorkflowRoute';

export const PRODUCTION_CLUSTER_CONTROL_ROUTE_OPERATIONS = Object.freeze([
  'task.get',
  'task.list',
  'task.start',
  'run.get',
  'run.list',
  'run.events.list',
  'run.steps.list',
  'run.log.read',
  'run.cancel',
  'workflow.read',
  'workflow.run.read',
  'workflow.run.list',
  'workflow.step.list',
  'workflow.event.list',
  'workflow.start',
  'workflow.cancel',
] as const);
export const PRODUCTION_CLUSTER_CONTROL_OPTIONAL_ROUTE_OPERATIONS =
  Object.freeze([
    'prompt.read',
    'prompt.execute',
    'prompt.execution.read',
    'prompt.execution.output.read',
    'prompt.output.read',
  ] as const);

export interface ProductionClusterControlAssemblyOptions {
  readonly createEventId?: ClusterRunCancellationEventIdFactory;
  readonly promptCatalog?: Readonly<{
    readonly capability: ClusterPluginPackagePromptCatalogCapability;
  }>;
  readonly promptExecution?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionCapability;
    readonly maxExecutionMs?: number;
    readonly now?: () => number;
  }>;
  readonly promptExecutionInspection?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionInspectionCapability;
    readonly now?: () => number;
  }>;
  readonly promptOutputRead?: Readonly<{
    readonly capability: ClusterPluginPackagePromptOutputReadCapability;
  }>;
  readonly promptExecutionOutputRead?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionOutputReadCapability;
  }>;
  readonly workerIngress?: Readonly<{
    readonly config: EnabledClusterWorkerIngressConfig;
    readonly onDiagnostic?: (error: unknown) => void | Promise<void>;
  }>;
  readonly startWorkerIngress?: (
    options: ProductionClusterWorkerIngressStarterOptions,
  ) => Promise<ClusterWorkerIngressApplicationResult>;
}

export interface ProductionClusterWorkerIngressOptions {
  readonly config: EnabledClusterWorkerIngressConfig;
  readonly artifactStore: ClusterRemoteWorkerArtifactStore;
  readonly secretProvider?: RemoteWorkerSecretValueProvider;
  readonly onDiagnostic?: (error: unknown) => void | Promise<void>;
}

export interface ProductionClusterControlApplicationOptions
  extends Omit<
    ClusterControlApplicationOptions,
    | 'create'
    | 'enabled'
    | 'profile'
    | 'apiCredentialPepper'
    | 'openDatabase'
    | 'availability'
    | 'http'
    | 'workerRuntime'
  > {
  readonly config: EnabledClusterControlConfig;
  readonly createEventId?: ClusterRunCancellationEventIdFactory;
  readonly promptCatalog?: Readonly<{
    readonly capability: ClusterPluginPackagePromptCatalogCapability;
  }>;
  readonly promptExecution?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionCapability;
  }>;
  readonly promptExecutionInspection?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionInspectionCapability;
  }>;
  readonly promptOutputRead?: Readonly<{
    readonly capability: ClusterPluginPackagePromptOutputReadCapability;
  }>;
  readonly promptExecutionOutputRead?: Readonly<{
    readonly capability: ClusterPluginPackagePromptExecutionOutputReadCapability;
  }>;
  readonly workerIngress?: ProductionClusterWorkerIngressOptions;
}

const SAFE_RECOVERY: Readonly<ClusterControlStartupRecoverySummary> =
  Object.freeze({ safe: true, remaining: 0, failed: 0 });

function eventIdFactory(
  candidate: ClusterRunCancellationEventIdFactory | undefined,
): ClusterRunCancellationEventIdFactory {
  if (candidate !== undefined && typeof candidate !== 'function') {
    throw new TypeError(
      'Production cluster-control event ID factory is invalid',
    );
  }
  return candidate ?? randomUUID;
}

/**
 * The reviewed production business surface. Bootstrap still owns PostgreSQL,
 * startup recovery, the scheduler and cancellation convergence; this stack
 * owns only the exact route allowlist and its admission pipeline.
 */
export function createProductionClusterControlApplicationStack(
  input: ClusterControlAssemblyInput,
  options: ProductionClusterControlAssemblyOptions = {},
): ClusterControlApplicationStack {
  const createEventId = eventIdFactory(options.createEventId);
  const workerIngressStarter =
    options.startWorkerIngress ?? startProductionClusterWorkerIngress;
  if (typeof workerIngressStarter !== 'function') {
    throw new TypeError('Production Worker ingress starter is invalid');
  }
  const routeDefinitions = [
    createClusterControlTaskReadRoute(input.taskDefinitions),
    createClusterControlTaskListRoute(input.taskDefinitions),
    createClusterControlTaskStartRoute(input.taskStart, createEventId),
    createClusterControlRunReadRoute(input.runs),
    createClusterControlRunListRoute(input.runs),
    createClusterControlRunEventListRoute(input.runs),
    createClusterControlRunStepListRoute(
      input.runs,
      input.trustedToolStorage.stepRuns,
    ),
    createClusterControlRunAttemptLogReadRoute(
      input.runs,
      input.workerRuntime?.runAttemptLogRead,
    ),
    createClusterControlRunCancellationRoute(
      input.runCancellation,
      createEventId,
    ),
    ...createClusterControlPluginPackageWorkflowRoutes(
      input.workflowAdministration,
      Date.now,
      createEventId,
    ),
    ...(options.promptCatalog === undefined
      ? []
      : [
          createClusterControlPluginPackagePromptCatalogRoute(
            options.promptCatalog.capability,
          ),
        ]),
    ...(options.promptExecution === undefined
      ? []
      : [
          createClusterControlPluginPackagePromptExecutionRoute(
            options.promptExecution.capability,
            {
              ...(options.promptExecution.maxExecutionMs === undefined
                ? {}
                : { maxExecutionMs: options.promptExecution.maxExecutionMs }),
              ...(options.promptExecution.now === undefined
                ? {}
                : { now: options.promptExecution.now }),
              createEventId,
            },
          ),
        ]),
    ...(options.promptExecutionInspection === undefined
      ? []
      : [
          createClusterControlPluginPackagePromptExecutionInspectionRoute(
            options.promptExecutionInspection.capability,
            {
              ...(options.promptExecutionInspection.now === undefined
                ? {}
                : { now: options.promptExecutionInspection.now }),
              createEventId,
            },
          ),
        ]),
    ...(options.promptOutputRead === undefined
      ? []
      : [
          createClusterControlPluginPackagePromptOutputReadRoute(
            options.promptOutputRead.capability,
          ),
        ]),
    ...(options.promptExecutionOutputRead === undefined
      ? []
      : [
          createClusterControlPluginPackagePromptExecutionOutputReadRoute(
            options.promptExecutionOutputRead.capability,
          ),
        ]),
  ];
  const routes = createClusterControlRouteRegistry(routeDefinitions);
  const expectedRouteCount =
    PRODUCTION_CLUSTER_CONTROL_ROUTE_OPERATIONS.length +
    (options.promptCatalog === undefined ? 0 : 1) +
    (options.promptExecution === undefined ? 0 : 1) +
    (options.promptExecutionInspection === undefined ? 0 : 1) +
    (options.promptOutputRead === undefined ? 0 : 1) +
    (options.promptExecutionOutputRead === undefined ? 0 : 1);
  if (routes.size !== expectedRouteCount) {
    throw new Error('Production cluster-control route allowlist is incomplete');
  }
  const admission = createClusterControlAdmissionPipeline({
    routes,
    authenticator: input.authenticator,
    policy: createClusterControlProjectPolicyAuthorizer(input.policies),
    audit: input.securityAudit,
  });
  let workerIngress:
    | Extract<ClusterWorkerIngressApplicationResult, { status: 'active' }>
    | undefined;
  let workerIngressStart:
    | Promise<
        Extract<ClusterWorkerIngressApplicationResult, { status: 'active' }>
      >
    | undefined;
  let workerIngressUnavailable: unknown;
  let workerIngressStop: Promise<'stopped'> | undefined;
  const stopWorkerIngress = (): Promise<'stopped'> => {
    if (!workerIngress) return Promise.resolve('stopped' as const);
    workerIngressStop ??= workerIngress.stop();
    return workerIngressStop;
  };
  const startWorkerIngress = async (): Promise<void> => {
    const ingress = options.workerIngress;
    if (!ingress) return;
    if (!input.workerRuntime) {
      throw new Error(
        'Production Worker ingress requires an injected runtime service port',
      );
    }
    workerIngressStart ??= (async () => {
      const result = await workerIngressStarter({
        config: ingress.config,
        runtime: input.workerRuntime!,
        onPoolError(error) {
          workerIngressUnavailable ??= error;
          void Promise.resolve(ingress.onDiagnostic?.(error)).catch(
            () => undefined,
          );
          void stopWorkerIngress().catch(() => undefined);
        },
      });
      if (result.status !== 'active') {
        throw new Error('Production Worker ingress did not activate');
      }
      workerIngress = result;
      if (workerIngressUnavailable !== undefined) {
        await stopWorkerIngress();
        throw new Error(
          'Production Worker ingress database became unavailable during activation',
        );
      }
      return result;
    })();
    await workerIngressStart;
  };

  return Object.freeze({
    async reconcile(): Promise<ClusterControlStartupRecoverySummary> {
      return SAFE_RECOVERY;
    },
    async startLifecycles(): Promise<boolean> {
      await startWorkerIngress();
      return true;
    },
    admission,
    async stop(): Promise<ClusterControlStopResult> {
      await stopWorkerIngress();
      return 'stopped';
    },
  });
}

/** Starts cluster-control with the reviewed production route allowlist. */
export function startProductionClusterControlApplication(
  options: ProductionClusterControlApplicationOptions,
): Promise<ClusterControlApplicationResult> {
  const createEventId = eventIdFactory(options.createEventId);
  const {
    createEventId: _ignoredCreateEventId,
    config,
    workerIngress,
    promptCatalog,
    promptExecution,
    promptExecutionInspection,
    promptOutputRead,
    promptExecutionOutputRead,
    ...applicationOptions
  } = options;
  const database = createClusterControlDatabaseBinding(config);
  return startClusterControlApplication({
    ...applicationOptions,
    enabled: true,
    profile: 'cluster-control',
    apiCredentialPepper: config.security.apiCredentialPepper,
    http: config.http,
    ...(workerIngress === undefined
      ? {}
      : {
          workerRuntime: {
            artifactStore: workerIngress.artifactStore,
            ...(workerIngress.secretProvider === undefined
              ? {}
              : { secretProvider: workerIngress.secretProvider }),
          },
        }),
    ...database,
    create: (input) =>
      createProductionClusterControlApplicationStack(input, {
        createEventId,
        ...(promptCatalog === undefined ? {} : { promptCatalog }),
        ...(promptExecution === undefined
          ? {}
          : {
              promptExecution: {
                capability: promptExecution.capability,
                maxExecutionMs: Math.max(
                  1,
                  (config.http.requestTimeoutMs ??
                    CLUSTER_CONTROL_HTTP_DEFAULTS.requestTimeoutMs) - 100,
                ),
              },
            }),
        ...(promptExecutionInspection === undefined
          ? {}
          : { promptExecutionInspection }),
        ...(promptOutputRead === undefined ? {} : { promptOutputRead }),
        ...(promptExecutionOutputRead === undefined
          ? {}
          : { promptExecutionOutputRead }),
        ...(workerIngress === undefined
          ? {}
          : {
              workerIngress: {
                config: workerIngress.config,
                ...(workerIngress.onDiagnostic === undefined
                  ? {}
                  : { onDiagnostic: workerIngress.onDiagnostic }),
              },
            }),
      }),
  });
}
