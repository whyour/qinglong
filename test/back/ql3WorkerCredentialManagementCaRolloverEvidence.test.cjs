const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  CA_ANNOTATION,
  CRL_ANNOTATION,
  WorkerCredentialManagementCaRolloverEvidenceError,
  parseArguments,
  runNewEvidence,
  runOldEvidence,
  runOverlapEvidence,
  validateStageState,
  validateWorkerCredentialManagementCaRolloverEvidence,
} = require('../../scripts/ql3-worker-credential-management-ca-rollover-evidence.cjs');
const {
  REVIEWED_AUTHORITY,
} = require('../../scripts/ql3-worker-credential-management-pki-rotation-evidence.cjs');

const NOW_MS = 1_700_000_000_000;
const ISSUER = 'https://identity.production.example.org/';
const OLD_CA = sha('a');
const NEW_CA = sha('b');
const temporaryDirectories = [];

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function digest(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(domain)
    .update('\0')
    .update(String(value))
    .digest('hex')}`;
}

function rawDigest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function assertionToken(subject = 'operator-a') {
  const now = Math.floor(NOW_MS / 1000);
  return `${encode({
    alg: 'EdDSA',
    kid: `key-${subject}`,
    typ: 'ql3-worker-credential-management+jwt',
  })}.${encode({
    acr: 'urn:production:mfa',
    amr: ['pwd', 'otp'],
    aud: 'qinglong3-worker-credential-management',
    auth_time: now - 20,
    exp: now + 120,
    iat: now - 10,
    iss: ISSUER,
    jti: `session-${subject}`,
    ql3_purpose: 'worker-credential-management',
    sub: subject,
  })}.${Buffer.alloc(64, 7).toString('base64url')}`;
}

function ceremonyReport() {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-live-ceremony@v1',
    observedAt: new Date(NOW_MS).toISOString(),
    identity: {
      providerKind: 'external_oidc',
      issuer: ISSUER,
      discoveryDocumentSha256: sha('c'),
      jwksSha256: sha('d'),
      audience: 'qinglong3-worker-credential-management',
      type: 'ql3-worker-credential-management+jwt',
      purpose: 'worker-credential-management',
      requesterSubjectSha256: digest(
        'qinglong3.worker-management.subject.v1',
        'operator-a',
      ),
      reviewerSubjectSha256: digest(
        'qinglong3.worker-management.subject.v1',
        'reviewer-b',
      ),
      requesterKeyIdSha256: sha('1'),
      reviewerKeyIdSha256: sha('2'),
    },
    ceremony: {
      actionRefSha256: sha('3'),
      authorityProjectIdSha256: sha('4'),
      planStatus: 'created',
      approvalStatus: 'created',
      requesterSelfDecisionStatus: 403,
      requesterSelfDecisionCode: 'forbidden',
      reviewerDecisionStatus: 'decided',
      approvalState: 'approved',
      inspectionStale: false,
      dispatchCreated: false,
      approvalConsumed: false,
      planDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
      requestIdSha256: ['5', '6', '7', '8', '9'].map(sha),
    },
    gates: {
      externalIdentity: true,
      workerPurposeBound: true,
      requesterAndReviewerDistinct: true,
      requesterSelfDecisionRejected: true,
      reviewerDecisionAccepted: true,
      inspectionAuthorized: true,
      noExecutionOrConsumption: true,
      passed: true,
    },
  };
}

function durableReport(ceremonyBytes, ceremony) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-durable-audit-evidence@v1',
    observedAt: new Date(NOW_MS + 30).toISOString(),
    source: {
      ceremonyReportSha256: rawDigest(ceremonyBytes),
      ceremonyDefinitionSha256: sha('e'),
      ceremonyFixture: ceremony.fixture,
    },
    database: {
      postgresVersionNumber: 180004,
      transactionReadOnly: true,
      roleNameSha256: sha('f'),
      roleCanLogin: true,
      privilegedAttributesDenied: true,
      privilegedMembershipDenied: true,
      exactTargetSelect: true,
      ql3TableMutationDenied: true,
    },
    durableState: {
      actionRefSha256: ceremony.ceremony.actionRefSha256,
      authorityProjectIdSha256: ceremony.ceremony.authorityProjectIdSha256,
      approvalRequestIdSha256: sha('0'),
      reviewerDecisionIdSha256: sha('1'),
      planDigest: ceremony.ceremony.planDigest,
      previewDigest: ceremony.ceremony.previewDigest,
      approvalVersion: 2,
      approvalState: 'approved',
      requesterSubjectSha256: ceremony.identity.requesterSubjectSha256,
      reviewerSubjectSha256: ceremony.identity.reviewerSubjectSha256,
      dispatchCreated: false,
      approvalConsumed: false,
      requesterSelfDecisionAuditAbsent: true,
      auditRows: [
        {
          kind: 'proposal',
          eventIdSha256: sha('2'),
          operationId: 'approval.request',
          outcome: 'approval_required',
          subjectSha256: ceremony.identity.requesterSubjectSha256,
          authenticationIdSha256: sha('3'),
          reasonCode: 'worker_credential_review',
          policyFencePresent: true,
        },
        {
          kind: 'reviewer_decision',
          eventIdSha256: sha('4'),
          operationId: 'approval.decide',
          outcome: 'allowed',
          subjectSha256: ceremony.identity.reviewerSubjectSha256,
          authenticationIdSha256: sha('5'),
          reasonCode: 'worker_credential_review',
          policyFencePresent: true,
        },
      ],
    },
    gates: {
      sourceBound: true,
      readOnlyEvidenceRole: true,
      immutablePlanObserved: true,
      reviewedApprovalObserved: true,
      requesterSelfDecisionLeftNoAudit: true,
      proposalAndDecisionAuditObserved: true,
      noExecutionOrConsumption: true,
      passed: true,
    },
  };
}

function writeFile(directory, name, value, raw = false) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, raw ? value : `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  return filePath;
}

function fixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-ca-rollover-test-')),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const ceremony = ceremonyReport();
  const ceremonyReportFile = writeFile(
    directory,
    'ceremony-report.json',
    ceremony,
  );
  const ceremonyBytes = fs.readFileSync(ceremonyReportFile);
  return {
    directory,
    oldConfigFile: writeFile(directory, 'old-client.json', {}),
    newConfigFile: writeFile(directory, 'new-client.json', {}),
    assertionFile: writeFile(directory, 'operator.jwt', assertionToken(), true),
    commandFile: writeFile(directory, 'inspect-command.json', {
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
    }),
    kubernetesFile: writeFile(directory, 'kubeconfig.json', {}),
    caBundleFile: writeFile(directory, 'client-ca.pem', 'ca', true),
    crlBundleFile: writeFile(directory, 'client-crl.pem', 'crl', true),
    ceremonyReportFile,
    durableAuditReportFile: writeFile(
      directory,
      'durable-report.json',
      durableReport(ceremonyBytes, ceremony),
    ),
    oldFile: path.join(directory, 'old-state.json'),
    overlapFile: path.join(directory, 'overlap-state.json'),
    outputFile: path.join(directory, 'ca-rollover-evidence.json'),
  };
}

function authority(id, fingerprintSha256) {
  return {
    fingerprintSha256,
    subject: `CN=${id}-client-ca`,
    certificate: { id, publicKey: { id } },
  };
}

function clientProfile(id) {
  return {
    endpointSha256: sha('2'),
    servernameSha256: sha('3'),
    serverTrustBundleSha256: sha('4'),
    serverAuthoritySha256: [sha('5')],
    clientCertificateSha256: id === 'old' ? sha('6') : sha('7'),
    certificate: {
      checkIssued(certificate) {
        return certificate.id === id;
      },
      verify(publicKey) {
        return publicKey.id === id;
      },
    },
  };
}

