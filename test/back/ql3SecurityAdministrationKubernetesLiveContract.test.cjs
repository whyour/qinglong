const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  auditListCommand,
  clusterControlResources,
  credentialAuthenticationProbeSource,
  credentialIssueCommand,
  credentialRevokeCommand,
  credentialRotateCommand,
  custodyEvidenceSource,
  deliveryVolumeProvisionSource,
  identity,
  identityRegisterCommand,
  inputAuthorityEvidenceSource,
  migrationFailureEvidence,
  networkPolicyReadinessSource,
} = require('../../scripts/ql3-security-administration-kubernetes-live-contract.cjs');

const values = Object.freeze({
  subject: Object.freeze({ type: 'api_app', id: 'd406-test-client' }),
  credentialId: 'd406-test-client',
  identityMutationId: '10000000-0000-4000-8000-000000000001',
  issueMutationId: '10000000-0000-4000-8000-000000000002',
  rotateMutationId: '10000000-0000-4000-8000-000000000003',
  revokeMutationId: '10000000-0000-4000-8000-000000000004',
  registerRequestId: 'd406-register-test',
  issueRequestId: 'd406-issue-test',
  rotateRequestId: 'd406-rotate-test',
  revokeRequestId: 'd406-revoke-test',
  notBeforeAtMs: 2_000_000_000_000,
  expiresAtMs: 2_000_003_600_000,
});

test('requires a private report path before any Docker or Kubernetes mutation', () => {
  const script = path.resolve(
    __dirname,
    '../../scripts/ql3-security-administration-kubernetes-live-contract.cjs',
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE: '1',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--report=\/absolute\/private-report\.json/);
  assert.doesNotMatch(result.stderr, /Docker\/Kubernetes/);
});

test('builds the exact register, audit, issue, rotate and revoke commands', () => {
  assert.deepEqual(identityRegisterCommand(values), {
    schemaVersion: 1,
    operation: 'identity.register',
    request: {
      mutationId: values.identityMutationId,
      requestId: values.registerRequestId,
      expectedCurrentVersion: 0,
      subject: values.subject,
    },
  });
  assert.deepEqual(auditListCommand(), {
    schemaVersion: 1,
    operation: 'audit.list',
    request: { limit: 25, filter: { outcome: 'allowed' } },
  });
  assert.equal(credentialIssueCommand(values).request.expectedCurrentVersion, 0);
  assert.equal(credentialRotateCommand(values).request.expectedCurrentVersion, 1);
  assert.equal(credentialRevokeCommand(values).request.expectedCurrentVersion, 2);
  assert.equal('notBeforeAtMs' in credentialRevokeCommand(values).request, false);
});

test('binds the live assertion to the isolated Security Administration purpose', () => {
  const key = identity.reviewedKey('security-administration-unit-key');
  const document = identity.keyset(1, [key]);
  assert.equal(document.audience, 'qinglong3-security-administration');
  const assertion = identity.assertion(key, 'unit-test');
  const header = JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url'));
  const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
  assert.equal(header.typ, 'ql3-security-administration+jwt');
  assert.equal(payload.ql3_purpose, 'security-administration');
  assert.equal(payload.sub, 'security-owner');
  assert.equal(payload.acr, 'urn:ql3:mfa');
  assert.deepEqual(payload.amr, ['pwd', 'otp']);
});

test('keeps the in-Pod custody verifier content-free and fail-closed', () => {
  const source = custodyEvidenceSource();
  assert.match(source, /bytes\.fill\(0\)/);
  assert.match(source, /kubernetesApiConnected/);
  assert.match(source, /publicInternetConnected/);
  assert.match(source, /status\.nlink!==1/);
  assert.doesNotMatch(source, /value\.token[,}]/);
  assert.doesNotMatch(source, /console\.log/);
});

test('inspects projected input authority without reading private material', () => {
  const source = inputAuthorityEvidenceSource();
  assert.match(source, /lstatSync/);
  assert.match(source, /realpathSync/);
  assert.match(source, /confined/);
  assert.doesNotMatch(source, /readFile/);
  assert.doesNotMatch(source, /createReadStream/);
});

