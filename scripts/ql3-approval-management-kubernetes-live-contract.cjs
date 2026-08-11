#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  K3sDockerLiveFixture,
  run,
  waitFor,
} = require('./lib/ql3-k3s-docker-live.cjs');
const { createMutualTlsPki } = require('./lib/ql3-live-pki.cjs');
const {
  clientTcpProbe,
  createManagementClientExecutor,
  patchManagementGeneration,
  podReady,
  podTcpProbe,
  readyManagementPods,
  waitForTwoPreserved,
  waitManagementRollout,
} = require('./lib/ql3-management-kubernetes-live.cjs');
const {
  createManagementIdentityCeremony,
} = require('./lib/ql3-management-live-identity.cjs');
const {
  imageDigest,
  imageTag,
  reviewedOperatorManifest,
} = require('./ql3-cloudnativepg-live-contract.cjs');
const {
  FIXTURE,
  LIMITATIONS,
  validateApprovalManagementKubernetesLiveReport,
} = require('./ql3-approval-management-kubernetes-live-audit.cjs');

const ROOT = path.resolve(__dirname, '..');
const NAMESPACE = 'qinglong3-system';
const DEPLOYMENT = 'ql3-approval-management';
const SERVICE = DEPLOYMENT;
const SERVERNAME = SERVICE + '.' + NAMESPACE + '.svc';
const MANAGEMENT_PATH = '/api/v3/approvals/management';
const POSTGRES_CLUSTER = 'ql3-postgres';
const ISSUER = 'https://identity.qinglong.test/';
const AUDIENCE = 'qinglong3-approval-management';
const LOCK = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg/operator-lock.json',
    ),
    'utf8',
  ),
);
const OPERATOR_IMAGE = LOCK.operator.image;
const POSTGRES_IMAGE = LOCK.operand.image;
const OPERATOR_VERSION = LOCK.operator.version;
const ADMIN_IMAGE_BASE = 'ql3-approval-manager-live';
const CONTROL_IMAGE_BASE = 'ql3-approval-migration-live';
const ZERO_DIGEST = 'sha256:' + '0'.repeat(64);
const ROLE_NAMES = Object.freeze([
  'ql3_migration',
  'ql3_runtime',
  'ql3_admin',
  'ql3_package_manager',
  'ql3_package_executor',
  'ql3_automation_manager',
  'ql3_approval_manager',
  'ql3_worker_credential_manager',
  'ql3_worker_credential_executor',
  'ql3_worker_ingress',
]);
const ACTION = Object.freeze({
  permission: 'run.start',
  actionType: 'tool.invoke',
  actionRef: 'tool:approval-live',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});
const identity = createManagementIdentityCeremony({
  issuer: ISSUER,
  audience: AUDIENCE,
  purpose: 'approval-management',
  tokenType: 'ql3-approval-management+jwt',
  subject: 'approval-operator',
  jtiPrefix: 'ql3-approval-live',
});

function sha256(value) {
  return (
    'sha256:' +
    crypto.createHash('sha256').update(value).digest('hex')
  );
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function eventId(ordinal) {
  assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal < 1e12);
  return (
    '40000000-0000-4000-8000-' + String(ordinal).padStart(12, '0')
  );
}

function reviewedKey(kid) {
  return identity.reviewedKey(kid);
}

function keyset(generation, keys, revokedKids = []) {
  return identity.keyset(generation, keys, revokedKids);
}

function assertion(key, suffix) {
  return identity.assertion(key, suffix);
}

function assertionForSubject(
  key,
  subject,
  suffix = crypto.randomUUID(),
) {
  assert.match(subject, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-approval-management+jwt',
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: AUDIENCE,
      auth_time: now - 1,
      exp: now + 290,
      iat: now,
      iss: ISSUER,
      jti: 'ql3-approval-live-subject-' + suffix,
      ql3_purpose: 'approval-management',
      sub: subject,
    }),
  ).toString('base64url');
  const signed = header + '.' + payload;
  return (
    signed +
    '.' +
    crypto
      .sign(null, Buffer.from(signed, 'ascii'), key.privateKey)
      .toString('base64url')
  );
}

function weakAssertion(key, suffix = crypto.randomUUID()) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-approval-management+jwt',
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:password',
      amr: ['pwd'],
      aud: AUDIENCE,
      auth_time: now - 1,
      exp: now + 290,
      iat: now,
      iss: ISSUER,
      jti: 'ql3-approval-live-weak-' + suffix,
      ql3_purpose: 'approval-management',
      sub: 'approval-operator',
    }),
  ).toString('base64url');
  const signed = header + '.' + payload;
  return (
    signed +
    '.' +
    crypto
      .sign(null, Buffer.from(signed, 'ascii'), key.privateKey)
      .toString('base64url')
  );
}

function commandBase(projectId, approvalRequestId, requestId, ordinal) {
  return Object.freeze({
    projectId,
    approvalRequestId,
    requestId,
    auditEventId: eventId(ordinal),
    failureAuditEventId: eventId(ordinal + 500_000),
  });
}

function inspectCommand(projectId, approvalRequestId, requestId, ordinal) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'approval.inspect',
    request: commandBase(
      projectId,
      approvalRequestId,
      requestId,
      ordinal,
    ),
  });
}

function decisionCommand(
  projectId,
  approvalRequestId,
  requestId,
  decisionId,
  ordinal,
) {
  return Object.freeze({
    schemaVersion: 1,
    operation: 'approval.decide',
    request: Object.freeze({
      ...commandBase(
        projectId,
        approvalRequestId,
        requestId,
        ordinal,
      ),
      expectedVersion: 1,
      expectedAction: ACTION,
      decisionId,
      decision: 'approved',
      reasonCode: 'reviewed',
    }),
  });
}

function imageIdDigest(image) {
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return image.Id;
}

function localManifest(rendered, imageName, localImage) {
  const placeholder = imageName + '@' + ZERO_DIGEST;
  assert.equal(rendered.split(placeholder).length - 1, 1);
  return rendered.replace(placeholder, localImage);
}