function phaseTrust(phase, options) {
  const ids =
    phase === 'old'
      ? ['old']
      : phase === 'new'
        ? ['new']
        : options.missingOldOverlap
          ? ['new']
          : ['old', 'new'];
  const authorities = ids.map((id) =>
    authority(id, id === 'old' ? OLD_CA : NEW_CA),
  );
  const caFingerprintSha256 = authorities
    .map(({ fingerprintSha256 }) => fingerprintSha256)
    .sort();
  return {
    caBundleSha256:
      phase === 'old' ? sha('8') : phase === 'overlap' ? sha('9') : sha('c'),
    crlBundleSha256:
      phase === 'old' ? sha('d') : phase === 'overlap' ? sha('e') : sha('f'),
    authorities,
    caFingerprintSha256,
    crlIssuerSha256: ids
      .map((id) => (id === 'old' ? sha('1') : sha('2')))
      .sort(),
  };
}

function kubernetesSnapshot(trust, phase, options = {}) {
  const generations = { old: 20, overlap: 21, new: 22 };
  const generation =
    options.sameGeneration && phase === 'overlap'
      ? generations.old
      : generations[phase];
  const previous = phase === 'new' ? 'overlap' : 'old';
  const podUids = options.reusePreviousPod && phase !== 'old'
    ? [`pod-${previous}-a`, `pod-${phase}-b`]
    : [`pod-${phase}-a`, `pod-${phase}-b`];
  return {
    clusterServerSha256: sha('3'),
    collectorSubjectSha256: sha('4'),
    authorization: REVIEWED_AUTHORITY.map((entry) => ({
      ...entry,
      observed:
        options.allowSecretRead &&
        entry.verb === 'get' &&
        entry.resource === 'secrets'
          ? true
          : entry.allowed,
    })),
    deployment: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'ql3-worker-credential-management',
        namespace: 'qinglong3-system',
        uid: 'deployment-a',
        resourceVersion: `resource-${phase}`,
        generation,
      },
      spec: {
        replicas: 2,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0 },
        },
        template: {
          metadata: {
            annotations: {
              [CA_ANNOTATION]: trust.caBundleSha256,
              [CRL_ANNOTATION]: trust.crlBundleSha256,
            },
          },
        },
      },
      status: {
        observedGeneration: generation,
        replicas: 2,
        updatedReplicas: 2,
        readyReplicas: 2,
        availableReplicas: 2,
      },
    },
    pods: {
      apiVersion: 'v1',
      kind: 'List',
      items: podUids.map((uid, index) => ({
        metadata: {
          namespace: 'qinglong3-system',
          uid,
          labels: {
            'app.kubernetes.io/name': 'ql3-worker-credential-management',
            'app.kubernetes.io/component': 'worker-credential-management',
            'pod-template-hash': `template-${phase}`,
          },
        },
        spec: {
          serviceAccountName: 'ql3-worker-credential-management',
          automountServiceAccountToken: false,
          nodeName: `node-${index + 1}`,
        },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'management', ready: true }],
        },
      })),
    },
  };
}

function harness(options = {}) {
  const state = { phase: 'old', calls: [] };
  return {
    state,
    dependencies: {
      useDefaults: false,
      now: () => NOW_MS,
      normalize(command) {
        return command;
      },
      inspectClient(configFile) {
        return clientProfile(
          path.basename(configFile).startsWith('old') ? 'old' : 'new',
        );
      },
      inspectTrust() {
        return phaseTrust(state.phase, options);
      },
      inspectAuthoritySubject() {
        throw new Error('unused in injected trust inspector');
      },
      inspectCrl() {
        throw new Error('unused in injected trust inspector');
      },
      async collectKubernetes() {
        return kubernetesSnapshot(
          phaseTrust(state.phase, options),
          state.phase,
          options,
        );
      },
      async execute(paths) {
        const client = path.basename(paths.configFile).startsWith('old')
          ? 'old'
          : 'new';
        state.calls.push(`${state.phase}:${client}`);
        const rejected =
          (state.phase === 'old' && client === 'new') ||
          (state.phase === 'new' && client === 'old');
        if (rejected) {
          throw Object.assign(new Error('rejected'), {
            statusCode: 401,
            responseCode: 'client_certificate_required',
          });
        }
        return { requestId: `request-${state.phase}-${client}` };
      },
    },
  };
}

