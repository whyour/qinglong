#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  validatePluginPackageManagementLiveEvidence,
} = require('./ql3-plugin-package-management-live-evidence-audit.cjs');

const EXERCISE_FIXTURE = 'qinglong/plugin-package-management-live-exercise@v1';
const REPORT_FIXTURE = 'qinglong/plugin-package-management-live-evidence@v1';
const NAMESPACE = 'qinglong3-system';
const MANAGEMENT_NAME = 'ql3-plugin-package-management';
const MANAGEMENT_CONTAINER = 'management';
const POSTGRES_SELECTOR = 'cnpg.io/cluster=ql3-postgres';
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
const MAX_OIDC_DOCUMENT_BYTES = 1024 * 1024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class PluginPackageManagementLiveEvidenceCollectionError extends Error {
  constructor(message) {
    super(
      `Plugin Package management live evidence collection failed: ${message}`,
    );
    this.name = 'PluginPackageManagementLiveEvidenceCollectionError';
  }
}

function fail(message) {
  throw new PluginPackageManagementLiveEvidenceCollectionError(message);
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(`${label} shape is invalid`);
  }
}

function token(value, label, maximum = 256) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function canonicalPrivatePath(filePath, label) {
  if (!path.isAbsolute(filePath)) fail(`${label} path must be absolute`);
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_PRIVATE_FILE_BYTES ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail(
      `${label} must be a canonical private regular file no larger than 1 MiB`,
    );
  }
  return filePath;
}