function applySecret(fixture, name, type, stringData) {
  fixture.apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: NAMESPACE },
    type,
    stringData,
  });
}

function psql(fixture, podName, sql) {
  return fixture.kubectl(
    [
      '-n',
      NAMESPACE,
      'exec',
      podName,
      '-c',
      'postgres',
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'qinglong',
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { capture: true, quiet: true },
  ).stdout;
}

function currentPrimaryPod(fixture) {
  const primaryName = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'cluster',
    POSTGRES_CLUSTER,
  ]).status.currentPrimary;
  assert.match(primaryName || '', /^ql3-postgres-[1-9][0-9]*$/);
  const pods = fixture.kubectlJson([
    '-n',
    NAMESPACE,
    'get',
    'pods',
    '-l',
    'cnpg.io/cluster=' + POSTGRES_CLUSTER,
  ]).items;
  const primary = pods.find((pod) => pod.metadata.name === primaryName);
  assert.ok(primary, 'CloudNativePG primary Pod not found');
  return primary;
}

function sqlString(value) {
  assert.equal(typeof value, 'string');
  return "'" + value.replaceAll("'", "''") + "'";
}

function loadApprovalContract() {
  const file = path.join(
    ROOT,
    'packages/ql3-runtime-core/dist/approved-action/approvedAction.js',
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      'runtime-core must be built before the Approval Kubernetes live contract',
    );
  }
  return require(file);
}

