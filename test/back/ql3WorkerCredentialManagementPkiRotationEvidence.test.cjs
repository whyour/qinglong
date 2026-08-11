const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  CRL_ANNOTATION,
  REVIEWED_AUTHORITY,
  WorkerCredentialManagementPkiRotationEvidenceError,
  inspectClientConfiguration,
  inspectClientIssuerAuthority,
  parseCrlInspectionOutput,
  parseArguments,
  runAfterEvidence,
  runBeforeEvidence,
  validateBeforeState,
  validateWorkerCredentialManagementPkiRotationEvidence,
} = require('../../scripts/ql3-worker-credential-management-pki-rotation-evidence.cjs');

const NOW_MS = 1_700_000_000_000;
const ISSUER = 'https://identity.production.example.org/';
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

function runOpenSsl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function fixture() {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pki-rotation-test-')),
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
    issuerCaFile: writeFile(directory, 'client-issuer-ca.pem', 'issuer', true),
    beforeCrlFile: writeFile(directory, 'before.crl', 'before-crl', true),
    afterCrlFile: writeFile(directory, 'after.crl', 'after-crl', true),
    ceremonyReportFile,
    durableAuditReportFile: writeFile(
      directory,
      'durable-report.json',
      durableReport(ceremonyBytes, ceremony),
    ),
    beforeFile: path.join(directory, 'before-state.json'),
    outputFile: path.join(directory, 'rotation-evidence.json'),
  };
}