function commonOptions(paths, outputFile) {
  return {
    oldConfigFile: paths.oldConfigFile,
    newConfigFile: paths.newConfigFile,
    assertionFile: paths.assertionFile,
    commandFile: paths.commandFile,
    kubernetesFile: paths.kubernetesFile,
    caBundleFile: paths.caBundleFile,
    crlBundleFile: paths.crlBundleFile,
    outputFile,
  };
}

function oldOptions(paths) {
  return commonOptions(paths, paths.oldFile);
}

function overlapOptions(paths) {
  return {
    previousFile: paths.oldFile,
    ...commonOptions(paths, paths.overlapFile),
  };
}

function newOptions(paths) {
  return {
    oldFile: paths.oldFile,
    previousFile: paths.overlapFile,
    ...commonOptions(paths, paths.outputFile),
    ceremonyReportFile: paths.ceremonyReportFile,
    durableAuditReportFile: paths.durableAuditReportFile,
  };
}

async function collectOldAndOverlap(paths, runtime) {
  const old = await runOldEvidence(oldOptions(paths), runtime.dependencies);
  runtime.state.phase = 'overlap';
  const overlap = await runOverlapEvidence(
    overlapOptions(paths),
    runtime.dependencies,
  );
  return { old, overlap };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('proves exact three-phase client CA rollover and full pod replacement', async () => {
  const paths = fixture();
  const runtime = harness();
  const { old, overlap } = await collectOldAndOverlap(paths, runtime);
  assert.equal(validateStageState(old).compatible, true);
  assert.equal(validateStageState(overlap).compatible, true);
  runtime.state.phase = 'new';
  const report = await runNewEvidence(
    newOptions(paths),
    runtime.dependencies,
  );

  assert.deepEqual(runtime.state.calls, [
    'old:old',
    'old:new',
    'overlap:old',
    'overlap:new',
    'new:old',
    'new:new',
  ]);
  assert.deepEqual(report.trustTransition.oldSet, [OLD_CA]);
  assert.deepEqual(report.trustTransition.overlapSet, [OLD_CA, NEW_CA]);
  assert.deepEqual(report.trustTransition.newSet, [NEW_CA]);
  assert.deepEqual(report.access.oldCertificateStatus, [200, 200, 401]);
  assert.deepEqual(report.access.newCertificateStatus, [401, 200, 200]);
  assert.equal(
    validateWorkerCredentialManagementCaRolloverEvidence(report).compatible,
    true,
  );
  assert.equal(fs.statSync(paths.oldFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.overlapFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.outputFile).mode & 0o777, 0o600);
  assert.doesNotMatch(
    JSON.stringify(report),
    /operator-a|reviewer-b|deployment-a|pod-|node-|BEGIN|eyJ/,
  );

  const audit = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-worker-credential-management-ca-rollover-evidence-audit.cjs',
      ),
      `--report=${paths.outputFile}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).compatible, true);
});

test('fails closed when overlap omits the old authority', async () => {
  const paths = fixture();
  const runtime = harness({ missingOldOverlap: true });
  await runOldEvidence(oldOptions(paths), runtime.dependencies);
  runtime.state.phase = 'overlap';
  await assert.rejects(
    runOverlapEvidence(overlapOptions(paths), runtime.dependencies),
    /exact old plus new union/,
  );
  assert.equal(fs.existsSync(paths.overlapFile), false);
  assert.deepEqual(runtime.state.calls, ['old:old', 'old:new']);
});

test('fails closed for unchanged generation or reused pod identity', async () => {
  for (const change of [
    { sameGeneration: true },
    { reusePreviousPod: true },
  ]) {
    const paths = fixture();
    const runtime = harness(change);
    await runOldEvidence(oldOptions(paths), runtime.dependencies);
    runtime.state.phase = 'overlap';
    await assert.rejects(
      runOverlapEvidence(overlapOptions(paths), runtime.dependencies),
      /complete previous generation/,
    );
    assert.equal(fs.existsSync(paths.overlapFile), false);
  }
});

test('rejects widened Kubernetes collector authority before client access', async () => {
  const paths = fixture();
  const runtime = harness({ allowSecretRead: true });
  await assert.rejects(
    runOldEvidence(oldOptions(paths), runtime.dependencies),
    /authority is not exact read-only/,
  );
  assert.deepEqual(runtime.state.calls, []);
  assert.equal(fs.existsSync(paths.oldFile), false);
});

test('rejects identity drift from the reviewed ceremony', async () => {
  const paths = fixture();
  const runtime = harness();
  await collectOldAndOverlap(paths, runtime);
  fs.writeFileSync(paths.assertionFile, assertionToken('operator-c'), {
    mode: 0o600,
  });
  runtime.state.phase = 'new';
  await assert.rejects(
    runNewEvidence(newOptions(paths), runtime.dependencies),
    /authority does not match|not bound to the reviewed ceremony/,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
});

test('offline audit rejects false gates, widened shape and sensitive material', async () => {
  const paths = fixture();
  const runtime = harness();
  await collectOldAndOverlap(paths, runtime);
  runtime.state.phase = 'new';
  const report = await runNewEvidence(
    newOptions(paths),
    runtime.dependencies,
  );
  for (const changed of [
    { ...structuredClone(report), extra: true },
    {
      ...structuredClone(report),
      gates: { ...report.gates, passed: false },
    },
    { ...structuredClone(report), privateKey: 'not-exportable' },
  ]) {
    assert.equal(
      validateWorkerCredentialManagementCaRolloverEvidence(changed).compatible,
      false,
    );
  }
});

test('offline validators deterministically reject missing or malformed sections', () => {
  for (const changed of [null, {}, { trustTransition: {} }]) {
    assert.doesNotThrow(() =>
      validateWorkerCredentialManagementCaRolloverEvidence(changed),
    );
    assert.equal(
      validateWorkerCredentialManagementCaRolloverEvidence(changed).compatible,
      false,
    );
  }
  for (const changed of [null, {}, { transport: {}, trust: {} }]) {
    assert.doesNotThrow(() => validateStageState(changed));
    assert.equal(validateStageState(changed).compatible, false);
  }
});

test('parses only exact old, overlap and new CLI argument sets', () => {
  const common = [
    '--old-config=/private/old.json',
    '--new-config=/private/new.json',
    '--assertion=/private/assertion.jwt',
    '--command=/private/command.json',
    '--kubernetes=/private/kubernetes.json',
    '--client-ca-bundle=/private/client-ca.pem',
    '--client-crl-bundle=/private/client-crl.pem',
    '--output=/private/evidence.json',
  ];
  assert.equal(parseArguments(['--phase=old', ...common]).phase, 'old');
  assert.equal(
    parseArguments([
      '--phase=overlap',
      ...common,
      '--previous=/private/old-state.json',
    ]).phase,
    'overlap',
  );
  assert.equal(
    parseArguments([
      '--phase=new',
      ...common,
      '--old=/private/old-state.json',
      '--previous=/private/overlap-state.json',
      '--ceremony-report=/private/ceremony.json',
      '--durable-audit-report=/private/durable.json',
    ]).phase,
    'new',
  );
  assert.throws(
    () => parseArguments(['--phase=old', ...common, '--extra=true']),
    WorkerCredentialManagementCaRolloverEvidenceError,
  );
});