function seedApproval(
  fixture,
  primaryPod,
  projectId,
  approvalRequestId,
) {
  const { approvalRequestDigest, createApprovalRequest } =
    loadApprovalContract();
  const requestedAtMs = Date.now() - 1_000;
  const request = createApprovalRequest({
    id: approvalRequestId,
    projectId,
    action: ACTION,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'approval-requester' },
    requestedAtMs,
    expiresAtMs: requestedAtMs + 60 * 60 * 1000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const requestJson = JSON.stringify(request);
  assert.equal(requestJson.includes('$ql3json$'), false);
  psql(
    fixture,
    primaryPod.metadata.name,
    [
      'INSERT INTO "ql3"."projects" (',
      '  id, name, slug, status, version, created_at_ms, updated_at_ms',
      ') VALUES (' +
        sqlString(projectId) +
        ", 'Approval Live', " +
        sqlString(projectId) +
        ", 'active', 1, " +
        String(requestedAtMs) +
        ', ' +
        String(requestedAtMs) +
        ');',
      'INSERT INTO "ql3"."project_role_bindings" (',
      '  project_id, subject_type, subject_id, version, state, role,',
      '  mutation_id, changed_by_type, changed_by_id, created_at_ms',
      ') VALUES (' +
        sqlString(projectId) +
        ", 'user', 'approval-operator', 1, 'active', 'owner'," +
        " 'approval-live-owner-v1', 'system', 'live-contract', " +
        String(requestedAtMs) +
        ');',
      'INSERT INTO "ql3"."approval_requests" (',
      '  request_id, project_id, version, state, action_type, action_ref,',
      '  action_digest, preview_digest, requested_by_type, requested_by_id,',
      '  decision_id, consumption_id, dispatch_id, expires_at_ms,',
      '  request_json, request_digest, updated_at_ms',
      ') VALUES (' +
        sqlString(approvalRequestId) +
        ', ' +
        sqlString(projectId) +
        ", 1, 'pending', " +
        sqlString(ACTION.actionType) +
        ', ' +
        sqlString(ACTION.actionRef) +
        ', ' +
        sqlString(ACTION.actionDigest) +
        ', ' +
        sqlString(ACTION.previewDigest) +
        ", 'agent', 'approval-requester', NULL, NULL, NULL, " +
        String(request.expiresAtMs) +
        ', $ql3json$' +
        requestJson +
        '$ql3json$::jsonb, ' +
        sqlString(approvalRequestDigest(request)) +
        ', ' +
        String(requestedAtMs) +
        ');',
    ].join('\n'),
  );
  return request;
}

function managerOptions(fixture) {
  return {
    fixture,
    namespace: NAMESPACE,
    deployment: DEPLOYMENT,
    description: 'two Ready approval manager Pods on distinct nodes',
  };
}

function patchGeneration(fixture, generation, annotations = {}) {
  patchManagementGeneration({
    ...managerOptions(fixture),
    generation,
    annotations,
  });
}

function healthStatus(fixture, pod, route) {
  const script = [
    "const fs=require('node:fs');const https=require('node:https');",
    "const request=https.request({host:'127.0.0.1',port:8447,path:process.argv[1],",
    "servername:process.argv[2],ca:fs.readFileSync('/var/run/secrets/qinglong3/approval-management-tls/ca.crt'),",
    "minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,agent:false},",
    "(response)=>{response.resume();response.on('end',()=>process.stdout.write(String(response.statusCode)))});",
    "request.on('error',(error)=>{process.stderr.write(error.message);process.exitCode=1});request.end();",
  ].join('\n');
  return Number(
    fixture.kubectl(
      [
        '-n',
        NAMESPACE,
        'exec',
        pod.metadata.name,
        '--',
        'node',
        '-e',
        script,
        route,
        SERVERNAME,
      ],
      { capture: true, quiet: true },
    ).stdout,
  );
}

function privateReportPath(argv) {
  if (
    argv.length !== 1 ||
    !argv[0].startsWith('--report=') ||
    !path.isAbsolute(argv[0].slice('--report='.length))
  ) {
    throw new Error(
      'usage: ql3-approval-management-kubernetes-live-contract ' +
        '--report=/absolute/private-report.json',
    );
  }
  const reportFile = argv[0].slice('--report='.length);
  if (fs.existsSync(reportFile)) {
    throw new Error('refusing to overwrite the Approval live report');
  }
  const parent = fs.lstatSync(path.dirname(reportFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Approval live report parent must be a real directory');
  }
  return reportFile;
}

async function main(argv = process.argv.slice(2)) {
  const reportFile = privateReportPath(argv);
  if (process.env.QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE !== '1') {
    throw new Error(
      'Refusing to mutate Docker/Kubernetes without ' +
        'QL3_APPROVAL_MANAGEMENT_KUBERNETES_LIVE=1',
    );
  }
  const operatorManifestFile = process.env.QL3_CNPG_OPERATOR_MANIFEST_FILE;
  if (!operatorManifestFile) {
    throw new Error('QL3_CNPG_OPERATOR_MANIFEST_FILE is required');
  }
  const reviewedManifest = reviewedOperatorManifest(operatorManifestFile);
  const fixture = new K3sDockerLiveFixture({ prefix: 'ql3-approval-live' });
  const suffix =
    process.pid.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const adminImage = ADMIN_IMAGE_BASE + ':' + suffix;
  const controlImage = CONTROL_IMAGE_BASE + ':' + suffix;
  let adminImageBuilt = false;
  let controlImageBuilt = false;
  try {
    const nodes = await fixture.start();
    const architecture = fixture.inspectImage(fixture.k3sImage).Architecture;
    assert.ok(['amd64', 'arm64'].includes(architecture));

    for (const reviewedImage of [OPERATOR_IMAGE, POSTGRES_IMAGE]) {
      run(fixture.docker, ['pull', reviewedImage]);
      const inspected = fixture.inspectImage(reviewedImage);
      assert.ok(
        inspected.RepoDigests?.some((entry) =>
          entry.endsWith('@' + imageDigest(reviewedImage)),
        ),
        'Docker did not retain reviewed digest for ' + reviewedImage,
      );
      const preloadTag = imageTag(reviewedImage);
      run(fixture.docker, ['tag', reviewedImage, preloadTag]);
      fixture.loadImage(
        preloadTag,
        path.basename(preloadTag) + '.tar',
      );
    }

    const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
      capture: true,
      quiet: true,
    }).stdout;
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-admin/Dockerfile',
      '--tag',
      adminImage,
      '--build-arg',
      'SOURCE_REVISION=' + sourceRevision,
      '.',
    ]);
    adminImageBuilt = true;
    fixture.loadImage(adminImage, 'approval-admin.tar');
    run(fixture.docker, [
      'build',
      '--file',
      'deploy/containers/ql3-cluster-control/Dockerfile',
      '--tag',
      controlImage,
      '--build-arg',
      'SOURCE_REVISION=' + sourceRevision,
      '.',
    ]);
    controlImageBuilt = true;
    fixture.loadImage(controlImage, 'approval-migration.tar');
    const adminImageInfo = fixture.inspectImage(adminImage);
    const postgresImageInfo = fixture.inspectImage(POSTGRES_IMAGE);
    const k3sImageInfo = fixture.inspectImage(fixture.k3sImage);

    fixture.kubectl(['apply', '--server-side', '-f', reviewedManifest]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'set',
      'image',
      'deployment/cnpg-controller-manager',
      'manager=' + imageTag(OPERATOR_IMAGE),
    ]);
    fixture.kubectl([
      'wait',
      '--for=condition=Established',
      'crd/clusters.postgresql.cnpg.io',
      'crd/databaseroles.postgresql.cnpg.io',
      'crd/databases.postgresql.cnpg.io',
      '--timeout=5m',
    ]);
    fixture.kubectl([
      '-n',
      'cnpg-system',
      'rollout',
      'status',
      'deployment/cnpg-controller-manager',
      '--timeout=5m',
    ]);

    fixture.kubectl([
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/namespace.yaml',
    ]);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'apply',
      '-f',
      'deploy/kubernetes/ql3-cluster/base/service-account.yaml',
    ]);
    const passwords = Object.fromEntries(
      ROLE_NAMES.map((role) => [role, randomSecret()]),
    );
    for (const role of ROLE_NAMES) {
      applySecret(
        fixture,
        'ql3-postgres-' +
          role.replace(/^ql3_/, '').replaceAll('_', '-') +
          '-auth',
        'kubernetes.io/basic-auth',
        { username: role, password: passwords[role] },
      );
    }
    const databaseManifest = fixture
      .kubectl(
        ['kustomize', 'deploy/kubernetes/ql3-cluster/operators/cloudnative-pg'],
        { capture: true, quiet: true },
      )
      .stdout.replace(POSTGRES_IMAGE, imageTag(POSTGRES_IMAGE));
    assert.equal(databaseManifest.includes(POSTGRES_IMAGE), false);
    fixture.kubectl(['apply', '-f', '-'], {
      input: databaseManifest + '\n',
    });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Ready',
      'cluster/' + POSTGRES_CLUSTER,
      '--timeout=20m',
    ]);
    const databasePods = (
      await waitFor(
        'three ready CloudNativePG instances',
        600_000,
        () => {
          const pods = fixture
            .kubectlJson([
              '-n',
              NAMESPACE,
              'get',
              'pods',
              '-l',
              'cnpg.io/cluster=' + POSTGRES_CLUSTER,
            ])
            .items.filter(podReady);
          return pods.length === 3
            ? { ready: true, value: pods }
            : {
                ready: false,
                fact: pods.length + '/3 ready database Pods',
              };
        },
      )
    ).value;

    const migrationManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-control',
      controlImage,
    );
    fixture.kubectl(['create', '-f', '-'], {
      input: migrationManifest + '\n',
    });
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'wait',
      '--for=condition=Complete',
      'job/ql3-cluster-migration',
      '--timeout=10m',
    ]);
    const migrationPrimary = currentPrimaryPod(fixture);
    const migrationState = JSON.parse(
      psql(
        fixture,
        migrationPrimary.metadata.name,
        [
          'SELECT json_build_object(',
          "  'migrationCount', (SELECT count(*)::integer",
          '    FROM "ql3"."schema_migrations"),',
          "  'controlCoreCapability', (SELECT contract_version::integer",
          '    FROM "ql3"."schema_capabilities"',
          "    WHERE contract_name = 'control-core'))",
        ].join('\n'),
      ),
    );
    assert.deepEqual(migrationState, {
      migrationCount: 54,
      controlCoreCapability: 53,
    });

    const projectId = 'approval-live-' + suffix;
    const approvalRequestId = 'approval-request-' + suffix;
    const decisionId = 'approval-decision-' + suffix;
    const primary = currentPrimaryPod(fixture);
    seedApproval(
      fixture,
      primary,
      projectId,
      approvalRequestId,
    );

    const pki = createMutualTlsPki({
      directory: fixture.temporary,
      servername: SERVERNAME,
      label: 'QL3 Approval Management Live',
      run,
      crypto,
    });
    let pkiMaterial = pki.read();
    const oldKey = reviewedKey('approval-live-key-1');
    const newKey = reviewedKey('approval-live-key-2');
    const keysets = [
      keyset(1, [oldKey]),
      keyset(2, [oldKey, newKey]),
      keyset(3, [oldKey, newKey], [oldKey.kid]),
    ];
    const applyIdentity = (document) =>
      applySecret(fixture, DEPLOYMENT + '-identity', 'Opaque', {
        'keyset.json': JSON.stringify(document) + '\n',
      });
    const applyTls = () =>
      applySecret(fixture, DEPLOYMENT + '-tls', 'kubernetes.io/tls', {
        'tls.crt': pkiMaterial.serverCertificate,
        'tls.key': pkiMaterial.serverKey,
        'ca.crt': pkiMaterial.ca,
        'client.crl': pkiMaterial.clientCrl,
      });
    applyIdentity(keysets[0]);
    applyTls();

    const previousBundleSha256 = pki.bundleSha256();
    const caDigest = sha256(pkiMaterial.ca);
    const crlDigest = sha256(pkiMaterial.clientCrl);
    let managerManifest = localManifest(
      fixture.kubectl(
        [
          'kustomize',
          'deploy/kubernetes/ql3-cluster/operations/approval-management/cloudnative-pg',
        ],
        { capture: true, quiet: true },
      ).stdout,
      'registry.example.com/qinglong/qinglong3-cluster-admin',
      adminImage,
    );
    assert.equal(managerManifest.split(ZERO_DIGEST).length - 1, 2);
    managerManifest = managerManifest
      .replace(ZERO_DIGEST, caDigest)
      .replace(ZERO_DIGEST, crlDigest);
    fixture.kubectl(['apply', '-f', '-'], {
      input: managerManifest + '\n',
    });
    waitManagementRollout(managerOptions(fixture));
    let managerPods = await readyManagementPods(managerOptions(fixture));

    const deployment = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'deployment',
      DEPLOYMENT,
    ]);
    assert.equal(deployment.spec.replicas, 2);
    assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
    assert.equal(
      deployment.spec.template.spec.automountServiceAccountToken,
      false,
    );
    assert.equal(
      deployment.spec.template.spec.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution.length,
      1,
    );
    assert.equal(
      fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'pdb',
        DEPLOYMENT,
      ]).spec.minAvailable,
      1,
    );
    for (const pod of managerPods) {
      assert.equal(pod.spec.serviceAccountName, DEPLOYMENT);
      assert.equal(pod.spec.automountServiceAccountToken, false);
      assert.equal(
        pod.spec.volumes.some((volume) =>
          volume.projected?.sources?.some(
            (source) => source.serviceAccountToken !== undefined,
          ),
        ),
        false,
      );
    }

    const executeClient = createManagementClientExecutor({
      fixture,
      namespace: NAMESPACE,
      servername: SERVERNAME,
      port: 8447,
      managementPath: MANAGEMENT_PATH,
      adminImage,
      ca: pkiMaterial.ca,
      serviceAccount: 'ql3-approval-management-client',
      appName: 'ql3-approval-management-client',
      component: 'approval-management-client',
      networkPolicyLabel: 'qinglong.io/approval-management-client',
      clientCliPath:
        '/opt/qinglong/node_modules/@qinglong/cluster-admin/' +
        'dist/approval-management/approvalManagementClientCli.js',
      description: 'approval management',
    });
    const oldAssertion = () => assertion(oldKey);
    const newAssertion = () => assertion(newKey);
    const initialRequests = await Promise.all([
      executeClient(
        {
          name: 'ql3-approval-inspect-initial-a',
          target: managerPods[0],
          command: inspectCommand(
            projectId,
            approvalRequestId,
            'approval-inspect-initial-a',
            1,
          ),
          bearer: oldAssertion(),
          clientCertificate: pkiMaterial.oldClientCertificate,
          clientKey: pkiMaterial.oldClientKey,
        },
        { statusCode: 200, resultStatus: ['found'] },
      ),
      executeClient(
        {
          name: 'ql3-approval-inspect-initial-b',
          target: managerPods[1],
          command: inspectCommand(
            projectId,
            approvalRequestId,
            'approval-inspect-initial-b',
            2,
          ),
          bearer: oldAssertion(),
          clientCertificate: pkiMaterial.newClientCertificate,
          clientKey: pkiMaterial.newClientKey,
        },
        { statusCode: 200, resultStatus: ['found'] },
      ),
    ]);
    assert.deepEqual(
      initialRequests.map((entry) => entry.output.result.status),
      ['found', 'found'],
    );
    const weakUserRejected = await executeClient(
      {
        name: 'ql3-approval-inspect-weak-user',
        target: managerPods[0],
        command: inspectCommand(
          projectId,
          approvalRequestId,
          'approval-inspect-weak-user',
          3,
        ),
        bearer: weakAssertion(oldKey),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const outsiderDenied = await executeClient(
      {
        name: 'ql3-approval-inspect-outsider',
        target: managerPods[1],
        command: inspectCommand(
          projectId,
          approvalRequestId,
          'approval-inspect-outsider',
          10,
        ),
        bearer: assertionForSubject(oldKey, 'approval-outsider'),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 403, responseCode: 'forbidden' },
    );

    const generation1Uids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    applyIdentity(keysets[1]);
    patchGeneration(fixture, 2);
    const generation2 = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: generation1Uids,
      expectedGeneration: 2,
      description:
        'zero-unavailable approval manager identity generation 2 rollout',
    });
    managerPods = generation2.pods;
    const overlapOld = await executeClient(
      {
        name: 'ql3-approval-inspect-overlap-old',
        target: managerPods[0],
        command: inspectCommand(
          projectId,
          approvalRequestId,
          'approval-inspect-overlap-old',
          4,
        ),
        bearer: oldAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['found'] },
    );
    const decided = await executeClient(
      {
        name: 'ql3-approval-decide-overlap-new',
        target: managerPods[1],
        command: decisionCommand(
          projectId,
          approvalRequestId,
          'approval-decide-overlap-new',
          decisionId,
          5,
        ),
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['decided'] },
    );
    assert.equal(decided.output.result.approval.state, 'approved');
    assert.equal(decided.output.result.approval.version, 2);

    const generation2Uids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    applyIdentity(keysets[2]);
    patchGeneration(fixture, 3);
    const generation3 = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: generation2Uids,
      expectedGeneration: 3,
      description:
        'zero-unavailable approval manager identity generation 3 rollout',
    });
    managerPods = generation3.pods;
    const rejectedOldKey = await executeClient(
      {
        name: 'ql3-approval-inspect-revoked-key',
        target: managerPods[0],
        command: inspectCommand(
          projectId,
          approvalRequestId,
          'approval-inspect-revoked-key',
          6,
        ),
        bearer: oldAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 401, responseCode: 'authentication_required' },
    );
    const replayed = await executeClient(
      {
        name: 'ql3-approval-decide-active-key',
        target: managerPods[1],
        command: decisionCommand(
          projectId,
          approvalRequestId,
          'approval-decide-active-key',
          decisionId,
          7,
        ),
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['existing'] },
    );

    applyIdentity(keysets[1]);
    patchGeneration(fixture, 'rollback-2');
    const rollback = await waitFor(
      'approval identity ledger rollback surge failure',
      180_000,
      () => {
        const pods = fixture
          .kubectlJson([
            '-n',
            NAMESPACE,
            'get',
            'pods',
            '-l',
            'app.kubernetes.io/name=' + DEPLOYMENT,
          ])
          .items.filter(
            (pod) => pod.metadata.deletionTimestamp === undefined,
          );
        const ready = pods.filter(podReady);
        const candidate = pods.find(
          (pod) =>
            !managerPods.some(
              (current) => current.metadata.uid === pod.metadata.uid,
            ) &&
            pod.status.containerStatuses?.[0] &&
            !pod.status.containerStatuses[0].ready &&
            (pod.status.containerStatuses[0].restartCount > 0 ||
              pod.status.containerStatuses[0].state?.waiting?.reason ===
                'CrashLoopBackOff'),
        );
        return ready.length === 2 && candidate
          ? { ready: true, value: candidate }
          : {
              ready: false,
              fact:
                ready.length +
                ' ready Pods; rollback candidate=' +
                Boolean(candidate),
            };
      },
    );
    applyIdentity(keysets[2]);
    patchGeneration(fixture, '3-rollback-recovered');
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      rollback.value.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=true',
    ]);
    waitManagementRollout(managerOptions(fixture));
    managerPods = await readyManagementPods(managerOptions(fixture));

    const previousSerialSha256 = pki.oldSerialSha256();
    pki.revokeOldClient();
    pkiMaterial = pki.read();
    const currentBundleSha256 = pki.bundleSha256();
    assert.notEqual(currentBundleSha256, previousBundleSha256);
    applyTls();
    const preCertificateUids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    patchGeneration(fixture, '3-client-crl-2', {
      'qinglong.io/approval-management-client-ca-sha256': sha256(
        pkiMaterial.ca,
      ),
      'qinglong.io/approval-management-client-crl-sha256': sha256(
        pkiMaterial.clientCrl,
      ),
    });
    const certificateRollout = await waitForTwoPreserved({
      ...managerOptions(fixture),
      excludedUids: preCertificateUids,
      expectedGeneration: '3-client-crl-2',
      description:
        'zero-unavailable approval manager client certificate rollout',
    });
    managerPods = certificateRollout.pods;
    const revokedCertificate = await executeClient(
      {
        name: 'ql3-approval-decide-revoked-cert',
        target: managerPods[0],
        command: decisionCommand(
          projectId,
          approvalRequestId,
          'approval-decide-revoked-cert',
          decisionId,
          8,
        ),
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.oldClientCertificate,
        clientKey: pkiMaterial.oldClientKey,
      },
      {
        statusCode: 401,
        responseCode: 'client_certificate_required',
      },
    );
    const activeCertificate = await executeClient(
      {
        name: 'ql3-approval-decide-active-cert',
        target: managerPods[1],
        command: decisionCommand(
          projectId,
          approvalRequestId,
          'approval-decide-active-cert',
          decisionId,
          9,
        ),
        bearer: newAssertion(),
        clientCertificate: pkiMaterial.newClientCertificate,
        clientKey: pkiMaterial.newClientKey,
      },
      { statusCode: 200, resultStatus: ['existing'] },
    );

    const primaryBeforeFailover = currentPrimaryPod(fixture);
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'delete',
      'pod',
      primaryBeforeFailover.metadata.name,
      '--grace-period=0',
      '--force',
      '--wait=false',
    ]);
    const promoted = await waitFor(
      'CloudNativePG primary promotion',
      600_000,
      () => {
        const status = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'cluster',
          POSTGRES_CLUSTER,
        ]).status;
        return status.currentPrimary &&
          status.currentPrimary !== primaryBeforeFailover.metadata.name &&
          Number(status.readyInstances) >= 2
          ? { ready: true, value: status.currentPrimary }
          : {
              ready: false,
              fact:
                'primary=' +
                (status.currentPrimary || 'none') +
                ' ready=' +
                String(status.readyInstances ?? 0),
            };
      },
    );
    await waitFor(
      'CloudNativePG recovery to three instances',
      900_000,
      () => {
        const status = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'cluster',
          POSTGRES_CLUSTER,
        ]).status;
        return Number(status.readyInstances) === 3
          ? { ready: true, value: status }
          : {
              ready: false,
              fact:
                String(status.readyInstances ?? 0) +
                '/3 ready database instances',
            };
      },
    );

    const databaseService = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      POSTGRES_CLUSTER + '-rw',
    ]);
    const databaseSelector = databaseService.spec.selector;
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      POSTGRES_CLUSTER + '-rw',
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: {
          selector: { ...databaseSelector, 'ql3.invalid': 'true' },
        },
      }),
    ]);
    const unavailable = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name:
              'ql3-approval-database-unavailable-' + String(index + 1),
            target: pod,
            command: decisionCommand(
              projectId,
              approvalRequestId,
              'approval-database-unavailable-' + String(index + 1),
              decisionId,
              20 + index,
            ),
            bearer: newAssertion(),
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          { statusCode: 503, responseCode: 'unavailable' },
        ),
      ),
    );
    assert.deepEqual(
      unavailable.map((entry) => entry.statusCode),
      [503, 503],
    );
    await waitFor('approval manager readiness withdrawal', 60_000, () => {
      const current = fixture.kubectlJson([
        '-n',
        NAMESPACE,
        'get',
        'deployment',
        DEPLOYMENT,
      ]);
      return Number(current.status.readyReplicas ?? 0) === 0
        ? { ready: true, value: current }
        : {
            ready: false,
            fact:
              String(current.status.readyReplicas ?? 0) +
              ' ready replicas',
          };
    });
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/readyz')),
      [503, 503],
    );
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/livez')),
      [200, 200],
    );
    fixture.kubectl([
      '-n',
      NAMESPACE,
      'patch',
      'service',
      POSTGRES_CLUSTER + '-rw',
      '--type=json',
      '-p',
      JSON.stringify([
        {
          op: 'replace',
          path: '/spec/selector',
          value: databaseSelector,
        },
      ]),
    ]);
    await waitFor(
      'restored CloudNativePG service endpoint',
      120_000,
      () => {
        const endpoints = fixture.kubectlJson([
          '-n',
          NAMESPACE,
          'get',
          'endpoints',
          POSTGRES_CLUSTER + '-rw',
        ]);
        const count = endpoints.subsets?.flatMap(
          (subset) => subset.addresses ?? [],
        ).length;
        return count >= 1
          ? { ready: true, value: count }
          : {
              ready: false,
              fact: String(count ?? 0) + ' service endpoints',
            };
      },
    );
    assert.deepEqual(
      managerPods.map((pod) => healthStatus(fixture, pod, '/readyz')),
      [503, 503],
    );
    const staleUids = new Set(
      managerPods.map((pod) => pod.metadata.uid),
    );
    patchGeneration(fixture, '3-database-recovered');
    managerPods = await readyManagementPods({
      ...managerOptions(fixture),
      excludedUids: staleUids,
      expectedGeneration: '3-database-recovered',
    });
    const recoveredRequests = await Promise.all(
      managerPods.map((pod, index) =>
        executeClient(
          {
            name:
              'ql3-approval-database-recovered-' + String(index + 1),
            target: pod,
            command: decisionCommand(
              projectId,
              approvalRequestId,
              'approval-database-recovered-' + String(index + 1),
              decisionId,
              30 + index,
            ),
            bearer: newAssertion(),
            clientCertificate: pkiMaterial.newClientCertificate,
            clientKey: pkiMaterial.newClientKey,
          },
          { statusCode: 200, resultStatus: ['existing'] },
        ),
      ),
    );
    assert.deepEqual(
      recoveredRequests.map((entry) => entry.output.result.status),
      ['existing', 'existing'],
    );

    const finalPrimary = currentPrimaryPod(fixture);
    const durable = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        [
          'SELECT json_build_object(',
          "  'approvalVersion', (SELECT version::integer",
          '    FROM "ql3"."approval_requests"',
          '    WHERE request_id = ' + sqlString(approvalRequestId) + '),',
          "  'approvalState', (SELECT state",
          '    FROM "ql3"."approval_requests"',
          '    WHERE request_id = ' + sqlString(approvalRequestId) + '),',
          "  'decisionId', (SELECT decision_id",
          '    FROM "ql3"."approval_requests"',
          '    WHERE request_id = ' + sqlString(approvalRequestId) + '),',
          "  'allowedAuditCount', (SELECT count(*)::integer",
          '    FROM "ql3"."security_audit_events"',
          '    WHERE project_id = ' +
            sqlString(projectId) +
            " AND outcome = 'allowed'),",
          "  'deniedAuditCount', (SELECT count(*)::integer",
          '    FROM "ql3"."security_audit_events"',
          '    WHERE project_id = ' +
            sqlString(projectId) +
            " AND outcome = 'denied'),",
          "  'decisionAuditCount', (SELECT count(*)::integer",
          '    FROM "ql3"."security_audit_events"',
          '    WHERE project_id = ' +
            sqlString(projectId) +
            " AND operation_id = 'approval.decide'" +
            " AND outcome = 'allowed'),",
          "  'identityGeneration', (SELECT generation::integer",
          '    FROM "ql3"."plugin_package_identity_keyset_ledger"',
          "    WHERE authority = 'approval-management'),",
          "  'migrationCount', (SELECT count(*)::integer",
          '    FROM "ql3"."schema_migrations"),',
          "  'controlCoreCapability', (SELECT contract_version::integer",
          '    FROM "ql3"."schema_capabilities"',
          "    WHERE contract_name = 'control-core'),",
          "  'postgresVersionNumber',",
          "    current_setting('server_version_num')::integer,",
          "  'currentUser', current_user)",
        ].join('\n'),
      ),
    );
    assert.deepEqual(durable, {
      approvalVersion: 2,
      approvalState: 'approved',
      decisionId,
      allowedAuditCount: 4,
      deniedAuditCount: 1,
      decisionAuditCount: 1,
      identityGeneration: 3,
      migrationCount: 54,
      controlCoreCapability: 53,
      postgresVersionNumber: 180004,
      currentUser: 'postgres',
    });

    const roleList = ROLE_NAMES.map(sqlString).join(',');
    const roleRows = JSON.parse(
      psql(
        fixture,
        finalPrimary.metadata.name,
        [
          'SELECT json_agg(json_build_object(',
          "  'name', rolname,",
          "  'login', rolcanlogin,",
          "  'superuser', rolsuper,",
          "  'createDatabase', rolcreatedb,",
          "  'createRole', rolcreaterole,",
          "  'replication', rolreplication,",
          "  'bypassRls', rolbypassrls) ORDER BY rolname)",
          'FROM pg_roles WHERE rolname IN (' + roleList + ')',
        ].join('\n'),
      ),
    );
    assert.deepEqual(
      roleRows.map((role) => role.name),
      [...ROLE_NAMES].sort(),
    );
    const rolesLeastPrivilege = roleRows.every(
      (role) =>
        role.login === true &&
        role.superuser === false &&
        role.createDatabase === false &&
        role.createRole === false &&
        role.replication === false &&
        role.bypassRls === false,
    );
    assert.equal(rolesLeastPrivilege, true);

    const canI = (verb, resource) => {
      const result = fixture.kubectl(
        [
          'auth',
          'can-i',
          verb,
          resource,
          '-n',
          NAMESPACE,
          '--as=system:serviceaccount:' +
            NAMESPACE +
            ':' +
            DEPLOYMENT,
        ],
        { capture: true, quiet: true, allowFailure: true },
      );
      assert.equal(
        result.status,
        result.stdout === 'yes' ? 0 : 1,
        'unexpected kubectl auth can-i result: ' + result.stdout,
      );
      return result.stdout;
    };
    assert.equal(canI('get', 'secrets'), 'no');
    assert.equal(canI('patch', 'deployments.apps'), 'no');

    const managerServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      SERVICE,
    ]).spec.clusterIP;
    const networkProbe = {
      fixture,
      namespace: NAMESPACE,
      adminImage,
      appName: 'ql3-approval-network-probe',
      networkPolicyLabel: 'qinglong.io/approval-management-client',
    };
    const labelledClientAllowed = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-approval-network-labelled',
      targetHost: managerServiceIp,
      port: 8447,
      labelled: true,
      expectedConnected: true,
    });
    const unlabelledClientDenied = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-approval-network-unlabelled',
      targetHost: managerServiceIp,
      port: 8447,
      labelled: false,
      expectedConnected: false,
    });
    const wrongPortDenied = await clientTcpProbe({
      ...networkProbe,
      name: 'ql3-approval-network-wrong-port',
      targetHost: managerServiceIp,
      port: 8446,
      labelled: true,
      expectedConnected: false,
    });
    const kubernetesServiceIp = fixture.kubectlJson([
      'get',
      'service',
      'kubernetes',
      '-n',
      'default',
    ]).spec.clusterIP;
    const postgresServiceIp = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'service',
      POSTGRES_CLUSTER + '-rw',
    ]).spec.clusterIP;
    const podProbe = {
      fixture,
      namespace: NAMESPACE,
      podName: managerPods[0].metadata.name,
    };
    const cloudNativePgEgressAllowed =
      podTcpProbe({
        ...podProbe,
        host: postgresServiceIp,
        port: 5432,
      }).status === 0;
    const kubernetesApiEgressDenied =
      podTcpProbe({
        ...podProbe,
        host: kubernetesServiceIp,
        port: 443,
      }).status !== 0;
    const publicInternetEgressDenied =
      podTcpProbe({
        ...podProbe,
        host: '1.1.1.1',
        port: 443,
      }).status !== 0;
    assert.equal(cloudNativePgEgressAllowed, true);
    assert.equal(kubernetesApiEgressDenied, true);
    assert.equal(publicInternetEgressDenied, true);

    const finalNodes = fixture.kubectlJson(['get', 'nodes']).items;
    const cniReadyNodes = finalNodes.filter(
      (node) =>
        podReady(node) &&
        Array.isArray(node.spec.podCIDRs) &&
        node.spec.podCIDRs.length === 1,
    );
    assert.equal(cniReadyNodes.length, 3);
    assert.equal(
      new Set(cniReadyNodes.map((node) => node.spec.podCIDRs[0])).size,
      3,
    );
    const serverNode = finalNodes.find(
      (node) => node.metadata.name === fixture.server,
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/backend-type'
      ],
      'vxlan',
    );
    assert.equal(
      serverNode?.metadata.annotations?.[
        'flannel.alpha.coreos.com/kube-subnet-manager'
      ],
      'true',
    );

    const finalCluster = fixture.kubectlJson([
      '-n',
      NAMESPACE,
      'get',
      'cluster',
      POSTGRES_CLUSTER,
    ]);
    assert.equal(Number(finalCluster.status.readyInstances), 3);
    const baselineSuccesses = [
      ...initialRequests,
      overlapOld,
      decided,
      replayed,
    ];
    const report = {
      schemaVersion: 1,
      fixture: FIXTURE,
      observedAt: new Date().toISOString(),
      platform: {
        distribution: 'k3s',
        kubernetesVersion: nodes[0].status.nodeInfo.kubeletVersion,
        architecture,
        kubernetesImageId: imageIdDigest(k3sImageInfo),
        managementImageId: imageIdDigest(adminImageInfo),
        cniName: 'flannel',
        cniDistributionBinding: fixture.k3sImage,
        controlPlaneNodes: 1,
        workerNodes: 2,
        cniReadyNodes: cniReadyNodes.length,
      },
      database: {
        operator: 'cloudnative-pg',
        operatorVersion: OPERATOR_VERSION,
        postgresVersionNumber: durable.postgresVersionNumber,
        postgresImageId: imageIdDigest(postgresImageInfo),
        instances: Number(finalCluster.spec.instances),
        readyInstances: Number(finalCluster.status.readyInstances),
        managerRole: 'ql3_approval_manager',
        migrationCount: durable.migrationCount,
        controlCoreCapability: durable.controlCoreCapability,
        tlsVerified: true,
        primaryChangedDuringFailover:
          promoted.value !== primaryBeforeFailover.metadata.name,
      },
      deployment: {
        namespace: NAMESPACE,
        service: SERVICE,
        port: 8447,
        replicas: deployment.spec.replicas,
        readyReplicas: managerPods.length,
        podIdentitySha256: managerPods.map((pod) =>
          sha256(pod.metadata.uid),
        ),
        nodeIdentitySha256: managerPods.map((pod) =>
          sha256(pod.spec.nodeName),
        ),
        serviceAccount: DEPLOYMENT,
        automountServiceAccountToken: false,
        requiredPodAntiAffinity: true,
        podDisruptionBudgetMinAvailable: 1,
        maxUnavailable: 0,
        maxConnectionsPerPod: 2,
      },
      client: {
        binary: 'ql3-approval-client',
        operations: ['approval.inspect', 'approval.decide'],
        inputKind: 'Secret',
        inputImmutable: true,
        callerDrivenJob: true,
        backoffLimit: 0,
        serviceAccountTokenMounted: false,
        rbacGranted: false,
        transportProtocol: 'TLSv1.3',
        mutualTls: true,
        servernameVerified: true,
        exactPodRequests: baselineSuccesses.length,
        inspectStatuses: [
          initialRequests[0].output.result.status,
          initialRequests[1].output.result.status,
          overlapOld.output.result.status,
        ],
        decisionStatuses: [
          decided.output.result.status,
          replayed.output.result.status,
        ],
        responseRedacted: true,
      },
      identityRotation: {
        overlapOldAssertionAccepted: overlapOld.statusCode === 200,
        overlapNewAssertionAccepted: decided.statusCode === 200,
        revokedOldAssertionRejected: rejectedOldKey.statusCode === 401,
        activeNewAssertionAccepted: replayed.statusCode === 200,
        rollbackSurgeFailedClosed: Boolean(rollback.value),
        twoReadyReplicasPreserved:
          generation2.minimumReady >= 2 &&
          generation3.minimumReady >= 2,
        durableGenerationReachedThree: durable.identityGeneration === 3,
      },
      certificateRotation: {
        previousSerialSha256,
        currentSerialSha256: pki.newSerialSha256(),
        previousBundleSha256,
        currentBundleSha256,
        oldClientAcceptedBefore: initialRequests[0].statusCode === 200,
        replacementClientAcceptedBefore:
          initialRequests[1].statusCode === 200,
        oldClientRejectedAfter: revokedCertificate.statusCode === 401,
        replacementClientAcceptedAfter:
          activeCertificate.statusCode === 200,
        fullPodReplacement: managerPods.every(
          (pod) => !preCertificateUids.has(pod.metadata.uid),
        ),
        allReplicasReadyThroughout:
          certificateRollout.minimumReady >= 2,
      },
      availability: {
        databaseFailureWithdrewReadiness: true,
        databaseFailurePreservedLiveness: true,
        stalePodsDidNotRecoverInPlace: true,
        freshPodsRecoveredAfterDatabase: managerPods.every(
          (pod) => !staleUids.has(pod.metadata.uid),
        ),
        bothReplicasServedAfterRecovery: recoveredRequests.every(
          (entry) => entry.statusCode === 200,
        ),
      },
      isolation: {
        labelledClientAllowed,
        unlabelledClientDenied,
        wrongPortDenied,
        kubernetesApiEgressDenied,
        publicInternetEgressDenied,
        cloudNativePgEgressAllowed,
        managerSecretReadDenied: canI('get', 'secrets') === 'no',
        managerMutationRbacDenied:
          canI('patch', 'deployments.apps') === 'no',
      },
      durability: {
        approvalVersion: durable.approvalVersion,
        approvalState: durable.approvalState,
        decisionIdSha256: sha256(durable.decisionId),
        allowedAuditCount: durable.allowedAuditCount,
        deniedAuditCount: durable.deniedAuditCount,
        duplicateDecisionCount: durable.decisionAuditCount - 1,
        identityGeneration: durable.identityGeneration,
        survivedCloudNativePgFailover: true,
      },
      gates: {
        realThreeNodeKubernetes: nodes.length === 3,
        realCniPolicy:
          labelledClientAllowed &&
          unlabelledClientDenied &&
          wrongPortDenied &&
          kubernetesApiEgressDenied &&
          publicInternetEgressDenied &&
          cloudNativePgEgressAllowed,
        threeInstanceCloudNativePg: databasePods.length === 3,
        twoManagerPodsOnDistinctNodes:
          new Set(managerPods.map((pod) => pod.spec.nodeName)).size === 2,
        tls13ProductClientAcrossBothPods:
          new Set(baselineSuccesses.map((entry) => entry.targetPod)).size >=
          2,
        strongUserDecision:
          weakUserRejected.statusCode === 401 &&
          outsiderDenied.statusCode === 403 &&
          decided.statusCode === 200,
        identityProjectionRotation: durable.identityGeneration === 3,
        certificateRevocationRollout:
          revokedCertificate.statusCode === 401,
        databaseReadinessFence: true,
        durableFactsSurvivedFailover: true,
        leastPrivilege: rolesLeastPrivilege,
        passed: true,
      },
      limitations: [...LIMITATIONS],
    };
    const audit = validateApprovalManagementKubernetesLiveReport(report);
    assert.deepEqual(audit.findings, []);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify({
        schemaVersion: 1,
        fixture: FIXTURE,
        reportWritten: true,
        passed: true,
      }) + '\n',
    );
  } finally {
    await fixture.cleanup();
    if (adminImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', adminImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
    if (controlImageBuilt) {
      run(fixture.docker, ['image', 'rm', '-f', controlImage], {
        capture: true,
        quiet: true,
        allowFailure: true,
      });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      'QL3 approval management Kubernetes live contract failed: ' +
        (error instanceof Error ? error.stack || error.message : String(error)) +
        '\n',
    );
    process.exitCode = 1;
  });
}

module.exports = {
  assertion,
  decisionCommand,
  inspectCommand,
  keyset,
  reviewedKey,
  assertionForSubject,
  weakAssertion,
};