function kubernetesSnapshot(crlSha256, phase, options = {}) {
  const generation = phase === 'before' ? 12 : 13;
  const suffix = phase === 'before' ? 'old' : 'new';
  const podUids = options.reuseOldPod
    ? ['pod-old-a', 'pod-new-b']
    : [`pod-${suffix}-a`, `pod-${suffix}-b`];
  return {
    clusterServerSha256: sha('6'),
    collectorSubjectSha256: sha('7'),
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
        resourceVersion: `resource-${generation}`,
        generation: options.sameGeneration ? 12 : generation,
      },
      spec: {
        replicas: 2,
        strategy: {
          type: 'RollingUpdate',
          rollingUpdate: { maxUnavailable: 0 },
        },
        template: {
          metadata: { annotations: { [CRL_ANNOTATION]: crlSha256 } },
        },
      },
      status: {
        observedGeneration: options.sameGeneration ? 12 : generation,
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
            'pod-template-hash': `template-${suffix}`,
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
  const state = { phase: 'before', calls: [] };
  const beforeCrl = {
    sha256: sha('8'),
    issuerSha256: sha('9'),
    number: '1000',
    lastUpdateMs: NOW_MS - 1_000,
    nextUpdateMs: NOW_MS + 600_000,
  };
  const afterCrl = {
    ...beforeCrl,
    sha256: sha('a'),
    number: options.nonMonotonicCrl ? '1000' : '1001',
    lastUpdateMs: NOW_MS + 1,
  };
  return {
    state,
    dependencies: {
      useDefaults: false,
      now: () => NOW_MS,
      normalize(command) {
        return command;
      },
      inspectClient(configFile) {
        const client = path.basename(configFile).startsWith('old')
          ? 'old'
          : 'new';
        return {
          endpointSha256: sha('b'),
          servernameSha256: sha('c'),
          serverTrustBundleSha256: sha('d'),
          serverAuthoritySha256: [sha('e')],
          clientCertificateSha256: client === 'old' ? sha('f') : sha('0'),
          certificate: {
            checkIssued(certificate) {
              return certificate.id === 'client-issuer';
            },
            verify(publicKey) {
              return publicKey.id === 'client-issuer';
            },
          },
        };
      },
      inspectIssuer() {
        const id = options.wrongIssuer ? 'wrong-issuer' : 'client-issuer';
        return {
          bundleSha256: sha('1'),
          certificateSha256: sha('2'),
          subjectSha256: sha('9'),
          certificate: { id, publicKey: { id } },
        };
      },
      inspectAuthoritySubject() {
        throw new Error('unused in injected inspectors');
      },
      inspectCrl(bytes) {
        return bytes.toString() === 'before-crl' ? beforeCrl : afterCrl;
      },
      async collectKubernetes(_file, crlSha256) {
        return kubernetesSnapshot(crlSha256, state.phase, options);
      },
      async execute(paths) {
        const client = path.basename(paths.configFile).startsWith('old')
          ? 'old'
          : 'new';
        state.calls.push(`${state.phase}:${client}`);
        if (state.phase === 'after' && client === 'old') {
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

function beforeOptions(paths) {
  return {
    oldConfigFile: paths.oldConfigFile,
    newConfigFile: paths.newConfigFile,
    assertionFile: paths.assertionFile,
    commandFile: paths.commandFile,
    kubernetesFile: paths.kubernetesFile,
    issuerCaFile: paths.issuerCaFile,
    crlFile: paths.beforeCrlFile,
    outputFile: paths.beforeFile,
  };
}

function afterOptions(paths) {
  return {
    beforeFile: paths.beforeFile,
    oldConfigFile: paths.oldConfigFile,
    newConfigFile: paths.newConfigFile,
    assertionFile: paths.assertionFile,
    commandFile: paths.commandFile,
    kubernetesFile: paths.kubernetesFile,
    issuerCaFile: paths.issuerCaFile,
    crlFile: paths.afterCrlFile,
    ceremonyReportFile: paths.ceremonyReportFile,
    durableAuditReportFile: paths.durableAuditReportFile,
    outputFile: paths.outputFile,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('proves a complete CRL-bound rollout and revoked certificate rejection', async () => {
  const paths = fixture();
  const runtime = harness();
  const before = await runBeforeEvidence(
    beforeOptions(paths),
    runtime.dependencies,
  );
  assert.equal(validateBeforeState(before).compatible, true);
  runtime.state.phase = 'after';
  const report = await runAfterEvidence(
    afterOptions(paths),
    runtime.dependencies,
  );

  assert.deepEqual(runtime.state.calls, [
    'before:old',
    'before:new',
    'after:old',
    'after:new',
  ]);
  assert.equal(report.transport.afterOldStatus, 401);
  assert.equal(report.transport.afterNewStatus, 200);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.transport.serverTrustBundleSha256, sha('d'));
  assert.equal(report.pki.clientIssuerCaSha256, sha('2'));
  assert.notEqual(
    report.transport.serverAuthoritySha256[0],
    report.pki.clientIssuerCaSha256,
  );
  assert.equal(report.kubernetes.oldPodsFullyReplaced, true);
  assert.equal(
    validateWorkerCredentialManagementPkiRotationEvidence(report).compatible,
    true,
  );
  assert.equal(fs.statSync(paths.beforeFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.outputFile).mode & 0o777, 0o600);
  assert.doesNotMatch(
    JSON.stringify(report),
    /operator-a|reviewer-b|deployment-a|pod-old|pod-new|node-|BEGIN|eyJ/,
  );

  const audit = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-worker-credential-management-pki-rotation-evidence-audit.cjs',
      ),
      `--report=${paths.outputFile}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).compatible, true);
});

test('fails closed when the CRL number does not increase', async () => {
  const paths = fixture();
  const runtime = harness({ nonMonotonicCrl: true });
  await runBeforeEvidence(beforeOptions(paths), runtime.dependencies);
  runtime.state.phase = 'after';
  await assert.rejects(
    runAfterEvidence(afterOptions(paths), runtime.dependencies),
    /CRL did not advance monotonically/,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
  assert.deepEqual(runtime.state.calls, ['before:old', 'before:new']);
});

test('fails closed when client certificates are not issued by the explicit client CA', async () => {
  const paths = fixture();
  const runtime = harness({ wrongIssuer: true });
  await assert.rejects(
    runBeforeEvidence(beforeOptions(paths), runtime.dependencies),
    /not bound to one explicit issuer CA/,
  );
  assert.deepEqual(runtime.state.calls, []);
  assert.equal(fs.existsSync(paths.beforeFile), false);
});

test('keeps management server trust independent from the client certificate issuer', () => {
  const paths = fixture();
  const serverKey = path.join(paths.directory, 'server-ca.key');
  const serverCa = path.join(paths.directory, 'server-ca.pem');
  const issuerKey = path.join(paths.directory, 'client-ca.key');
  const issuerCa = path.join(paths.directory, 'real-client-ca.pem');
  const clientKey = path.join(paths.directory, 'client.key');
  const clientCsr = path.join(paths.directory, 'client.csr');
  const clientCertificate = path.join(paths.directory, 'client.pem');
  const extension = writeFile(
    paths.directory,
    'client.ext',
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n',
    true,
  );
  for (const [key, certificate, subject] of [
    [serverKey, serverCa, '/CN=QL3 Management Server Trust'],
    [issuerKey, issuerCa, '/CN=QL3 Management Client Issuer'],
  ]) {
    runOpenSsl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-subj',
      subject,
      '-days',
      '2',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
  }
  runOpenSsl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    clientKey,
    '-out',
    clientCsr,
    '-subj',
    '/CN=QL3 Management Client',
  ]);
  runOpenSsl([
    'x509',
    '-req',
    '-in',
    clientCsr,
    '-CA',
    issuerCa,
    '-CAkey',
    issuerKey,
    '-CAcreateserial',
    '-out',
    clientCertificate,
    '-days',
    '1',
    '-extfile',
    extension,
  ]);
  for (const filePath of [serverKey, issuerKey, clientKey]) {
    fs.chmodSync(filePath, 0o600);
  }
  const configFile = writeFile(paths.directory, 'real-client.json', {
    schemaVersion: 1,
    endpoint:
      'https://worker-management.production.example.org/api/v3/worker-credentials/management',
    servername: 'worker-management.production.example.org',
    caFile: serverCa,
    clientCertificateFile: clientCertificate,
    clientPrivateKeyFile: clientKey,
    requestTimeoutMs: 5_000,
  });

  const profile = inspectClientConfiguration(configFile, Date.now());
  const issuer = inspectClientIssuerAuthority(issuerCa, Date.now());
  assert.notEqual(
    profile.serverAuthoritySha256[0],
    issuer.certificateSha256,
  );
  assert.equal(profile.certificate.checkIssued(issuer.certificate), true);
  assert.equal(profile.certificate.verify(issuer.certificate.publicKey), true);
});

test('fails closed for incomplete pod replacement or an unchanged generation', async () => {
  for (const changed of [{ reuseOldPod: true }, { sameGeneration: true }]) {
    const paths = fixture();
    const runtime = harness(changed);
    await runBeforeEvidence(beforeOptions(paths), runtime.dependencies);
    runtime.state.phase = 'after';
    await assert.rejects(
      runAfterEvidence(afterOptions(paths), runtime.dependencies),
      /complete old generation/,
    );
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('rejects any widened Kubernetes evidence authority before client access', async () => {
  const paths = fixture();
  const runtime = harness({ allowSecretRead: true });
  await assert.rejects(
    runBeforeEvidence(beforeOptions(paths), runtime.dependencies),
    /authority is not exact read-only/,
  );
  assert.deepEqual(runtime.state.calls, []);
  assert.equal(fs.existsSync(paths.beforeFile), false);
});

test('offline audit rejects false gates, widened shape and sensitive material', async () => {
  const paths = fixture();
  const runtime = harness();
  await runBeforeEvidence(beforeOptions(paths), runtime.dependencies);
  runtime.state.phase = 'after';
  const report = await runAfterEvidence(
    afterOptions(paths),
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
      validateWorkerCredentialManagementPkiRotationEvidence(changed).compatible,
      false,
    );
  }
});

test('parses only the exact before and after CLI argument sets', () => {
  const common = [
    '--old-config=/private/old.json',
    '--new-config=/private/new.json',
    '--assertion=/private/assertion.jwt',
    '--command=/private/command.json',
    '--kubernetes=/private/kubernetes.json',
    '--client-issuer-ca=/private/client-issuer-ca.pem',
    '--crl=/private/client.crl',
    '--output=/private/evidence.json',
  ];
  assert.equal(parseArguments(['--phase=before', ...common]).phase, 'before');
  assert.equal(
    parseArguments([
      '--phase=after',
      ...common,
      '--before=/private/before.json',
      '--ceremony-report=/private/ceremony.json',
      '--durable-audit-report=/private/durable.json',
    ]).phase,
    'after',
  );
  assert.throws(
    () => parseArguments(['--phase=before', ...common, '--extra=true']),
    WorkerCredentialManagementPkiRotationEvidenceError,
  );
});

test('parses the exact OpenSSL 3 SHA-256 CRL inspection labels', () => {
  const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':');
  const inspected = parseCrlInspectionOutput(
    [
      `SHA256 Fingerprint=${fingerprint}`,
      'issuer=CN=QingLong Worker Management Client CA',
      'lastUpdate=Aug  1 00:00:00 2026 GMT',
      'nextUpdate=Aug 31 00:00:00 2026 GMT',
      'crlNumber=0x1001',
    ].join('\n'),
  );
  assert.equal(inspected.sha256, `sha256:${'ab'.repeat(32)}`);
  assert.equal(inspected.number, '1001');
  assert.equal(inspected.lastUpdateMs, Date.UTC(2026, 7, 1));
  assert.equal(inspected.nextUpdateMs, Date.UTC(2026, 7, 31));
  assert.throws(
    () =>
      parseCrlInspectionOutput(
        `SHA-256 Fingerprint=${fingerprint}\nissuer=CN=CA\nlastUpdate=Aug  1 00:00:00 2026 GMT\nnextUpdate=Aug 31 00:00:00 2026 GMT\ncrlNumber=0x1001`,
      ),
    WorkerCredentialManagementPkiRotationEvidenceError,
  );
});
