import type { LocalApplicationProfile } from '@qinglong/local-application';
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import type { LocalApiResponse } from '../transport/contract';

const PRODUCT_VERSION = '3.0.0-alpha.2';

export type PanelBootstrapOperation =
  | 'panel.user.get'
  | 'panel.system.config.get';

export interface PanelBootstrapRequest {
  readonly operationId: PanelBootstrapOperation;
  readonly principal: Readonly<SecurityPrincipal>;
}

export interface PanelBootstrapRoute {
  handle(request: Readonly<PanelBootstrapRequest>): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): Readonly<LocalApiResponse> {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function maximumRows(profile: LocalApplicationProfile): number {
  return profile === 'edge' ? 64 : 256;
}

export function panelCapabilities(
  profile: LocalApplicationProfile,
): Readonly<Record<string, unknown>> {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new TypeError('Panel capability profile is invalid');
  }
  const logChunkBytes = profile === 'edge' ? 16 * 1_024 : 32 * 1_024;
  return Object.freeze({
    schemaVersion: 1,
    product: 'qinglong3',
    version: PRODUCT_VERSION,
    deployment: Object.freeze({ mode: 'local', profile }),
    authentication: Object.freeze({
      kind: 'api_credential',
      transport: 'bearer',
      persistence: 'memory_only',
      loginEndpoint: null,
    }),
    project: Object.freeze({ selection: 'explicit', defaultId: 'default' }),
    panel: Object.freeze({
      bootstrap: true,
      cronList: 'bounded_read_only',
      taskRead: true,
      triggerRead: true,
      runRead: true,
      runLogRead: true,
      legacyMutations: false,
      legacyLogin: false,
      subscriptions: false,
      scripts: false,
      environmentVariables: false,
      webSocket: false,
    }),
    limits: Object.freeze({
      cronRows: maximumRows(profile),
      cronPageSize: 64,
      logChunkBytes,
    }),
  });
}

export function panelPublicResponse(
  operation: 'capabilities' | 'health' | 'system',
  profile: LocalApplicationProfile,
): Readonly<LocalApiResponse> {
  const capabilities = panelCapabilities(profile);
  if (operation === 'capabilities') {
    return response(200, { capabilities });
  }
  if (operation === 'health') {
    return response(200, {
      code: 200,
      data: Object.freeze({
        status: 'ok',
        ql3: Object.freeze({
          schemaVersion: 1,
          apiVersion: 'v3',
          capabilitiesPath: '/api/v3/capabilities',
        }),
      }),
    });
  }
  return response(200, {
    code: 200,
    data: Object.freeze({
      branch: 'develop',
      isInitialized: true,
      publishTime: 0,
      version: PRODUCT_VERSION,
      changeLog: '',
      changeLogLink: '',
      ql3: Object.freeze({
        schemaVersion: 1,
        mode: 'local',
        profile,
        capabilitiesPath: '/api/v3/capabilities',
      }),
    }),
  });
}

export function createPanelBootstrapRoute(
  profile: LocalApplicationProfile,
): Readonly<PanelBootstrapRoute> {
  if (profile !== 'edge' && profile !== 'standalone') {
    throw new TypeError('Panel bootstrap profile is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<PanelBootstrapRequest>) {
      const principal = request?.principal;
      if (
        !principal ||
        typeof principal !== 'object' ||
        Array.isArray(principal) ||
        principal.subject?.type !== 'user' ||
        typeof principal.subject?.id !== 'string' ||
        principal.subject.id.length < 1
      ) {
        return response(503, {
          code: 503,
          message: 'QL3 面板身份暂不可用',
        });
      }
      if (request.operationId === 'panel.user.get') {
        return response(200, {
          code: 200,
          data: Object.freeze({
            username: principal.subject.id,
            ql3: Object.freeze({
              schemaVersion: 1,
              subjectType: principal.subject.type,
              assurance: principal.assurance,
              expiresAtMs: principal.expiresAtMs,
              credentialPersistence: 'memory_only',
              panelHome: '/crontab',
            }),
          }),
        });
      }
      if (request.operationId !== 'panel.system.config.get') {
        return response(503, {
          code: 503,
          message: 'QL3 面板启动入口暂不可用',
        });
      }
      return response(200, {
        code: 200,
        data: Object.freeze({
          info: Object.freeze({
            panelTitle: 'QingLong 3.0',
            lang: 'zh-cn',
          }),
          ql3: panelCapabilities(profile),
        }),
      });
    },
  });
}
