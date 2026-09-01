import { randomUUID } from 'node:crypto';

import type {
  LocalApplicationProductSurface,
  LocalApplicationProductSurfaceAuthority,
} from '@qinglong/local-application';
import { LocalOwnerPepperKeyringFileProvider } from '@qinglong/local-owner-console/pepper-custody';
import { ProjectPolicyEngine } from '@qinglong/runtime-core/project-policy';

import { createLocalApiAdmission } from '../admission/localApiAdmission';
import { createLocalApiCredentialAuthenticator } from '../authentication/credentialAuthenticator';
import { createLocalPresenceProofManager } from '../authentication/localPresenceProof';
import type { LocalApiProcessConfig } from '../production-process/config';
import { createLocalApiRunListRoute } from '../run/runListRoute';
import { createLocalApiRunReadRoute } from '../run/runReadRoute';
import { createLocalApiRunEventListRoute } from '../run/runEventListRoute';
import { createLocalApiRunStepListRoute } from '../run/runStepListRoute';
import { createLocalApiRunCancellationRoute } from '../run/runCancellationRoute';
import { createLocalApiRunAttemptLogReadRoute } from '../run/runAttemptLogReadRoute';
import { createLocalApiTaskListRoute } from '../task/taskListRoute';
import { createLocalApiTaskReadRoute } from '../task/taskReadRoute';
import { createLocalApiTaskStartRoute } from '../task/taskStartRoute';
import { createLocalApiTaskPutRoute } from '../task/taskPutRoute';
import { createLocalApiTaskAuthoringRoute } from '../task/taskAuthoringRoute';
import {
  createLocalApiTriggerListRoute,
  createLocalApiTriggerReadRoute,
} from '../trigger/triggerReadRoutes';
import { createLocalApiTriggerPutRoute } from '../trigger/triggerPutRoute';
import {
  createLocalApiSecretListRoute,
  createLocalApiSecretPutRoute,
} from '../secret/secretRoutes';
import { createPanelCronListRoute } from '../panel-compatibility/panelCronListRoute';
import { startLocalApiHttpSurface } from '../transport/httpSurface';

export interface LocalApiProductSurfaceEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-local-api';
  readonly level: 'info' | 'error';
  readonly event: 'listening' | 'draining' | 'stopped';
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly stopResult?: 'stopped' | 'timed_out';
}

export interface LocalApiProductSurfaceOptions {
  readonly emit?: (
    event: Readonly<LocalApiProductSurfaceEvent>,
  ) => void | Promise<void>;
  readonly now?: () => number;
  readonly randomUuid?: () => string;
}

async function bestEffortEmit(
  emit: LocalApiProductSurfaceOptions['emit'],
  event: Readonly<LocalApiProductSurfaceEvent>,
): Promise<void> {
  if (!emit) return;
  try {
    await emit(event);
  } catch {
    // Diagnostics cannot replace listener or drain outcomes.
  }
}

function surfaceEvent(
  config: Readonly<LocalApiProcessConfig>,
  event: LocalApiProductSurfaceEvent['event'],
  values: Readonly<
    Pick<LocalApiProductSurfaceEvent, 'level'> &
      Partial<Pick<LocalApiProductSurfaceEvent, 'stopResult'>>
  >,
): Readonly<LocalApiProductSurfaceEvent> {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-api',
    event,
    host: config.listener.host,
    port: config.listener.port,
    ...values,
  });
}

