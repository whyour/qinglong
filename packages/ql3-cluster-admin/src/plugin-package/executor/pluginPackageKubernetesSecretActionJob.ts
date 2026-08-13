import { createHash } from 'node:crypto';

import {
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA,
  normalizePluginPackageSecretBindingApprovalPlan,
  pluginPackageSecretBindingApprovedAction,
  type PluginPackageSecretBindingApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-approval-plan';
import {
  normalizePluginPackageSecretBindingTransitionApprovalPlan,
  pluginPackageSecretBindingTransitionApprovedAction,
  type PluginPackageSecretBindingTransitionApprovalPlan,
} from '@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan';
import { secretProjectionFileName } from '@qinglong/runtime-core/secret-projection';

import {
  isPluginPackageKubernetesSecretName,
  PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE,
} from '../secret-binding/pluginPackageKubernetesSecretProjection';

export const PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_JOB_SCHEMA =
  'qinglong/plugin-package-kubernetes-secret-action-job@v1' as const;
export const PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_ROOT =
  '/var/run/secrets/qinglong3/plugin-package-values' as const;

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const SECRET_KEY = /^[A-Za-z0-9._-]{1,253}$/;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;
const IMAGE_DIGEST =
  /^[a-z0-9](?:[a-z0-9._:/-]{0,510}[a-z0-9])?@sha256:[0-9a-f]{64}$/;
const JOB_DIGEST_DOMAIN = Buffer.from(
  'qinglong/plugin-package-kubernetes-secret-action-job-digest@v1\0',
  'utf8',
);

type SecretActionApprovalPlan =
  | PluginPackageSecretBindingApprovalPlan
  | PluginPackageSecretBindingTransitionApprovalPlan;

export type PluginPackageKubernetesPostgresConnection =
  | Readonly<{
      mode: 'url';
      secretName: string;
      urlKey: string;
    }>
  | Readonly<{
      mode: 'fields';
      authSecretName: string;
      host: string;
      port: number;
      database: string;
      usernameKey: string;
      passwordKey: string;
    }>;

export interface PluginPackageKubernetesSecretActionJobOptions {
  readonly namespace: string;
  readonly serviceAccountName: string;
  readonly sourceSecretName: string;
  readonly image: string;
  readonly postgres: Readonly<{
    connection: PluginPackageKubernetesPostgresConnection;
    caSecretName: string;
    caKey: string;
    servername: string;
  }>;
}

export interface PluginPackageKubernetesSecretActionJobInput {
  readonly dispatch: Readonly<ApprovedActionDispatchRecord>;
  readonly approvalPlan: Readonly<SecretActionApprovalPlan>;
  readonly options: Readonly<PluginPackageKubernetesSecretActionJobOptions>;
}

export class InvalidPluginPackageKubernetesSecretActionJobError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_JOB_INVALID';

  constructor(message: string) {
    super(`Plugin Package Kubernetes Secret action Job is invalid: ${message}`);
    this.name = 'InvalidPluginPackageKubernetesSecretActionJobError';
  }
}