function readPrivateJson(filePath, label) {
  canonicalPrivatePath(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function digest(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex')}`;
}

function rawDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function imageDigest(value, label) {
  const matches =
    typeof value === 'string' ? value.match(/sha256:[a-f0-9]{64}/g) : null;
  if (!matches || matches.length !== 1) fail(`${label} image ID is not exact`);
  return matches[0];
}

function ready(object) {
  return object?.status?.conditions?.some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
}

function containerStatus(pod, name) {
  const statuses = pod?.status?.containerStatuses;
  const status = Array.isArray(statuses)
    ? statuses.find((candidate) => candidate.name === name)
    : undefined;
  if (!status || status.ready !== true) {
    fail(
      `${pod?.metadata?.name ?? 'unknown Pod'} container ${name} is not ready`,
    );
  }
  return status;
}

function parseCniReference(value) {
  const match =
    typeof value === 'string'
      ? /^([a-z0-9](?:[-a-z0-9]{0,62}[a-z0-9])?)\/([a-z0-9](?:[-a-z0-9]{0,62}[a-z0-9])?)$/.exec(
          value,
        )
      : null;
  if (!match) fail('CNI DaemonSet reference must be namespace/name');
  return Object.freeze({ namespace: match[1], name: match[2] });
}

function cniVersion(image) {
  const withoutDigest = token(image, 'CNI image', 512).split('@')[0];
  const match = /:v?([0-9]+\.[0-9]+\.[0-9]+(?:[-._][A-Za-z0-9.-]+)?)$/.exec(
    withoutDigest,
  );
  if (!match) fail('CNI image must carry an exact semantic version tag');
  return match[1];
}

function jsonOutput(result, label) {
  if (!result || result.status !== 0) {
    fail(`${label} failed with status ${String(result?.status)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${label} did not return JSON`);
  }
}

function canIOutput(result, label) {
  if (!result || result.status !== 0 || result.stdout.trim() !== 'no') {
    fail(`${label} must be denied by the Kubernetes authorizer`);
  }
  return false;
}

function policyIsBounded(policy) {
  const spec = policy?.spec;
  return (
    JSON.stringify(spec?.podSelector) ===
      JSON.stringify({
        matchLabels: {
          'app.kubernetes.io/name': MANAGEMENT_NAME,
          'app.kubernetes.io/component': 'plugin-package-management',
        },
      }) &&
    JSON.stringify([...(spec.policyTypes ?? [])].sort()) ===
      JSON.stringify(['Egress', 'Ingress']) &&
    JSON.stringify(spec.ingress) ===
      JSON.stringify([
        {
          from: [
            {
              podSelector: {
                matchLabels: {
                  'qinglong.io/plugin-package-management-client': 'true',
                },
              },
            },
          ],
          ports: [{ port: 8443, protocol: 'TCP' }],
        },
      ]) &&
    JSON.stringify(spec.egress) ===
      JSON.stringify([
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: {
                  'kubernetes.io/metadata.name': 'kube-system',
                },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
        {
          to: [
            {
              podSelector: {
                matchLabels: { 'cnpg.io/cluster': 'ql3-postgres' },
              },
            },
          ],
          ports: [{ port: 5432, protocol: 'TCP' }],
        },
      ])
  );
}

function collectKubernetesSnapshot(options, runKubectl) {
  const getJson = (args, label) =>
    jsonOutput(runKubectl([...args, '-o', 'json']), label);
  const version = getJson(['version'], 'Kubernetes version');
  const nodes = getJson(['get', 'nodes'], 'Kubernetes nodes').items ?? [];
  const activeNodes = nodes.filter(
    (node) => ready(node) && node.spec?.unschedulable !== true,
  );
  const controlPlanes = activeNodes.filter((node) => {
    const labels = node.metadata?.labels ?? {};
    return (
      Object.hasOwn(labels, 'node-role.kubernetes.io/control-plane') ||
      Object.hasOwn(labels, 'node-role.kubernetes.io/master')
    );
  });
  const workers = activeNodes.filter((node) => !controlPlanes.includes(node));

  const deployment = getJson(
    ['-n', NAMESPACE, 'get', 'deployment', MANAGEMENT_NAME],
    'management Deployment',
  );
  const service = getJson(
    ['-n', NAMESPACE, 'get', 'service', MANAGEMENT_NAME],
    'management Service',
  );
  const serviceAccount = getJson(
    ['-n', NAMESPACE, 'get', 'serviceaccount', MANAGEMENT_NAME],
    'management ServiceAccount',
  );
  const policy = getJson(
    ['-n', NAMESPACE, 'get', 'networkpolicy', MANAGEMENT_NAME],
    'management NetworkPolicy',
  );
  const pods = (
    getJson(
      [
        '-n',
        NAMESPACE,
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=ql3-plugin-package-management,app.kubernetes.io/component=plugin-package-management',
      ],
      'management Pods',
    ).items ?? []
  ).filter((pod) => !pod.metadata?.deletionTimestamp);
  if (
    deployment.spec?.replicas !== 2 ||
    deployment.status?.readyReplicas !== 2 ||
    deployment.status?.unavailableReplicas > 0 ||
    pods.length !== 2 ||
    !pods.every(ready) ||
    serviceAccount.automountServiceAccountToken !== false ||
    !pods.every(
      (pod) =>
        pod.spec?.serviceAccountName === MANAGEMENT_NAME &&
        pod.spec?.automountServiceAccountToken === false,
    ) ||
    service.spec?.ports?.length !== 1 ||
    service.spec.ports[0]?.port !== 8443 ||
    service.spec.ports[0]?.protocol !== 'TCP' ||
    !policyIsBounded(policy)
  ) {
    fail(
      'live management Deployment, ServiceAccount, Service or policy drifted',
    );
  }

  const nodeByName = new Map(nodes.map((node) => [node.metadata?.name, node]));
  const podNodes = pods.map((pod) => nodeByName.get(pod.spec?.nodeName));
  if (
    podNodes.some((node) => !node) ||
    new Set(pods.map((pod) => pod.spec.nodeName)).size !== 2
  ) {
    fail('management replicas must be ready on two distinct known nodes');
  }
  const architectures = new Set(
    podNodes.map((node) => node.metadata.labels?.['kubernetes.io/arch']),
  );
  if (
    architectures.size !== 1 ||
    !['amd64', 'arm64'].includes([...architectures][0])
  ) {
    fail('management replica architecture is unsupported or inconsistent');
  }
  const managementImageIds = new Set(
    pods.map((pod) =>
      imageDigest(
        containerStatus(pod, MANAGEMENT_CONTAINER).imageID,
        'management',
      ),
    ),
  );
  if (managementImageIds.size !== 1) {
    fail('management replicas do not use one immutable image ID');
  }

  const cni = getJson(
    [
      '-n',
      options.cniDaemonSet.namespace,
      'get',
      'daemonset',
      options.cniDaemonSet.name,
    ],
    'CNI DaemonSet',
  );
  const cniContainer = cni.spec?.template?.spec?.containers?.find(
    (container) => container.name === options.cniContainer,
  );
  if (
    !cniContainer ||
    cni.status?.desiredNumberScheduled < activeNodes.length ||
    cni.status?.numberReady !== cni.status?.desiredNumberScheduled
  ) {
    fail('CNI DaemonSet is not ready on every schedulable node');
  }

  const postgresPods = (
    getJson(
      ['-n', NAMESPACE, 'get', 'pods', '-l', POSTGRES_SELECTOR],
      'CloudNativePG Pods',
    ).items ?? []
  ).filter((pod) => !pod.metadata?.deletionTimestamp && ready(pod));
  if (postgresPods.length < 3) {
    fail('three ready CloudNativePG Pods are required');
  }
  const postgresImageIds = new Set(
    postgresPods.map((pod) => {
      const status = pod.status?.containerStatuses?.find(
        (candidate) => candidate.name === 'postgres',
      );
      if (!status) {
        fail(
          `${pod.metadata?.name ?? 'unknown Pod'} has no postgres container`,
        );
      }
      return imageDigest(status?.imageID, 'PostgreSQL');
    }),
  );
  if (postgresImageIds.size !== 1) {
    fail('CloudNativePG Pods do not use one immutable PostgreSQL image ID');
  }

  const asManager = `system:serviceaccount:${NAMESPACE}:${MANAGEMENT_NAME}`;
  const deniedSecretRead = canIOutput(
    runKubectl([
      'auth',
      'can-i',
      'get',
      'secrets',
      '-n',
      NAMESPACE,
      `--as=${asManager}`,
    ]),
    'manager Secret read',
  );
  const deniedExecutorMutations = [
    ['create', 'jobs.batch'],
    ['patch', 'deployments.apps'],
    ['update', 'configmaps'],
  ].every((args) => {
    canIOutput(
      runKubectl([
        'auth',
        'can-i',
        ...args,
        '-n',
        NAMESPACE,
        `--as=${asManager}`,
      ]),
      `manager ${args.join(' ')}`,
    );
    return true;
  });

  return Object.freeze({
    kubernetesVersion: version.serverVersion?.gitVersion,
    architecture: [...architectures][0],
    managementImageId: [...managementImageIds][0],
    postgresImageId: [...postgresImageIds][0],
    cniName: options.cniName,
    cniVersion: cniVersion(cniContainer.image),
    controlPlaneNodes: controlPlanes.length,
    workerNodes: workers.length,
    replicas: deployment.spec.replicas,
    readyReplicas: deployment.status.readyReplicas,
    podIdentitySha256: Object.freeze(
      pods
        .map((pod) => digest('qinglong3.management-pod.v1', pod.metadata.uid))
        .sort(),
    ),
    nodeIdentitySha256: Object.freeze(
      podNodes
        .map((node) =>
          digest('qinglong3.management-node.v1', node.metadata.uid),
        )
        .sort(),
    ),
    serviceAccount: serviceAccount.metadata.name,
    automountServiceAccountToken: serviceAccount.automountServiceAccountToken,
    boundedNetworkPolicy: true,
    managerSecretReadDenied: deniedSecretRead === false,
    managerExecutorMutationDenied: deniedExecutorMutations,
  });
}

function validateExercise(exercise, nowMs = Date.now()) {
  exactKeys(
    exercise,
    [
      'schemaVersion',
      'fixture',
      'observedAt',
      'identity',
      'ceremony',
      'isolation',
      'rotation',
    ],
    'exercise',
  );
  if (
    exercise.schemaVersion !== 1 ||
    exercise.fixture !== EXERCISE_FIXTURE ||
    !Number.isFinite(Date.parse(exercise.observedAt)) ||
    Date.parse(exercise.observedAt) > nowMs + 5 * 60_000 ||
    nowMs - Date.parse(exercise.observedAt) > 24 * 60 * 60_000
  ) {
    fail('exercise version or observation time is invalid');
  }
  exactKeys(
    exercise.identity,
    [
      'issuer',
      'audience',
      'requesterSubject',
      'reviewerSubject',
      'requesterAssurance',
      'reviewerAssurance',
      'keysetGenerations',
    ],
    'exercise identity',
  );
  const identity = exercise.identity;
  token(identity.issuer, 'identity issuer', 512);
  token(identity.audience, 'identity audience', 256);
  token(identity.requesterSubject, 'requester subject', 512);
  token(identity.reviewerSubject, 'reviewer subject', 512);
  if (
    identity.requesterSubject === identity.reviewerSubject ||
    !['multi_factor', 'hardware'].includes(identity.requesterAssurance) ||
    !['multi_factor', 'hardware'].includes(identity.reviewerAssurance) ||
    !Array.isArray(identity.keysetGenerations) ||
    identity.keysetGenerations.length !== 3 ||
    !identity.keysetGenerations.every(
      (generation) => Number.isSafeInteger(generation) && generation >= 1,
    ) ||
    !(identity.keysetGenerations[0] < identity.keysetGenerations[1]) ||
    !(identity.keysetGenerations[1] < identity.keysetGenerations[2])
  ) {
    fail(
      'exercise identity does not prove two strong users and three generations',
    );
  }

  exactKeys(
    exercise.ceremony,
    [
      'proposalAuditEventId',
      'approvalAuditEventId',
      'decisionAuditEventId',
      'proposeStatus',
      'proposeOperation',
      'selfDecisionStatus',
      'selfDecisionError',
      'reviewerDecisionStatus',
      'reviewerDecisionOperation',
      'inspectionStatus',
      'inspectionOperation',
    ],
    'exercise ceremony',
  );
  const ceremony = exercise.ceremony;
  if (
    ![
      ceremony.proposalAuditEventId,
      ceremony.approvalAuditEventId,
      ceremony.decisionAuditEventId,
    ].every((value) => UUID_V4_PATTERN.test(value)) ||
    new Set([
      ceremony.proposalAuditEventId,
      ceremony.approvalAuditEventId,
      ceremony.decisionAuditEventId,
    ]).size !== 3 ||
    ceremony.proposeStatus !== 200 ||
    ceremony.proposeOperation !== 'plugin-package.propose' ||
    ceremony.selfDecisionStatus !== 403 ||
    ceremony.selfDecisionError !== 'forbidden' ||
    ceremony.reviewerDecisionStatus !== 200 ||
    ceremony.reviewerDecisionOperation !== 'plugin-package.decide' ||
    ceremony.inspectionStatus !== 200 ||
    ceremony.inspectionOperation !== 'plugin-package.inspect'
  ) {
    fail('exercise ceremony did not prove the exact separation-of-duty flow');
  }

  exactKeys(
    exercise.isolation,
    [
      'labelledClientOutcome',
      'unlabelledClientOutcome',
      'wrongPortOutcome',
      'kubernetesApiEgressOutcome',
      'publicInternetEgressOutcome',
      'postgresEgressOutcome',
    ],
    'exercise isolation',
  );
  if (
    exercise.isolation.labelledClientOutcome !== 'tls13_connected' ||
    exercise.isolation.unlabelledClientOutcome !== 'timeout' ||
    exercise.isolation.wrongPortOutcome !== 'timeout' ||
    exercise.isolation.kubernetesApiEgressOutcome !== 'timeout' ||
    exercise.isolation.publicInternetEgressOutcome !== 'timeout' ||
    exercise.isolation.postgresEgressOutcome !== 'postgres_ready'
  ) {
    fail('exercise isolation outcomes are incomplete');
  }

  exactKeys(
    exercise.rotation,
    [
      'overlapOldStatus',
      'newStatus',
      'revokedOldStatus',
      'revokedOldError',
      'previousTlsSerial',
      'currentTlsSerial',
      'previousTlsSecretResourceVersion',
      'currentTlsSecretResourceVersion',
      'readinessSamples',
    ],
    'exercise rotation',
  );
  const rotation = exercise.rotation;
  token(rotation.previousTlsSerial, 'previous TLS serial', 256);
  token(rotation.currentTlsSerial, 'current TLS serial', 256);
  token(
    rotation.previousTlsSecretResourceVersion,
    'previous TLS resourceVersion',
    256,
  );
  token(
    rotation.currentTlsSecretResourceVersion,
    'current TLS resourceVersion',
    256,
  );
  const phases = ['before', 'overlap', 'revoked'];
  if (
    rotation.overlapOldStatus !== 200 ||
    rotation.newStatus !== 200 ||
    rotation.revokedOldStatus !== 401 ||
    rotation.revokedOldError !== 'authentication_required' ||
    rotation.previousTlsSerial === rotation.currentTlsSerial ||
    rotation.previousTlsSecretResourceVersion ===
      rotation.currentTlsSecretResourceVersion ||
    !Array.isArray(rotation.readinessSamples) ||
    rotation.readinessSamples.length !== 3 ||
    rotation.readinessSamples.some((sample, index) => {
      try {
        exactKeys(
          sample,
          [
            'phase',
            'replicas',
            'readyReplicas',
            'unavailableReplicas',
            'tlsProtocol',
          ],
          `rotation sample ${index + 1}`,
        );
      } catch {
        return true;
      }
      return (
        sample.phase !== phases[index] ||
        sample.replicas !== 2 ||
        sample.readyReplicas !== 2 ||
        sample.unavailableReplicas !== 0 ||
        sample.tlsProtocol !== 'TLSv1.3'
      );
    })
  ) {
    fail('exercise rotation did not preserve two TLS 1.3 replicas');
  }
  return exercise;
}

function databaseSql(auditIds) {
  const values = auditIds.map((value) => `('${value}'::varchar)`).join(',');
  return `
WITH expected_audit(event_id) AS (VALUES ${values})
SELECT json_build_object(
  'currentRole', current_user,
  'serverVersionNumber', current_setting('server_version_num')::integer,
  'migrationIds', (
    SELECT coalesce(json_agg(migration_id ORDER BY migration_id), '[]'::json)
    FROM ql3.schema_migrations
    WHERE stream_id = 'postgresql-main' AND dialect = 'postgresql'
  ),
  'controlCoreCapability', (
    SELECT contract_version
    FROM ql3.schema_capabilities
    WHERE contract_name = 'control-core'
  ),
  'tableCount', (
    SELECT count(*)::integer
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'ql3'
  ),
  'auditRows', (
    SELECT count(*)::integer
    FROM ql3.security_audit_events AS audit
    JOIN expected_audit USING (event_id)
  ),
  'ledger', (
    SELECT json_build_object(
      'generation', generation,
      'issuer', issuer,
      'audience', audience,
      'revokedKeyCount', jsonb_array_length(revoked_key_ids)
    )
    FROM ql3.plugin_package_identity_keyset_ledger
    WHERE authority = 'plugin-package-management'
  )
)::text;
`.trim();
}

function collectDatabaseSnapshot(exercise, options, runPsql) {
  const auditIds = [
    exercise.ceremony.proposalAuditEventId,
    exercise.ceremony.approvalAuditEventId,
    exercise.ceremony.decisionAuditEventId,
  ];
  const result = runPsql([
    '--no-psqlrc',
    '--no-align',
    '--tuples-only',
    '--set=ON_ERROR_STOP=1',
    `--dbname=service=${options.pgService}`,
    `--command=${databaseSql(auditIds)}`,
  ]);
  const snapshot = jsonOutput(result, 'PostgreSQL evidence query');
  const migrations = snapshot.migrationIds;
  if (
    snapshot.currentRole !== 'ql3_package_manager' ||
    snapshot.serverVersionNumber !== 180004 ||
    !Array.isArray(migrations) ||
    migrations.length !== 25 ||
    migrations.some(
      (migrationId, index) =>
        !new RegExp(`^pg-${String(index + 1).padStart(4, '0')}-`).test(
          migrationId,
        ),
    ) ||
    migrations[24] !== 'pg-0025-plugin-package-materialized-revisions' ||
    snapshot.controlCoreCapability !== 24 ||
    snapshot.tableCount !== 38 ||
    snapshot.auditRows !== 3 ||
    !snapshot.ledger ||
    snapshot.ledger.generation !== exercise.identity.keysetGenerations[2] ||
    snapshot.ledger.issuer !== exercise.identity.issuer ||
    snapshot.ledger.audience !== exercise.identity.audience ||
    !Number.isSafeInteger(snapshot.ledger.revokedKeyCount) ||
    snapshot.ledger.revokedKeyCount < 1 ||
    snapshot.ledger.revokedKeyCount > 64
  ) {
    fail('PostgreSQL manager-role evidence does not match the v24 contract');
  }
  return Object.freeze(snapshot);
}

async function readBoundedResponse(response, label) {
  if (!response || response.status !== 200) {
    fail(`${label} did not return HTTP 200`);
  }
  const contentLength = response.headers?.get?.('content-length');
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) ||
      Number(contentLength) > MAX_OIDC_DOCUMENT_BYTES)
  ) {
    fail(`${label} Content-Length is invalid`);
  }
  const chunks = [];
  let length = 0;
  if (
    response.body &&
    typeof response.body[Symbol.asyncIterator] === 'function'
  ) {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > MAX_OIDC_DOCUMENT_BYTES) {
        fail(`${label} exceeds 1 MiB`);
      }
      chunks.push(chunk);
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    length = chunk.length;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  if (bytes.length < 2 || bytes.length > MAX_OIDC_DOCUMENT_BYTES) {
    fail(`${label} size is invalid`);
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return Object.freeze({ bytes, document });
}

function externalHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} URL is invalid`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.toString() !== value ||
    net.isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.example')
  ) {
    fail(`${label} must be a canonical external HTTPS URL`);
  }
  return parsed;
}

async function collectOidcSnapshot(identity, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable');
  externalHttpsUrl(identity.issuer, 'OIDC issuer');
  const discoveryUrl = externalHttpsUrl(
    `${identity.issuer}${
      identity.issuer.endsWith('/') ? '' : '/'
    }.well-known/openid-configuration`,
    'OIDC discovery',
  ).toString();
  const request = (url) =>
    fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
  const discovery = await readBoundedResponse(
    await request(discoveryUrl),
    'OIDC discovery',
  );
  if (
    discovery.document?.issuer !== identity.issuer ||
    typeof discovery.document?.jwks_uri !== 'string'
  ) {
    fail('OIDC discovery does not bind the exercised issuer');
  }
  const jwksUrl = externalHttpsUrl(discovery.document.jwks_uri, 'OIDC JWKS');
  const jwks = await readBoundedResponse(
    await request(jwksUrl.toString()),
    'OIDC JWKS',
  );
  if (!Array.isArray(jwks.document?.keys) || jwks.document.keys.length < 1) {
    fail('OIDC JWKS contains no keys');
  }
  return Object.freeze({
    discoveryDocumentSha256: rawDigest(discovery.bytes),
    jwksSha256: rawDigest(jwks.bytes),
  });
}

function buildLiveEvidenceReport({
  kubernetes,
  database,
  oidc,
  exercise,
  observedAt,
}) {
  const report = {
    schemaVersion: 1,
    fixture: REPORT_FIXTURE,
    observedAt,
    platform: {
      kubernetesVersion: kubernetes.kubernetesVersion,
      architecture: kubernetes.architecture,
      managementImageId: kubernetes.managementImageId,
      postgresVersionNumber: database.serverVersionNumber,
      postgresImageId: kubernetes.postgresImageId,
      cniName: kubernetes.cniName,
      cniVersion: kubernetes.cniVersion,
      controlPlaneNodes: kubernetes.controlPlaneNodes,
      workerNodes: kubernetes.workerNodes,
    },
    deployment: {
      namespace: NAMESPACE,
      service: MANAGEMENT_NAME,
      replicas: kubernetes.replicas,
      readyReplicas: kubernetes.readyReplicas,
      podIdentitySha256: kubernetes.podIdentitySha256,
      nodeIdentitySha256: kubernetes.nodeIdentitySha256,
      serviceAccount: kubernetes.serviceAccount,
      automountServiceAccountToken: kubernetes.automountServiceAccountToken,
      databaseRole: database.currentRole,
      migrationCount: database.migrationIds.length,
      controlCoreCapability: database.controlCoreCapability,
      tableCount: database.tableCount,
    },
    identity: {
      providerKind: 'external_oidc',
      issuer: exercise.identity.issuer,
      discoveryDocumentSha256: oidc.discoveryDocumentSha256,
      jwksSha256: oidc.jwksSha256,
      audience: exercise.identity.audience,
      requesterSubjectSha256: digest(
        'qinglong3.management-subject.v1',
        exercise.identity.requesterSubject,
      ),
      reviewerSubjectSha256: digest(
        'qinglong3.management-subject.v1',
        exercise.identity.reviewerSubject,
      ),
      requesterAssurance: exercise.identity.requesterAssurance,
      reviewerAssurance: exercise.identity.reviewerAssurance,
      keysetGenerations: [...exercise.identity.keysetGenerations],
      finalLedgerGeneration: database.ledger.generation,
      finalRevokedKeyCount: database.ledger.revokedKeyCount,
    },
    ceremony: {
      requesterProposeAccepted: true,
      requesterSelfDecisionRejected: true,
      reviewerDecisionAccepted: true,
      requesterAndReviewerDistinct: true,
      inspectionAuthorized: true,
      durableAuditObserved: database.auditRows === 3,
    },
    isolation: {
      labelledClientAllowed: true,
      unlabelledClientDenied: true,
      wrongPortDenied: true,
      kubernetesApiEgressDenied: true,
      publicInternetEgressDenied: true,
      postgresEgressAllowed: true,
      managerSecretReadDenied: kubernetes.managerSecretReadDenied,
      managerExecutorMutationDenied: kubernetes.managerExecutorMutationDenied,
    },
    rotation: {
      overlapOldAssertionAccepted: true,
      newAssertionAccepted: true,
      revokedOldAssertionRejected: true,
      previousTlsSerialSha256: digest(
        'qinglong3.management-tls-serial.v1',
        exercise.rotation.previousTlsSerial,
      ),
      currentTlsSerialSha256: digest(
        'qinglong3.management-tls-serial.v1',
        exercise.rotation.currentTlsSerial,
      ),
      previousTlsSecretVersionSha256: digest(
        'qinglong3.management-tls-resource-version.v1',
        exercise.rotation.previousTlsSecretResourceVersion,
      ),
      currentTlsSecretVersionSha256: digest(
        'qinglong3.management-tls-resource-version.v1',
        exercise.rotation.currentTlsSecretResourceVersion,
      ),
      allReplicasReadyThroughout: true,
      tls13BeforeAndAfter: true,
    },
    gates: {
      externalIdentity: true,
      separationOfDuty: true,
      twoReplicaAvailability: true,
      networkPolicy: kubernetes.boundedNetworkPolicy,
      keysetRotation: true,
      tlsRotation: true,
      leastPrivilege:
        kubernetes.managerSecretReadDenied &&
        kubernetes.managerExecutorMutationDenied,
      schema: true,
      passed: true,
    },
  };
  const audit = validatePluginPackageManagementLiveEvidence(report);
  if (!audit.compatible) {
    fail(
      `assembled evidence was rejected: ${audit.findings
        .map(({ code }) => code)
        .join(', ')}`,
    );
  }
  return Object.freeze(report);
}

function parseArguments(argv) {
  const allowed = new Set([
    'kubeconfig',
    'context',
    'cni-daemonset',
    'cni-container',
    'cni-name',
    'exercise',
    'pg-service-file',
    'pg-service',
    'output',
  ]);
  const values = new Map();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !allowed.has(match[1]) || values.has(match[1])) {
      fail(`unknown or duplicate argument ${argument}`);
    }
    values.set(match[1], match[2]);
  }
  if (values.size !== allowed.size) {
    fail(`required arguments are: ${[...allowed].join(', ')}`);
  }
  const context = token(values.get('context'), 'Kubernetes context', 253);
  const cniContainer = token(values.get('cni-container'), 'CNI container', 63);
  const cniName = token(values.get('cni-name'), 'CNI name', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cniName)) {
    fail('CNI name is invalid');
  }
  const pgService = token(values.get('pg-service'), 'PostgreSQL service', 63);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pgService)) {
    fail('PostgreSQL service name is invalid');
  }
  const output = values.get('output');
  if (!path.isAbsolute(output) || fs.existsSync(output)) {
    fail('output must be an unused absolute path');
  }
  const outputParent = fs.realpathSync(path.dirname(output));
  if (path.join(outputParent, path.basename(output)) !== output) {
    fail('output parent must be canonical');
  }
  return Object.freeze({
    kubeconfig: canonicalPrivatePath(
      values.get('kubeconfig'),
      'Kubernetes config',
    ),
    context,
    cniDaemonSet: parseCniReference(values.get('cni-daemonset')),
    cniContainer,
    cniName,
    exercisePath: canonicalPrivatePath(
      values.get('exercise'),
      'exercise evidence',
    ),
    pgServiceFile: canonicalPrivatePath(
      values.get('pg-service-file'),
      'PostgreSQL service file',
    ),
    pgService,
    output,
  });
}

function commandRunner(binary, baseArgs = [], environment = process.env) {
  return (args) => {
    const result = spawnSync(binary, [...baseArgs, ...args], {
      encoding: 'utf8',
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      fail(`${path.basename(binary)} failed: ${result.error.message}`);
    }
    return Object.freeze({
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  };
}

function writeNoReplace(filePath, report) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const exercise = validateExercise(
    readPrivateJson(options.exercisePath, 'exercise evidence'),
  );
  const kubectl = commandRunner(process.env.QL3_KUBECTL_BIN || 'kubectl', [
    '--kubeconfig',
    options.kubeconfig,
    '--context',
    options.context,
  ]);
  const psql = commandRunner(process.env.QL3_PSQL_BIN || 'psql', [], {
    ...process.env,
    PGSERVICEFILE: options.pgServiceFile,
  });
  const kubernetes = collectKubernetesSnapshot(options, kubectl);
  const database = collectDatabaseSnapshot(exercise, options, psql);
  const oidc = await collectOidcSnapshot(exercise.identity);
  const report = buildLiveEvidenceReport({
    kubernetes,
    database,
    oidc,
    exercise,
    observedAt: new Date().toISOString(),
  });
  writeNoReplace(options.output, report);
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      fixture: REPORT_FIXTURE,
      output: options.output,
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'unknown collection error'
      }\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PluginPackageManagementLiveEvidenceCollectionError,
  buildLiveEvidenceReport,
  collectDatabaseSnapshot,
  collectKubernetesSnapshot,
  collectOidcSnapshot,
  parseArguments,
  policyIsBounded,
  validateExercise,
};