export function createLocalApiProductSurface(
  config: Readonly<LocalApiProcessConfig>,
  options: LocalApiProductSurfaceOptions = {},
): Readonly<LocalApplicationProductSurface> {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.emit !== undefined && typeof options.emit !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.randomUuid !== undefined &&
      typeof options.randomUuid !== 'function')
  ) {
    throw new TypeError('Local API product surface options are invalid');
  }

  return Object.freeze({
    async start(authority: Readonly<LocalApplicationProductSurfaceAuthority>) {
      const provider = new LocalOwnerPepperKeyringFileProvider(
        config.ownerPepperKeyringDirectory,
      );
      const authenticator = createLocalApiCredentialAuthenticator(
        authority,
        provider,
        options.now === undefined ? {} : { now: options.now },
      );
      const presenceProof = createLocalPresenceProofManager({
        deploymentRoot: config.deploymentRoot,
        profile: authority.profile,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      const policy = new ProjectPolicyEngine(authority.projectPolicy);
      const runReadRoute = createLocalApiRunReadRoute(authority.runs);
      const runListRoute = createLocalApiRunListRoute(authority.runs);
      const runEventListRoute = createLocalApiRunEventListRoute(authority.runs);
      const runStepListRoute = createLocalApiRunStepListRoute(
        authority.runs,
        authority.stepRuns,
      );
      const runCancellationRoute = createLocalApiRunCancellationRoute(
        authority.runCancellation,
        options.randomUuid ?? randomUUID,
      );
      const runAttemptLogReadRoute = createLocalApiRunAttemptLogReadRoute(
        authority.runAttemptLogRead,
      );
      const taskListRoute = createLocalApiTaskListRoute(
        authority.taskDefinitions,
      );
      const taskReadRoute = createLocalApiTaskReadRoute(
        authority.taskDefinitions,
      );
      const taskStartRoute = createLocalApiTaskStartRoute(
        authority.taskStart,
        options.randomUuid ?? randomUUID,
      );
      const taskAuthoringRoute = createLocalApiTaskAuthoringRoute({
        profile: authority.profile,
        projectPolicy: authority.projectPolicy,
        taskDefinitions: authority.taskDefinitions,
        securityAudit: authority.securityAudit,
        presenceProof,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      const taskPutRoute = createLocalApiTaskPutRoute({
        projectPolicy: authority.projectPolicy,
        taskDefinitions: authority.taskDefinitions,
        taskDefinitionAdministrationForCredential: (fence) => {
          if (fence.subjectType !== 'user') {
            throw new TypeError('Task mutation requires a User credential');
          }
          return authority.taskDefinitionAdministrationForCredential({
            ...fence,
            subjectType: 'user',
          });
        },
        securityAudit: authority.securityAudit,
        presenceProof,
        taskAuthoringLeases: taskAuthoringRoute.leases,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      const triggerListRoute = createLocalApiTriggerListRoute(
        authority.triggers,
      );
      const triggerReadRoute = createLocalApiTriggerReadRoute(
        authority.triggers,
      );
      const triggerPutRoute = createLocalApiTriggerPutRoute({
        projectPolicy: authority.projectPolicy,
        triggers: authority.triggers,
        triggerAdministrationForCredential: (fence) => {
          if (fence.subjectType !== 'user') {
            throw new TypeError('Trigger mutation requires a User credential');
          }
          return authority.triggerAdministrationForCredential({
            ...fence,
            subjectType: 'user',
          });
        },
        securityAudit: authority.securityAudit,
        presenceProof,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      const secretListRoute = createLocalApiSecretListRoute(
        authority.localSecretMetadata,
      );
      const secretPutRoute = createLocalApiSecretPutRoute({
        projectPolicy: authority.projectPolicy,
        secretAdministrationForCredential: (fence) => {
          if (fence.subjectType !== 'user') {
            throw new TypeError('Secret mutation requires a User credential');
          }
          return authority.localSecretAdministrationForCredential({
            ...fence,
            subjectType: 'user',
          });
        },
        securityAudit: authority.securityAudit,
        secretKeys: authority.localSecretKeys,
        presenceProof,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      const panelCronListRoute = createPanelCronListRoute({
        tasks: authority.taskDefinitions,
        triggers: authority.triggers,
      });
      const admission = createLocalApiAdmission({
        authenticator,
        policy,
        audit: authority.securityAudit,
        runReadRoute,
        runListRoute,
        runEventListRoute,
        runStepListRoute,
        runCancellationRoute,
        runAttemptLogReadRoute,
        taskListRoute,
        taskReadRoute,
        taskStartRoute,
        taskPutRoute,
        taskAuthoringRoute,
        triggerListRoute,
        triggerReadRoute,
        triggerPutRoute,
        secretListRoute,
        secretPutRoute,
        panelCronListRoute,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.randomUuid === undefined
          ? {}
          : { randomUuid: options.randomUuid }),
      });
      let active;
      try {
        active = await startLocalApiHttpSurface({
          profile: authority.profile,
          host: config.listener.host,
          port: config.listener.port,
          admission,
          ...(options.randomUuid === undefined
            ? {}
            : { randomUuid: options.randomUuid }),
        });
      } catch (error) {
        taskAuthoringRoute.close();
        presenceProof.close();
        throw error;
      }
      await bestEffortEmit(
        options.emit,
        surfaceEvent(config, 'listening', { level: 'info' }),
      );
      let stopPromise: Promise<'stopped' | 'timed_out'> | undefined;
      return Object.freeze({
        stopAndDrain() {
          if (stopPromise) return stopPromise;
          stopPromise = (async () => {
            await bestEffortEmit(
              options.emit,
              surfaceEvent(config, 'draining', { level: 'info' }),
            );
            let stopResult = await active.stopAndDrain();
            try {
              taskAuthoringRoute.close();
              presenceProof.close();
            } catch {
              stopResult = 'timed_out';
            }
            await bestEffortEmit(
              options.emit,
              surfaceEvent(config, 'stopped', {
                level: stopResult === 'stopped' ? 'info' : 'error',
                stopResult,
              }),
            );
            return stopResult;
          })();
          return stopPromise;
        },
      });
    },
  });
}