function invalid(message: string): never {
  throw new InvalidPluginPackageKubernetesSecretActionJobError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} shape is invalid`);
  }
}

function dnsLabel(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DNS_LABEL.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function secretKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SECRET_KEY.test(value)) {
    return invalid(`${label} is invalid`);
  }
  return value;
}

function normalizeOptions(
  value: PluginPackageKubernetesSecretActionJobOptions,
): PluginPackageKubernetesSecretActionJobOptions {
  const options = record(value, 'options');
  exactKeys(
    options,
    [
      'image',
      'namespace',
      'postgres',
      'serviceAccountName',
      'sourceSecretName',
    ],
    'options',
  );
  const postgres = record(value.postgres, 'postgres');
  exactKeys(
    postgres,
    ['caKey', 'caSecretName', 'connection', 'servername'],
    'postgres',
  );
  const connection = record(value.postgres.connection, 'connection');
  if (connection.mode === 'url') {
    exactKeys(connection, ['mode', 'secretName', 'urlKey'], 'connection');
  } else if (connection.mode === 'fields') {
    exactKeys(
      connection,
      [
        'authSecretName',
        'database',
        'host',
        'mode',
        'passwordKey',
        'port',
        'usernameKey',
      ],
      'connection',
    );
  } else {
    return invalid('connection mode is invalid');
  }
  if (
    !isPluginPackageKubernetesSecretName(value.sourceSecretName) ||
    typeof value.image !== 'string' ||
    !IMAGE_DIGEST.test(value.image) ||
    !isPluginPackageKubernetesSecretName(value.postgres.caSecretName) ||
    !DNS_NAME.test(value.postgres.servername)
  ) {
    return invalid('options contain an invalid Kubernetes identity');
  }
  const normalizedConnection =
    value.postgres.connection.mode === 'url'
      ? Object.freeze({
          mode: 'url' as const,
          secretName: dnsLabel(
            value.postgres.connection.secretName,
            'connection Secret name',
          ),
          urlKey: secretKey(value.postgres.connection.urlKey, 'URL key'),
        })
      : Object.freeze({
          mode: 'fields' as const,
          authSecretName: dnsLabel(
            value.postgres.connection.authSecretName,
            'authentication Secret name',
          ),
          host: DNS_NAME.test(value.postgres.connection.host)
            ? value.postgres.connection.host
            : invalid('PostgreSQL host is invalid'),
          port:
            Number.isSafeInteger(value.postgres.connection.port) &&
            value.postgres.connection.port >= 1 &&
            value.postgres.connection.port <= 65_535
              ? value.postgres.connection.port
              : invalid('PostgreSQL port is invalid'),
          database: DATABASE_NAME.test(value.postgres.connection.database)
            ? value.postgres.connection.database
            : invalid('PostgreSQL database is invalid'),
          usernameKey: secretKey(
            value.postgres.connection.usernameKey,
            'username key',
          ),
          passwordKey: secretKey(
            value.postgres.connection.passwordKey,
            'password key',
          ),
        });
  return Object.freeze({
    namespace: dnsLabel(value.namespace, 'namespace'),
    serviceAccountName: dnsLabel(
      value.serviceAccountName,
      'ServiceAccount name',
    ),
    sourceSecretName: value.sourceSecretName,
    image: value.image,
    postgres: Object.freeze({
      connection: normalizedConnection,
      caSecretName: value.postgres.caSecretName,
      caKey: secretKey(value.postgres.caKey, 'CA key'),
      servername: value.postgres.servername,
    }),
  });
}

function normalizePlan(value: SecretActionApprovalPlan): Readonly<{
  plan: Readonly<SecretActionApprovalPlan>;
  action: ReturnType<typeof pluginPackageSecretBindingApprovedAction>;
  secretRefs: readonly string[];
}> {
  if (
    record(value, 'approval plan').schema ===
    PLUGIN_PACKAGE_SECRET_BINDING_APPROVAL_PLAN_SCHEMA
  ) {
    const plan = normalizePluginPackageSecretBindingApprovalPlan(
      value as PluginPackageSecretBindingApprovalPlan,
    );
    return Object.freeze({
      plan,
      action: pluginPackageSecretBindingApprovedAction(plan),
      secretRefs: Object.freeze(
        plan.bindingPlan.entries.flatMap((entry) =>
          entry.secretRef === null ? [] : [entry.secretRef],
        ),
      ),
    });
  }
  const plan = normalizePluginPackageSecretBindingTransitionApprovalPlan(
    value as PluginPackageSecretBindingTransitionApprovalPlan,
  );
  return Object.freeze({
    plan,
    action: pluginPackageSecretBindingTransitionApprovedAction(plan),
    secretRefs: Object.freeze(
      plan.transitionPlan.nextBindingPlan?.entries.flatMap((entry) =>
        entry.secretRef === null ? [] : [entry.secretRef],
      ) ?? [],
    ),
  });
}

function uniqueItems(secretRefs: readonly string[]): readonly Readonly<{
  key: string;
  path: string;
}>[] {
  const keys = [...new Set(secretRefs.map(secretProjectionFileName))].sort();
  return Object.freeze(
    keys.map((key) => Object.freeze({ key, path: key })),
  );
}

function valueFromSecret(name: string, key: string): object {
  return {
    valueFrom: { secretKeyRef: { name, key, optional: false } },
  };
}

function connectionEnvironment(
  connection: PluginPackageKubernetesPostgresConnection,
): readonly object[] {
  if (connection.mode === 'url') {
    return [
      {
        name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
        ...valueFromSecret(connection.secretName, connection.urlKey),
      },
    ];
  }
  return [
    { name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_HOST', value: connection.host },
    {
      name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PORT',
      value: String(connection.port),
    },
    {
      name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_DATABASE',
      value: connection.database,
    },
    {
      name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_USER',
      ...valueFromSecret(connection.authSecretName, connection.usernameKey),
    },
    {
      name: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PASSWORD',
      ...valueFromSecret(connection.authSecretName, connection.passwordKey),
    },
  ];
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value as Readonly<T>;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function createPluginPackageKubernetesSecretActionJob(
  input: PluginPackageKubernetesSecretActionJobInput,
): Readonly<Record<string, unknown>> {
  const candidate = record(input, 'input');
  exactKeys(candidate, ['approvalPlan', 'dispatch', 'options'], 'input');
  const dispatch = normalizeApprovedActionDispatchRecord(input.dispatch);
  const approved = normalizePlan(input.approvalPlan);
  if (
    JSON.stringify(dispatch.action) !== JSON.stringify(approved.action) ||
    dispatch.projectId !==
      ('bindingPlan' in approved.plan
        ? approved.plan.bindingPlan.target.projectId
        : approved.plan.transitionPlan.nextTarget.projectId) ||
    dispatch.requestedBy.type !== approved.plan.requestedBy.type ||
    dispatch.requestedBy.id !== approved.plan.requestedBy.id ||
    dispatch.createdAtMs > approved.plan.expiresAtMs
  ) {
    return invalid('dispatch does not match the approved plan');
  }
  const options = normalizeOptions(input.options);
  const items = uniqueItems(approved.secretRefs);
  const unsigned = {
    schema: PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_JOB_SCHEMA,
    dispatch,
    approvalPlanDigest: approved.plan.approvalPlanDigest,
    namespace: options.namespace,
    serviceAccountName: options.serviceAccountName,
    sourceSecretName: options.sourceSecretName,
    image: options.image,
    postgres: options.postgres,
    items,
  };
  const jobDigest = createHash('sha256')
    .update(JOB_DIGEST_DOMAIN)
    .update(JSON.stringify(unsigned), 'utf8')
    .digest('hex');
  const name = `ql3-package-secret-${jobDigest.slice(0, 32)}`;
  const valueVolume =
    items.length === 0
      ? { name: 'plugin-package-values', emptyDir: { sizeLimit: '1Ki' } }
      : {
          name: 'plugin-package-values',
          secret: {
            secretName: options.sourceSecretName,
            optional: false,
            defaultMode: PLUGIN_PACKAGE_KUBERNETES_SECRET_FILE_MODE,
            items,
          },
        };
  return deepFreeze({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/name': 'ql3-plugin-package-secret-action',
        'app.kubernetes.io/component': 'plugin-package-executor',
        'app.kubernetes.io/part-of': 'qinglong3',
      },
      annotations: {
        'qinglong.io/secret-action-job-schema':
          PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_JOB_SCHEMA,
        'qinglong.io/secret-action-job-digest': jobDigest,
        'qinglong.io/approved-action-type': dispatch.action.actionType,
        'qinglong.io/approved-action-digest': dispatch.action.actionDigest,
      },
    },
    spec: {
      backoffLimit: 2,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'ql3-plugin-package-secret-action',
            'app.kubernetes.io/component': 'plugin-package-executor',
            'app.kubernetes.io/part-of': 'qinglong3',
            'qinglong.io/secret-action-job': name,
          },
        },
        spec: {
          serviceAccountName: options.serviceAccountName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'executor',
              image: options.image,
              imagePullPolicy: 'IfNotPresent',
              command: [
                'node',
                '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/plugin-package/executor/pluginPackageExecutorCli.js',
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              env: [
                { name: 'QL3_PLUGIN_PACKAGE_EXECUTOR_ENABLED', value: 'true' },
                {
                  name: 'QL3_PLUGIN_PACKAGE_EXECUTOR_OWNER',
                  value: `package_secret_${jobDigest.slice(0, 24)}`,
                },
                {
                  name: 'QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_ID',
                  value: dispatch.id,
                },
                {
                  name: 'QL3_PLUGIN_PACKAGE_EXECUTOR_SECRET_ROOT',
                  value: PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_ROOT,
                },
                {
                  name: 'QL3_PLUGIN_PACKAGE_EXECUTOR_LEASE_DURATION_MS',
                  value: '600000',
                },
                { name: 'QL3_POSTGRES_TLS_MODE', value: 'verify-full' },
                {
                  name: 'QL3_POSTGRES_TLS_CA_FILE',
                  value: '/var/run/secrets/qinglong3/postgres/ca.crt',
                },
                {
                  name: 'QL3_POSTGRES_TLS_SERVERNAME',
                  value: options.postgres.servername,
                },
                {
                  name: 'QL3_POSTGRES_APPLICATION_NAME',
                  value: 'qinglong3-package-secret-action',
                },
                { name: 'QL3_POSTGRES_MAX_CONNECTIONS', value: '1' },
                ...connectionEnvironment(options.postgres.connection),
              ],
              resources: {
                requests: { cpu: '25m', memory: '48Mi' },
                limits: { cpu: '250m', memory: '192Mi' },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                {
                  name: 'postgres-ca',
                  mountPath: '/var/run/secrets/qinglong3/postgres',
                  readOnly: true,
                },
                {
                  name: 'plugin-package-values',
                  mountPath: PLUGIN_PACKAGE_KUBERNETES_SECRET_ACTION_ROOT,
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '8Mi' } },
            {
              name: 'postgres-ca',
              secret: {
                secretName: options.postgres.caSecretName,
                optional: false,
                defaultMode: 0o444,
                items: [{ key: options.postgres.caKey, path: 'ca.crt' }],
              },
            },
            valueVolume,
          ],
        },
      },
    },
  });
}