test('constrains only the exact local-path fixture root without network authority', () => {
  const source = deliveryVolumeProvisionSource();
  assert.match(source, /before\.mode!==['"]2777['"]/);
  assert.match(source, /chmodSync\(root,0o2770\)/);
  assert.match(source, /after\.mode!==['"]2770['"]/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /net|fetch|http/);
});

test('keeps migration failure evidence content-free', () => {
  const base = {
    complete: false,
    failed: true,
    pod: {
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            name: 'migration',
            state: {
              terminated: {
                exitCode: 1,
                reason: 'Error',
                message: [
                  JSON.stringify({
                    schemaVersion: 1,
                    component: 'qinglong3-cluster-migration',
                    event: 'migration_started',
                    migrationCount: 0,
                  }),
                  JSON.stringify({
                    schemaVersion: 1,
                    component: 'qinglong3-cluster-migration',
                    event: 'migration_failed',
                    name: 'Error',
                    code: 'EAI_AGAIN',
                  }),
                ].join('\n'),
              },
            },
          },
        ],
      },
    },
  };
  assert.deepEqual(migrationFailureEvidence(base), {
    jobComplete: false,
    jobFailed: true,
    podPhase: 'Failed',
    exitCode: 1,
    reason: 'Error',
    failureMessage: {
      schemaVersion: 1,
      component: 'qinglong3-cluster-migration',
      event: 'migration_failed',
      name: 'Error',
      code: 'EAI_AGAIN',
    },
  });
  const rejected = structuredClone(base);
  rejected.pod.status.containerStatuses[0].state.terminated.message =
    JSON.stringify({ code: 'EAI_AGAIN', secret: 'must-not-escape' });
  assert.equal(
    migrationFailureEvidence(rejected).failureMessage,
    'rejected',
  );
});

test('waits for per-Pod network policy before mounting private material', () => {
  const source = networkPolicyReadinessSource();
  assert.match(source, /NETWORK_POLICY_NOT_ENFORCED/);
  assert.match(source, /databaseConnected/);
  assert.match(source, /kubernetesApiConnected/);
  assert.match(source, /publicInternetConnected/);
  assert.match(source, /attempt<=120/);
  assert.match(source, /consecutive>=2/);
  assert.ok(
    source.indexOf('kubernetesApiConnected=await connect') <
      source.indexOf('databaseConnected=await connect'),
  );
  assert.doesNotMatch(source, /readFile|process\.env|console\.log/);
});

test('runs the credential ceremony against two real anti-affine control replicas', () => {
  const [service, deployment] = clusterControlResources(
    'qinglong3-cluster-control:test',
  );
  assert.equal(service.kind, 'Service');
  assert.equal(service.spec.ports[0].port, 5800);
  assert.equal(deployment.kind, 'Deployment');
  assert.equal(deployment.spec.replicas, 2);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
  assert.equal(
    deployment.spec.template.spec.affinity.podAntiAffinity
      .requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey,
    'kubernetes.io/hostname',
  );
  const environment = deployment.spec.template.spec.containers[0].env;
  assert.ok(
    environment.some(
      (entry) =>
        entry.name === 'QL3_API_CREDENTIAL_PEPPER_KEYRING_FILE' &&
        entry.value.endsWith('/keyring.json'),
    ),
  );
  assert.equal(
    environment.some((entry) => entry.name === 'QL3_API_CREDENTIAL_PEPPER'),
    false,
  );
});

test('keeps the real authentication probe content-free', () => {
  const source = credentialAuthenticationProbeSource();
  assert.match(source, /ql3-security-live-control/);
  assert.match(source, /\/api\/v3\/projects\/prj_default\/runs\?limit=1/);
  assert.match(source, /observedStatus:observed/);
  assert.match(source, /bytes\?\.fill\(0\)/);
  assert.doesNotMatch(source, /console\.log|process\.env/);
});

test('live runner remains opt-in, reviewed, cleanup-bound and log-free', () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../scripts/ql3-security-administration-kubernetes-live-contract.cjs',
    ),
    'utf8',
  );
  assert.match(
    source,
    /QL3_SECURITY_ADMINISTRATION_KUBERNETES_LIVE !== '1'/,
  );
  assert.match(source, /reviewedOperatorManifest\(operatorManifestFile\)/);
  assert.match(source, /validateSecurityAdministrationKubernetesLiveReport/);
  assert.match(source, /net\.ipv4\.ip_forward=1/);
  assert.match(source, /net\.bridge\.bridge-nf-call-iptables=1/);
  assert.match(source, /wait-network-policy/);
  assert.match(source, /projectedMode: 0o444/);
  assert.match(source, /credential\.issue\.old\.replay/);
  assert.match(source, /ql3-security-live-auth-old-before-activate/);
  assert.match(source, /ql3-security-live-auth-old-overlap/);
  assert.match(source, /ql3-security-live-auth-new-overlap/);
  assert.match(source, /ql3-security-live-auth-old-contracted/);
  assert.match(source, /ql3-security-live-auth-new-contracted/);
  assert.match(source, /expectedStatus: 401/);
  assert.match(source, /expectedStatus: 403/);
  assert.match(source, /controlRollouts: 3/);
  assert.match(source, /FallbackToLogsOnError/);
  assert.match(source, /failureMessage: 'rejected'/);
  assert.match(
    source,
    /deploy\/kubernetes\/ql3-cluster\/base\/service-account\.yaml/,
  );
  assert.match(source, /persistentvolumeclaim\/\$\{DELIVERY_CLAIM\}/);
  assert.match(source, /await fixture\.cleanup\(\)/);
  assert.doesNotMatch(source, /kubectl\([^)]*logs/);
});
