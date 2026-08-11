const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  WorkerCredentialManagementReleaseEvidenceError,
  auditWorkerCredentialManagementReleaseEvidence,
  clearSourceDocuments,
  parseArguments,
  readSourceDocuments,
  runWorkerCredentialManagementReleaseEvidence,
  validateWorkerCredentialManagementReleaseEvidence,
} = require('../../scripts/ql3-worker-credential-management-release-evidence.cjs');
const {
  MAX_EVIDENCE_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  WorkerCredentialManagementReleaseGateError,
  auditWorkerCredentialManagementReleaseGate,
  parseArguments: parseGateArguments,
} = require('../../scripts/ql3-worker-credential-management-release-gate.cjs');

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

function ceremonyReport() {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-live-ceremony@v1',
    observedAt: new Date(NOW_MS).toISOString(),
    identity: {
      providerKind: 'external_oidc',
      issuer: ISSUER,
      discoveryDocumentSha256: sha('a'),
      jwksSha256: sha('b'),
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
      requesterKeyIdSha256: sha('c'),
      reviewerKeyIdSha256: sha('d'),
    },
    ceremony: {
      actionRefSha256: sha('e'),
      authorityProjectIdSha256: sha('f'),
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
      requestIdSha256: ['0', '1', '2', '3', '4'].map(sha),
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
    observedAt: new Date(NOW_MS + 100).toISOString(),
    source: {
      ceremonyReportSha256: rawDigest(ceremonyBytes),
      ceremonyDefinitionSha256: sha('5'),
      ceremonyFixture: ceremony.fixture,
    },
    database: {
      postgresVersionNumber: 180004,
      transactionReadOnly: true,
      roleNameSha256: sha('6'),
      roleCanLogin: true,
      privilegedAttributesDenied: true,
      privilegedMembershipDenied: true,
      exactTargetSelect: true,
      ql3TableMutationDenied: true,
    },
    durableState: {
      actionRefSha256: ceremony.ceremony.actionRefSha256,
      authorityProjectIdSha256: ceremony.ceremony.authorityProjectIdSha256,
      approvalRequestIdSha256: sha('7'),
      reviewerDecisionIdSha256: sha('8'),
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
          eventIdSha256: sha('9'),
          operationId: 'approval.request',
          outcome: 'approval_required',
          subjectSha256: ceremony.identity.requesterSubjectSha256,
          authenticationIdSha256: sha('a'),
          reasonCode: 'worker_credential_review',
          policyFencePresent: true,
        },
        {
          kind: 'reviewer_decision',
          eventIdSha256: sha('b'),
          operationId: 'approval.decide',
          outcome: 'allowed',
          subjectSha256: ceremony.identity.reviewerSubjectSha256,
          authenticationIdSha256: sha('c'),
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

function commonIdentity(ceremony) {
  return {
    providerKind: 'external_oidc',
    issuer: ceremony.identity.issuer,
    audience: ceremony.identity.audience,
    type: ceremony.identity.type,
    purpose: ceremony.identity.purpose,
    subjectSha256: ceremony.identity.requesterSubjectSha256,
    ceremonyIdentityBound: true,
    durableAuditBound: true,
  };
}

function pkiReport(ceremonyBytes, durableBytes, ceremony) {
  return {
    schemaVersion: 2,
    fixture: 'qinglong/worker-credential-management-pki-rotation-evidence@v2',
    observedAt: new Date(NOW_MS + 200).toISOString(),
    source: {
      beforeStateSha256: sha('d'),
      ceremonyReportSha256: rawDigest(ceremonyBytes),
      durableAuditReportSha256: rawDigest(durableBytes),
      ceremonyFixture: ceremony.fixture,
      durableAuditFixture:
        'qinglong/worker-credential-management-durable-audit-evidence@v1',
    },
    identity: commonIdentity(ceremony),
    transport: {
      endpointSha256: sha('e'),
      servernameSha256: sha('f'),
      serverTrustBundleSha256: sha('0'),
      serverAuthoritySha256: [sha('1')],
      commandSha256: sha('2'),
      oldClientCertificateSha256: sha('3'),
      newClientCertificateSha256: sha('4'),
      beforeOldStatus: 200,
      beforeNewStatus: 200,
      afterOldStatus: 401,
      afterOldCode: 'client_certificate_required',
      afterNewStatus: 200,
    },
    pki: {
      clientIssuerBundleSha256: sha('5'),
      clientIssuerCaSha256: sha('6'),
      clientIssuerSubjectSha256: sha('7'),
      beforeCrlSha256: sha('8'),
      afterCrlSha256: sha('9'),
      crlIssuerSha256: sha('7'),
      beforeCrlNumber: '1000',
      afterCrlNumber: '1001',
      crlNumberIncreased: true,
      oldCertificateRevoked: true,
      replacementCertificateAccepted: true,
    },
    kubernetes: {
      clusterServerSha256: sha('a'),
      collectorSubjectSha256: sha('b'),
      deploymentUidSha256: sha('c'),
      beforeDeploymentResourceVersionSha256: sha('d'),
      afterDeploymentResourceVersionSha256: sha('e'),
      beforeGeneration: 10,
      afterGeneration: 11,
      beforeCrlAnnotationSha256: sha('f'),
      afterCrlAnnotationSha256: sha('0'),
      beforePodUidSha256: [sha('1'), sha('2')],
      afterPodUidSha256: [sha('3'), sha('4')],
      oldPodsFullyReplaced: true,
      twoReadyReplicasOnDistinctNodes: true,
      exactReadOnlyCollectorAuthority: true,
      secretReadDenied: true,
      mutationDenied: true,
    },
    gates: {
      sourceReportsBound: true,
      externalIdentityBound: true,
      serverTrustSeparatedFromClientIssuer: true,
      sameClientIssuer: true,
      oldAndReplacementInitiallyAccepted: true,
      crlMonotonic: true,
      deploymentRolled: true,
      oldPodsRetired: true,
      revokedCertificateRejected: true,
      replacementCertificateAccepted: true,
      readOnlyCollectorAuthority: true,
      passed: true,
    },
  };
}

function caRolloverReport(ceremonyBytes, durableBytes, ceremony) {
  return {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-ca-rollover-evidence@v1',
    observedAt: new Date(NOW_MS + 300).toISOString(),
    source: {
      oldStateSha256: sha('1'),
      overlapStateSha256: sha('2'),
      ceremonyReportSha256: rawDigest(ceremonyBytes),
      durableAuditReportSha256: rawDigest(durableBytes),
      ceremonyFixture: ceremony.fixture,
      durableAuditFixture:
        'qinglong/worker-credential-management-durable-audit-evidence@v1',
    },
    identity: commonIdentity(ceremony),
    transport: {
      endpointSha256: sha('e'),
      servernameSha256: sha('f'),
      serverTrustBundleSha256: sha('0'),
      commandSha256: sha('2'),
      oldClientCertificateSha256: sha('5'),
      newClientCertificateSha256: sha('6'),
    },
    trustTransition: {
      oldCaBundleSha256: sha('3'),
      overlapCaBundleSha256: sha('4'),
      newCaBundleSha256: sha('5'),
      oldCrlBundleSha256: sha('6'),
      overlapCrlBundleSha256: sha('7'),
      newCrlBundleSha256: sha('8'),
      oldIssuerCaSha256: sha('1'),
      newIssuerCaSha256: sha('2'),
      oldSet: [sha('1')],
      overlapSet: [sha('1'), sha('2')],
      newSet: [sha('2')],
      crlIssuerCoverageExact: true,
    },
    access: {
      oldCertificateStatus: [200, 200, 401],
      newCertificateStatus: [401, 200, 200],
    },
    kubernetes: {
      clusterServerSha256: sha('a'),
      collectorSubjectSha256: sha('b'),
      deploymentUidSha256: sha('c'),
      generations: [20, 21, 22],
      resourceVersionSha256: [sha('9'), sha('a'), sha('b')],
      podUidSha256: [
        [sha('0'), sha('1')],
        [sha('2'), sha('3')],
        [sha('4'), sha('5')],
      ],
      allGenerationsFullyReplaced: true,
      twoReadyReplicasOnDistinctNodes: true,
      exactReadOnlyCollectorAuthority: true,
    },
    gates: {
      sourceReportsBound: true,
      externalIdentityBound: true,
      serverTrustSeparatedFromClientIssuer: true,
      oldOnlyObserved: true,
      exactOverlapObserved: true,
      safeRetirementObserved: true,
      crlCoverageObservedEveryPhase: true,
      allPodGenerationsReplaced: true,
      readOnlyCollectorAuthority: true,
      passed: true,
    },
  };
}

function writeJson(directory, name, value) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return filePath;
}

function fixture(mutate = () => {}) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-release-test-')),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const ceremony = ceremonyReport();
  mutate({ phase: 'ceremony', report: ceremony });
  const ceremonyReportFile = writeJson(directory, 'ceremony.json', ceremony);
  const ceremonyBytes = fs.readFileSync(ceremonyReportFile);
  const durable = durableReport(ceremonyBytes, ceremony);
  mutate({ phase: 'durable', report: durable });
  const durableAuditReportFile = writeJson(directory, 'durable.json', durable);
  const durableBytes = fs.readFileSync(durableAuditReportFile);
  const pki = pkiReport(ceremonyBytes, durableBytes, ceremony);
  mutate({ phase: 'pki', report: pki });
  const pkiRotationReportFile = writeJson(directory, 'pki.json', pki);
  const caRollover = caRolloverReport(ceremonyBytes, durableBytes, ceremony);
  mutate({ phase: 'ca', report: caRollover });
  const caRolloverReportFile = writeJson(
    directory,
    'ca-rollover.json',
    caRollover,
  );
  return {
    directory,
    ceremonyReportFile,
    durableAuditReportFile,
    pkiRotationReportFile,
    caRolloverReportFile,
    outputFile: path.join(directory, 'release.json'),
  };
}

function options(paths) {
  return {
    ceremonyReportFile: paths.ceremonyReportFile,
    durableAuditReportFile: paths.durableAuditReportFile,
    pkiRotationReportFile: paths.pkiRotationReportFile,
    caRolloverReportFile: paths.caRolloverReportFile,
    outputFile: paths.outputFile,
  };
}

function gateOptions(paths) {
  return {
    reportFile: paths.outputFile,
    ceremonyReportFile: paths.ceremonyReportFile,
    durableAuditReportFile: paths.durableAuditReportFile,
    pkiRotationReportFile: paths.pkiRotationReportFile,
    caRolloverReportFile: paths.caRolloverReportFile,
    sourceCommit: 'a'.repeat(40),
    releaseVersion: '3.0.0-alpha.1',
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('assembles and independently re-audits one digest-bound release gate', () => {
  const paths = fixture();
  const report = runWorkerCredentialManagementReleaseEvidence(
    options(paths),
    { now: () => NOW_MS + 1_000 },
  );
  assert.equal(
    validateWorkerCredentialManagementReleaseEvidence(report).compatible,
    true,
  );
  assert.equal(report.gates.passed, true);
  assert.deepEqual(report.deployment.pkiGenerations, [10, 11]);
  assert.deepEqual(report.deployment.caRolloverGenerations, [20, 21, 22]);
  assert.equal(fs.statSync(paths.outputFile).mode & 0o777, 0o600);
  assert.doesNotMatch(
    JSON.stringify(report),
    /operator-a|reviewer-b|BEGIN|eyJ|pod-|node-|deployment-a/,
  );

  const audit = spawnSync(
    process.execPath,
    [
      path.resolve(
        __dirname,
        '../../scripts/ql3-worker-credential-management-release-evidence-audit.cjs',
      ),
      `--report=${paths.outputFile}`,
      `--ceremony-report=${paths.ceremonyReportFile}`,
      `--durable-audit-report=${paths.durableAuditReportFile}`,
      `--pki-rotation-report=${paths.pkiRotationReportFile}`,
      `--ca-rollover-report=${paths.caRolloverReportFile}`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).compatible, true);
});

test('binds fresh source-aware evidence to one release workflow identity', () => {
  const paths = fixture();
  runWorkerCredentialManagementReleaseEvidence(options(paths), {
    now: () => NOW_MS + 1_000,
  });
  const result = auditWorkerCredentialManagementReleaseGate(
    gateOptions(paths),
    { now: () => NOW_MS + 2_000 },
  );
  assert.deepEqual(result, {
    schemaVersion: 1,
    fixture: 'qinglong/worker-credential-management-release-gate@v1',
    compatible: true,
    sourceCommit: 'a'.repeat(40),
    releaseVersion: '3.0.0-alpha.1',
    evidenceReportSha256: rawDigest(fs.readFileSync(paths.outputFile)),
    maximumEvidenceAgeSeconds: 86400,
  });
});

test('rejects stale or future-dated release evidence', () => {
  const paths = fixture();
  runWorkerCredentialManagementReleaseEvidence(options(paths), {
    now: () => NOW_MS + 1_000,
  });
  assert.throws(
    () =>
      auditWorkerCredentialManagementReleaseGate(gateOptions(paths), {
        now: () => NOW_MS + 1_000 + MAX_EVIDENCE_AGE_MS + 1,
      }),
    /older than the 24 hour release window/,
  );
  assert.throws(
    () =>
      auditWorkerCredentialManagementReleaseGate(gateOptions(paths), {
        now: () => NOW_MS + 1_000 - MAX_FUTURE_SKEW_MS - 1,
      }),
    /too far in the future/,
  );
});

test('release gate re-audits sources instead of trusting the final report', () => {
  const paths = fixture();
  runWorkerCredentialManagementReleaseEvidence(options(paths), {
    now: () => NOW_MS + 1_000,
  });
  const ceremony = JSON.parse(fs.readFileSync(paths.ceremonyReportFile, 'utf8'));
  ceremony.ceremony.planDigest = 'f'.repeat(64);
  fs.writeFileSync(paths.ceremonyReportFile, `${JSON.stringify(ceremony)}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () =>
      auditWorkerCredentialManagementReleaseGate(gateOptions(paths), {
        now: () => NOW_MS + 2_000,
      }),
    /source-aware evidence audit is incompatible/,
  );
});

test('release gate accepts only exact immutable release identity arguments', () => {
  const argv = [
    '--report=/private/release.json',
    '--ceremony-report=/private/ceremony.json',
    '--durable-audit-report=/private/durable.json',
    '--pki-rotation-report=/private/pki.json',
    '--ca-rollover-report=/private/ca.json',
    `--source-commit=${'a'.repeat(40)}`,
    '--release-version=3.0.0',
  ];
  assert.equal(parseGateArguments(argv).releaseVersion, '3.0.0');
  assert.throws(
    () => parseGateArguments([...argv, '--extra=true']),
    WorkerCredentialManagementReleaseGateError,
  );
  const invalid = gateOptions({
    outputFile: '/private/release.json',
    ceremonyReportFile: '/private/ceremony.json',
    durableAuditReportFile: '/private/durable.json',
    pkiRotationReportFile: '/private/pki.json',
    caRolloverReportFile: '/private/ca.json',
  });
  assert.throws(
    () =>
      auditWorkerCredentialManagementReleaseGate(
        { ...invalid, releaseVersion: '3.00.0' },
        { now: () => NOW_MS },
      ),
    /QingLong 3 SemVer image tag/,
  );
});

test('rejects a broken source digest chain', () => {
  const paths = fixture(({ phase, report }) => {
    if (phase === 'ca') report.source.ceremonyReportSha256 = sha('f');
  });
  assert.throws(
    () =>
      runWorkerCredentialManagementReleaseEvidence(options(paths), {
        now: () => NOW_MS + 1_000,
      }),
    /digest chain is not exact/,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
});

test('rejects operator, transport and Deployment drift across reports', () => {
  for (const mutate of [
    ({ phase, report }) => {
      if (phase === 'ca') {
        report.identity.subjectSha256 =
          ceremonyReport().identity.reviewerSubjectSha256;
      }
    },
    ({ phase, report }) => {
      if (phase === 'ca') report.transport.endpointSha256 = sha('d');
    },
    ({ phase, report }) => {
      if (phase === 'ca') report.kubernetes.deploymentUidSha256 = sha('d');
    },
  ]) {
    const paths = fixture(mutate);
    assert.throws(
      () =>
        runWorkerCredentialManagementReleaseEvidence(options(paths), {
          now: () => NOW_MS + 1_000,
        }),
      /reviewed operator|management transport|Kubernetes authority/,
    );
    assert.equal(fs.existsSync(paths.outputFile), false);
  }
});

test('rejects an incompatible source report before release output', () => {
  const paths = fixture(({ phase, report }) => {
    if (phase === 'pki') report.gates.passed = false;
  });
  assert.throws(
    () =>
      runWorkerCredentialManagementReleaseEvidence(options(paths), {
        now: () => NOW_MS + 1_000,
      }),
    /source reports are incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputFile), false);
});

test('offline audit recomputes source binding instead of trusting claimed gates', () => {
  const paths = fixture();
  const report = runWorkerCredentialManagementReleaseEvidence(
    options(paths),
    { now: () => NOW_MS + 1_000 },
  );
  for (const changed of [
    { ...structuredClone(report), extra: true },
    {
      ...structuredClone(report),
      gates: { ...report.gates, passed: false },
    },
    { ...structuredClone(report), privateKey: 'forbidden' },
    {
      ...structuredClone(report),
      transport: { ...report.transport, endpointSha256: sha('d') },
    },
  ]) {
    const documents = readSourceDocuments(options(paths));
    try {
      assert.equal(
        auditWorkerCredentialManagementReleaseEvidence(changed, documents)
          .compatible,
        false,
      );
    } finally {
      clearSourceDocuments(documents);
    }
  }
});

test('rejects a release timestamp older than a source observation', () => {
  const paths = fixture();
  const report = runWorkerCredentialManagementReleaseEvidence(
    options(paths),
    { now: () => NOW_MS + 1_000 },
  );
  const changed = {
    ...structuredClone(report),
    observedAt: new Date(NOW_MS + 150).toISOString(),
  };
  const documents = readSourceDocuments(options(paths));
  try {
    assert.equal(
      auditWorkerCredentialManagementReleaseEvidence(changed, documents)
        .compatible,
      false,
    );
  } finally {
    clearSourceDocuments(documents);
  }
});

test('parses only the exact five path-based runner arguments', () => {
  const argv = [
    '--ceremony-report=/private/ceremony.json',
    '--durable-audit-report=/private/durable.json',
    '--pki-rotation-report=/private/pki.json',
    '--ca-rollover-report=/private/ca.json',
    '--output=/private/release.json',
  ];
  assert.equal(
    parseArguments(argv).pkiRotationReportFile,
    '/private/pki.json',
  );
  assert.throws(
    () => parseArguments([...argv, '--extra=true']),
    WorkerCredentialManagementReleaseEvidenceError,
  );
});
