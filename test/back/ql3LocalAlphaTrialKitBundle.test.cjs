'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditLocalAlphaTrialKit,
  createLocalAlphaTrialKit,
  createLocalAlphaTrialKitVerificationEvidence,
  parseArguments,
  sha256File,
} = require('../../scripts/ql3-local-alpha-trial-kit-bundle.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const root = path.resolve(__dirname, '../..');
const version = readReleaseIdentity(root).version;
const revision = 'a'.repeat(40);

function imageInspection(
  role,
  idCharacter = role === 'application' ? '1' : '2',
  variant = 'headless',
) {
  return {
    Id: `sha256:${idCharacter.repeat(64)}`,
    Os: 'linux',
    Architecture: 'arm64',
    Config: {
      User: '65532:65532',
      Labels: {
        'org.opencontainers.image.title':
          role === 'application'
            ? variant === 'console'
              ? 'QingLong 3.0 Local Console Application'
              : 'QingLong 3.0 Local Application'
            : 'QingLong 3.0 Local Operator',
        'org.opencontainers.image.source': 'https://github.com/whyour/qinglong',
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
        ...(role === 'application'
          ? {
              'io.qinglong.profile':
                variant === 'console'
                  ? 'edge-application-api,standalone-application-api'
                  : 'edge,standalone',
              'io.qinglong.ai': 'excluded',
              ...(variant === 'console'
                ? { 'io.qinglong.local.console': 'offline-loopback' }
                : {}),
            }
          : {
              'io.qinglong.lifecycle': 'short-lived',
              'io.qinglong.authority': 'local-owner-management',
              'io.qinglong.network': 'none-by-default',
            }),
      },
    },
  };
}

function fixture(t, variant = 'headless') {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-alpha-bundle-')),
  );
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const applicationSbom = path.join(fixtureRoot, 'application.json');
  const operatorSbom = path.join(fixtureRoot, 'operator.json');
  const verificationEvidence = path.join(
    fixtureRoot,
    'verification-evidence-source.json',
  );
  const readme = path.join(fixtureRoot, 'README-source.md');
  fs.writeFileSync(
    applicationSbom,
    `${JSON.stringify(
      createClusterImageSbom({
        root,
        image: variant === 'console' ? 'local-console' : 'local',
      }),
    )}\n`,
  );
  fs.writeFileSync(
    operatorSbom,
    `${JSON.stringify(
      createClusterImageSbom({ root, image: 'local-operator' }),
    )}\n`,
  );
  fs.writeFileSync(readme, '# Local Alpha Trial Kit\n');
  const paths = {
    fixtureRoot,
    applicationSbom,
    operatorSbom,
    verificationEvidence,
    readme,
    outputRoot: path.join(fixtureRoot, 'bundle'),
  };
  createLocalAlphaTrialKitVerificationEvidence(
    verificationOptions(paths, { variant }),
    adapters({}, variant),
  );
  return paths;
}

function verificationOptions(paths, overrides = {}) {
  return {
    root,
    output: paths.verificationEvidence,
    architecture: 'arm64',
    variant: 'headless',
    sourceRevision: revision,
    applicationImage: 'qinglong3-local-application:test-arm64',
    operatorImage: 'qinglong3-local-operator:test-arm64',
    repository: 'whyour/qinglong',
    workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    workflowSha: revision,
    eventName: 'workflow_dispatch',
    job: 'local-image',
    runId: '32990652047',
    runAttempt: '1',
    ...overrides,
  };
}

function createOptions(paths, variant = 'headless') {
  return {
    root,
    outputRoot: paths.outputRoot,
    architecture: 'arm64',
    variant,
    sourceRevision: revision,
    applicationImage: 'qinglong3-local-application:test-arm64',
    operatorImage: 'qinglong3-local-operator:test-arm64',
    applicationSbom: paths.applicationSbom,
    operatorSbom: paths.operatorSbom,
    verificationEvidence: paths.verificationEvidence,
    readme: paths.readme,
  };
}

function adapters(overrides = {}, variant = 'headless') {
  return {
    inspectImage(image) {
      return image.includes('operator')
        ? imageInspection('operator', '2', variant)
        : imageInspection('application', '1', variant);
    },
    saveImages(images, archivePath) {
      assert.deepEqual(images, [
        'qinglong3-local-application:test-arm64',
        'qinglong3-local-operator:test-arm64',
      ]);
      fs.writeFileSync(archivePath, Buffer.alloc(2048, 7), { flag: 'wx' });
    },
    ...overrides,
  };
}

test('materializes and offline-audits one closed two-image trial kit', (t) => {
  const paths = fixture(t);
  const manifest = createLocalAlphaTrialKit(createOptions(paths), adapters());
  assert.equal(manifest.schema, 'qinglong/alpha-local-trial-kit@v10');
  assert.equal(manifest.schemaVersion, 11);
  assert.equal(manifest.variant, 'headless');
  assert.equal(manifest.sourceRevision, revision);
  assert.equal(manifest.architecture, 'arm64');
  assert.equal(manifest.images.application.architecture, 'arm64');
  assert.equal(manifest.images.operator.architecture, 'arm64');
  assert.notEqual(manifest.images.application.id, manifest.images.operator.id);
  assert.equal(manifest.verification.file, 'verification-evidence.json');
  assert.equal(manifest.quickstart.file, 'quickstart.sh');
  assert.equal(manifest.upgradeReadiness.file, 'upgrade-readiness.sh');
  assert.equal(manifest.upgradeRehearsal.file, 'upgrade-rehearsal.sh');
  assert.equal(
    manifest.upgradeCutoverRehearsal.file,
    'upgrade-cutover-rehearsal.sh',
  );
  assert.equal(
    manifest.upgradeReconciliationRehearsal.file,
    'reconciliation-rehearsal.sh',
  );
  const quickstart = path.join(paths.outputRoot, 'quickstart.sh');
  const syntax = spawnSync('sh', ['-n', quickstart], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const quickstartContents = fs.readFileSync(quickstart, 'utf8');
  assert.match(
    quickstartContents,
    /QingLong 3\.0 Local Alpha is active \(\$VARIANT, \$profile, \$ARCHITECTURE\)/,
  );
  assert.match(quickstartContents, /qinglong3-local-application:test-arm64/);
  const cutoverRehearsal = path.join(
    paths.outputRoot,
    'upgrade-cutover-rehearsal.sh',
  );
  const cutoverSyntax = spawnSync('sh', ['-n', cutoverRehearsal], {
    encoding: 'utf8',
  });
  assert.equal(cutoverSyntax.status, 0, cutoverSyntax.stderr);
  const cutoverRehearsalContents = fs.readFileSync(cutoverRehearsal, 'utf8');
  assert.match(cutoverRehearsalContents, /VARIANT='headless'/);
  assert.match(
    cutoverRehearsalContents,
    /"transformationRoot":"\$rehearsal_root\/data-directory\/transformation"/,
  );
  assert.doesNotMatch(
    cutoverRehearsalContents,
    /mkdir[^\n]*data-directory\/transformation|for directory in[^\n]*data-directory\/transformation/,
  );
  assert.match(
    cutoverRehearsalContents,
    /docker_socket=\$\(realpath \/var\/run\/docker\.sock\)/,
  );
  assert.match(
    cutoverRehearsalContents,
    /operator_docker_socket=\/run\/docker\.sock/,
  );
  assert.match(
    cutoverRehearsalContents,
    /--mount "type=bind,src=\$docker_socket,dst=\$operator_docker_socket"/,
  );
  assert.match(
    cutoverRehearsalContents,
    /"dockerSocketPath":"\$operator_docker_socket"/,
  );
  assert.doesNotMatch(
    cutoverRehearsalContents,
    /"dockerSocketPath":"\/var\/run\/docker\.sock"|dst=\/var\/run\/docker\.sock/,
  );
  const legacyStopTemplate = cutoverRehearsalContents.match(
    /cat >"\$rehearsal_root\/commands\/legacy-stop\.json" <<EOF\n([^\n]+)\nEOF/,
  );
  assert.ok(legacyStopTemplate, 'legacy-stop command template is missing');
  const legacyStopCommand = JSON.parse(
    legacyStopTemplate[1]
      .replaceAll('$allow_root_service', 'false')
      .replaceAll('$now_ms', '1')
      .replace(/\$[a-z_]+/g, 'fixture'),
  );
  assert.deepEqual(Object.keys(legacyStopCommand.request).sort(), [
    'activationPath',
    'cutoverId',
    'expectedActivationDigest',
    'expectedLegacyContainerId',
    'expectedLegacyDatabasePath',
    'instanceId',
    'legacySourcePath',
    'profile',
    'requestedAtMs',
  ]);
  for (const phase of [
    'bootstrap Owner authority',
    'transform reviewed Legacy data',
    'stop exact Legacy container',
    'apply transformed Legacy data',
    'prepare adopted deployment bundle',
    'create exact target container',
    'start exact target container',
    'stop target and prove rollback candidate',
  ]) {
    assert.match(cutoverRehearsalContents, new RegExp(`phase '${phase}'`));
  }
  assert.match(
    cutoverRehearsalContents,
    /QingLong Local Alpha target-start result:/,
  );
  assert.match(
    cutoverRehearsalContents,
    /QingLong Local Alpha target-stop result:/,
  );
  assert.match(
    cutoverRehearsalContents,
    /\$APPLICATION_IMAGE" --cutover-probe --config/,
  );
  assert.match(
    cutoverRehearsalContents,
    /QingLong Local Alpha target-stop evidence:/,
  );
  assert.match(cutoverRehearsalContents, /tr -d '\\n'/);
  assert.match(cutoverRehearsalContents, /--capture-after-write/);
  assert.match(cutoverRehearsalContents, /"operation":"task\.put"/);
  assert.match(
    cutoverRehearsalContents,
    /local\.deployment\.reconciliation\.capture\.prepare/,
  );
  assert.match(
    cutoverRehearsalContents,
    /local\.deployment\.reconciliation\.capture\.commit/,
  );
  assert.match(
    cutoverRehearsalContents,
    /local\.deployment\.reconciliation\.capture\.verify/,
  );
  assert.match(
    cutoverRehearsalContents,
    /qinglong\/local-alpha-upgrade-reconciliation-capture-summary@v1/,
  );
  const postWriteTemplate = cutoverRehearsalContents.match(
    /cat >"\$rehearsal_root\/commands\/post-cutover-task\.json" <<EOF\n([^\n]+)\nEOF/,
  );
  assert.ok(postWriteTemplate, 'post-cutover Task command template is missing');
  const postWriteCommand = JSON.parse(
    postWriteTemplate[1]
      .replaceAll('$write_ms', '1')
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, 'fixture'),
  );
  assert.equal(postWriteCommand.operation, 'task.put');
  assert.equal(postWriteCommand.request.taskId, 'alpha-post-cutover-write');
  assert.equal(postWriteCommand.request.expectedRevision, null);
  const capturePrepareTemplate = cutoverRehearsalContents.match(
    /cat >"\$rehearsal_root\/commands\/reconciliation-capture-prepare\.json" <<EOF\n([^\n]+)\nEOF/,
  );
  assert.ok(
    capturePrepareTemplate,
    'reconciliation capture prepare command template is missing',
  );
  const capturePrepareCommand = JSON.parse(
    capturePrepareTemplate[1]
      .replaceAll('$allow_root_service', 'false')
      .replaceAll('$capture_prepare_ms', '1')
      .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, 'fixture'),
  );
  assert.equal(
    capturePrepareCommand.operation,
    'local.deployment.reconciliation.capture.prepare',
  );
  assert.deepEqual(Object.keys(capturePrepareCommand.request).sort(), [
    'activationPath',
    'applicationConfigPath',
    'captureId',
    'cutoverId',
    'expectedActivationDigest',
    'expectedHeadDigest',
    'expectedStoppedRecordDigest',
    'generation',
    'instanceId',
    'legacySourcePath',
    'preparedAtMs',
    'profile',
    'recoveryPath',
    'stoppedAuthority',
    'targetDatabasePath',
  ]);
  const reconciliationRehearsal = path.join(
    paths.outputRoot,
    'reconciliation-rehearsal.sh',
  );
  const reconciliationSyntax = spawnSync(
    'sh',
    ['-n', reconciliationRehearsal],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(reconciliationSyntax.status, 0, reconciliationSyntax.stderr);
  const reconciliationContents = fs.readFileSync(
    reconciliationRehearsal,
    'utf8',
  );
  assert.match(reconciliationContents, /VARIANT='headless'/);
  for (const operation of [
    'reconciliation.plan.prepare',
    'reconciliation.review.diagnostics',
    'reconciliation.review.commit',
    'reconciliation.application.commit',
    'reconciliation.automation.decision.commit',
    'reconciliation.automation.apply',
    'reconciliation.automation.apply.rollback',
  ]) {
    assert.match(reconciliationContents, new RegExp(operation));
  }
  assert.match(reconciliationContents, /--memory 128m --memory-swap 128m/);
  assert.match(reconciliationContents, /--network none/);
  assert.match(
    reconciliationContents,
    /\[ "\$\(stat -c %a "\$decision_parent"\)" = 700 \]/,
  );
  assert.match(
    reconciliationContents,
    /type=bind,src=\$decision_parent,dst=\$decision_parent,readonly/,
  );
  assert.match(
    reconciliationContents,
    /type=bind,src=\$legacy_root,dst=\$legacy_root,readonly/,
  );
  assert.match(
    reconciliationContents,
    /apply-rollback edge\|standalone .* \/absolute\/legacy-root/,
  );
  assert.match(reconciliationContents, /result_stage=.*\.\$result_file\.\$\$/);
  assert.match(
    reconciliationContents,
    /\[ -e "\$command_root\/automation-apply\.json" \]/,
  );
  assert.doesNotMatch(
    reconciliationContents,
    /type=bind,src=\$input_file,dst=\$input_file,readonly/,
  );
  assert.match(
    reconciliationContents,
    /\$decision_label parent must contain only the selected decision file/,
  );
  assert.equal(
    (reconciliationContents.match(/"authorizationLifetimeMs":60000/g) || [])
      .length,
    2,
  );
  assert.doesNotMatch(
    reconciliationContents,
    /"authorizationLifetimeMs":1800000/,
  );
  assert.match(reconciliationContents, /! -path "\$decision_file"/);
  assert.match(reconciliationContents, /automaticDecision":"not_authorized/);
  assert.match(reconciliationContents, /automaticRowDecision":"not_authorized/);
  assert.match(reconciliationContents, /"completion":"not_attempted"/);
  const report = auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot });
  assert.equal(report.compatible, true);
  assert.equal(report.sourceRevision, revision);
  assert.equal(report.workflowRunId, '32990652047');
  assert.equal(report.variant, 'headless');
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
    'qinglong3-local-application.cdx.json',
    'qinglong3-local-operator.cdx.json',
    'qinglong3-local-trial-kit-arm64.docker.tar',
    'quickstart.sh',
    'reconciliation-rehearsal.sh',
    'upgrade-cutover-rehearsal.sh',
    'upgrade-readiness.sh',
    'upgrade-rehearsal.sh',
    'verification-evidence.json',
  ]);
});

test('materializes a distinct loopback Console trial kit without widening the headless archive', (t) => {
  const paths = fixture(t, 'console');
  const manifest = createLocalAlphaTrialKit(
    createOptions(paths, 'console'),
    adapters({}, 'console'),
  );
  assert.equal(manifest.variant, 'console');
  const applicationSbom = JSON.parse(
    fs.readFileSync(
      path.join(paths.outputRoot, 'qinglong3-local-application.cdx.json'),
      'utf8',
    ),
  );
  assert.equal(
    applicationSbom.metadata.properties.find(
      (property) => property.name === 'qinglong:image-profile',
    ).value,
    'local-console',
  );
  const verification = JSON.parse(
    fs.readFileSync(
      path.join(paths.outputRoot, 'verification-evidence.json'),
      'utf8',
    ),
  );
  assert.equal(verification.gates.consoleLiveJourney, 'passed');
  assert.equal(verification.gates.firstAutomationJourney, 'passed');
  assert.equal(verification.gates.ownerCredentialPresentation, 'passed');
  assert.equal(verification.gates.legacyUpgradeReadiness, 'passed');
  assert.equal(verification.gates.legacyUpgradeStage, 'passed');
  assert.equal(verification.gates.legacyUpgradeCutover, 'passed');
  assert.equal(verification.gates.legacyUpgradeReconciliationCapture, 'passed');
  assert.equal(
    verification.gates.legacyUpgradeReconciliationAutomationRollback,
    'passed',
  );
  const quickstartContents = fs.readFileSync(
    path.join(paths.outputRoot, 'quickstart.sh'),
    'utf8',
  );
  assert.match(quickstartContents, /VARIANT='console'/);
  assert.match(quickstartContents, /network_mode=host/);
  assert.match(quickstartContents, /application_config=local-api\.json/);
  assert.match(quickstartContents, /"host":"127\.0\.0\.1","port":5700/);
  assert.match(quickstartContents, /Console: http:\/\/127\.0\.0\.1:5700\//);
  assert.match(quickstartContents, /alpha-first-automation/);
  assert.match(quickstartContents, /do not expose the port on LAN/);
  const cutoverContents = fs.readFileSync(
    path.join(paths.outputRoot, 'upgrade-cutover-rehearsal.sh'),
    'utf8',
  );
  assert.match(cutoverContents, /VARIANT='console'/);
  assert.doesNotMatch(
    cutoverContents,
    /available only in the headless Trial Kit/,
  );
  assert.match(cutoverContents, /"schema":"qinglong\/local-api-process@v1"/);
  assert.match(cutoverContents, /"targetApi":\{"configPath":/);
  assert.match(cutoverContents, /"targetEntrypoint":"\$target_entrypoint"/);
  const report = auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot });
  assert.equal(report.compatible, true);
  assert.equal(report.variant, 'console');
  assert.deepEqual(fs.readdirSync(paths.outputRoot).sort(), [
    'README.md',
    'SHA256SUMS',
    'manifest.json',
    'qinglong3-local-application.cdx.json',
    'qinglong3-local-console-trial-kit-arm64.docker.tar',
    'qinglong3-local-operator.cdx.json',
    'quickstart.sh',
    'reconciliation-rehearsal.sh',
    'upgrade-cutover-rehearsal.sh',
    'upgrade-readiness.sh',
    'upgrade-rehearsal.sh',
    'verification-evidence.json',
  ]);
});

test('fails closed and removes a partial output on incompatible image identity', (t) => {
  const paths = fixture(t);
  const options = createOptions(paths);
  assert.throws(
    () =>
      createLocalAlphaTrialKit(
        options,
        adapters({
          inspectImage(image) {
            const inspection = image.includes('operator')
              ? imageInspection('operator')
              : imageInspection('application');
            inspection.Config.Labels['org.opencontainers.image.revision'] =
              'b'.repeat(40);
            return inspection;
          },
        }),
      ),
    /image identity is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('offline audit rejects archive, file-set, SBOM and verification mutation', (t) => {
  for (const mutation of [
    'archive',
    'extra',
    'quickstart',
    'upgrade-readiness',
    'upgrade-rehearsal',
    'upgrade-cutover-rehearsal',
    'upgrade-reconciliation-rehearsal',
    'sbom',
    'verification',
  ]) {
    const paths = fixture(t);
    paths.outputRoot = path.join(paths.fixtureRoot, `bundle-${mutation}`);
    createLocalAlphaTrialKit(createOptions(paths), adapters());
    if (mutation === 'archive') {
      fs.appendFileSync(
        path.join(
          paths.outputRoot,
          'qinglong3-local-trial-kit-arm64.docker.tar',
        ),
        'tamper',
      );
    } else if (mutation === 'extra') {
      fs.writeFileSync(path.join(paths.outputRoot, 'credential.txt'), 'secret');
    } else if (mutation === 'quickstart') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'quickstart.sh'),
        '# drift\n',
      );
    } else if (mutation === 'upgrade-readiness') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'upgrade-readiness.sh'),
        '# drift\n',
      );
    } else if (mutation === 'upgrade-rehearsal') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'upgrade-rehearsal.sh'),
        '# drift\n',
      );
    } else if (mutation === 'upgrade-cutover-rehearsal') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'upgrade-cutover-rehearsal.sh'),
        '# drift\n',
      );
    } else if (mutation === 'upgrade-reconciliation-rehearsal') {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'reconciliation-rehearsal.sh'),
        '# drift\n',
      );
    } else if (mutation === 'sbom') {
      fs.copyFileSync(
        path.join(paths.outputRoot, 'qinglong3-local-application.cdx.json'),
        path.join(paths.outputRoot, 'qinglong3-local-operator.cdx.json'),
      );
    } else {
      fs.appendFileSync(
        path.join(paths.outputRoot, 'verification-evidence.json'),
        'tamper',
      );
    }
    assert.throws(
      () => auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot }),
      /differs|not closed|incompatible/,
      mutation,
    );
  }
});

test('offline audit rejects a rehashed non-canonical quickstart', (t) => {
  const paths = fixture(t);
  createLocalAlphaTrialKit(createOptions(paths), adapters());
  const quickstart = path.join(paths.outputRoot, 'quickstart.sh');
  fs.appendFileSync(quickstart, '# locally rewritten\n');
  const manifestPath = path.join(paths.outputRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.quickstart = {
    file: 'quickstart.sh',
    sha256: sha256File(quickstart),
    bytes: fs.statSync(quickstart).size,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checkedFiles = [
    'qinglong3-local-trial-kit-arm64.docker.tar',
    'qinglong3-local-application.cdx.json',
    'qinglong3-local-operator.cdx.json',
    'verification-evidence.json',
    'quickstart.sh',
    'upgrade-readiness.sh',
    'upgrade-rehearsal.sh',
    'upgrade-cutover-rehearsal.sh',
    'reconciliation-rehearsal.sh',
    'README.md',
    'manifest.json',
  ];
  fs.writeFileSync(
    path.join(paths.outputRoot, 'SHA256SUMS'),
    `${checkedFiles
      .map(
        (name) =>
          `${sha256File(path.join(paths.outputRoot, name)).slice(7)}  ${name}`,
      )
      .join('\n')}\n`,
  );
  assert.throws(
    () => auditLocalAlphaTrialKit({ bundleRoot: paths.outputRoot }),
    /quickstart differs from the canonical deployment journey/,
  );
});

test('generated quickstart drives the closed fresh Edge journey', (t) => {
  const paths = fixture(t);
  createLocalAlphaTrialKit(createOptions(paths), adapters());
  const fakeBin = path.join(paths.fixtureRoot, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const dockerLog = path.join(paths.fixtureRoot, 'docker.log');
  const fakeDocker = path.join(fakeBin, 'docker');
  fs.writeFileSync(
    fakeDocker,
    `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1:$2" in
  info:|load:*) exit 0 ;;
  image:inspect)
    case "$*" in
      *local-application*) printf '%s\\n' 'sha256:${'1'.repeat(
        64,
      )}|arm64|65532:65532|${revision}' ;;
      *local-operator*) printf '%s\\n' 'sha256:${'2'.repeat(
        64,
      )}|arm64|65532:65532|${revision}|short-lived|none-by-default' ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  logs:*) printf '%s\\n' '{"event":"active"}'; exit 0 ;;
  inspect:*) printf '%s\\n' 'true'; exit 0 ;;
esac
case " $* " in
  *' --detach '*) printf '%s\\n' 'fake-container-id'; exit 0 ;;
  *'/setup.json'*) printf '%s\\n' '{"status":"prepared"}'; exit 0 ;;
  *'/owner-provision.json'*) printf '%s\\n' '{"status":"inserted"}'; exit 0 ;;
  *'/owner-challenge.json'*) printf '%s\\n' '{"status":"inserted"}'; exit 0 ;;
  *'/owner-claim.json'*) printf '%s\\n' '{"status":"inserted","role":"owner"}'; exit 0 ;;
  *'/owner-credential-install.json'*) printf '%s\\n' '{"status":"installed"}'; exit 0 ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
  const dataRoot = path.join(paths.fixtureRoot, 'quickstart-data');
  const run = spawnSync(
    'sh',
    [
      path.join(paths.outputRoot, 'quickstart.sh'),
      'edge',
      dataRoot,
      'ql3-alpha-test',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(
    run.status,
    0,
    `${run.stderr}\n${run.stdout}\n${fs.readFileSync(dockerLog, 'utf8')}`,
  );
  assert.match(
    run.stdout,
    /QingLong 3\.0 Local Alpha is active \(headless, edge, arm64\)/,
  );
  assert.equal(
    fs.readFileSync(path.join(dataRoot, 'container.id'), 'utf8'),
    'fake-container-id\n',
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(dataRoot, 'results', 'owner-claim.json.result.json'),
        'utf8',
      ),
    ).role,
    'owner',
  );
  const calls = fs.readFileSync(dockerLog, 'utf8');
  assert.match(
    calls,
    /load --input .*qinglong3-local-trial-kit-arm64\.docker\.tar/,
  );
  assert.match(calls, /--memory 128m --memory-swap 128m/);
  assert.match(calls, /--pids-limit 64/);
  assert.doesNotMatch(calls, /--network (?!none)/);
});

test('generated upgrade readiness retries one transient read-only inspection', (t) => {
  const paths = fixture(t);
  createLocalAlphaTrialKit(createOptions(paths), adapters());
  const fakeBin = path.join(paths.fixtureRoot, 'readiness-fake-bin');
  fs.mkdirSync(fakeBin);
  const dockerLog = path.join(paths.fixtureRoot, 'readiness-docker.log');
  const fakeDocker = path.join(fakeBin, 'docker');
  fs.writeFileSync(
    fakeDocker,
    `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1:$2" in
  info:|load:*) exit 0 ;;
  image:inspect)
    printf '%s\\n' 'sha256:${'2'.repeat(
      64,
    )}|arm64|65532:65532|${revision}|short-lived|none-by-default'
    exit 0
    ;;
esac
case " $* " in
  *'/sqlite-inspect.json'*) printf '%s\\n' '{"status":"inspected","evidence":{"planDigest":"${'a'.repeat(
    64,
  )}"}}'; exit 0 ;;
  *'/data-directory-inspect.json'*)
    if [ ! -e "$FAKE_DOCKER_DATA_ATTEMPT" ]; then
      : >"$FAKE_DOCKER_DATA_ATTEMPT"
      exit 1
    fi
    printf '%s\\n' '{"status":"inspected","evidence":{"planDigest":"${'b'.repeat(
      64,
    )}"}}'
    exit 0
    ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
  const legacyRoot = path.join(paths.fixtureRoot, 'legacy-data');
  fs.mkdirSync(path.join(legacyRoot, 'db'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyRoot, 'db', 'database.sqlite'), 'legacy', {
    mode: 0o600,
  });
  const evidenceRoot = path.join(paths.fixtureRoot, 'upgrade-readiness');
  const run = spawnSync(
    'sh',
    [
      path.join(paths.outputRoot, 'upgrade-readiness.sh'),
      'edge',
      legacyRoot,
      evidenceRoot,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DOCKER_DATA_ATTEMPT: path.join(
          paths.fixtureRoot,
          'readiness-data-attempt',
        ),
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /upgrade readiness inspection completed/);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(evidenceRoot, 'results', 'sqlite-inspect.result.json'),
        'utf8',
      ),
    ).status,
    'inspected',
  );
  const calls = fs.readFileSync(dockerLog, 'utf8');
  assert.match(
    calls,
    new RegExp(`src=${legacyRoot},dst=${legacyRoot},readonly`),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(evidenceRoot, 'sqlite-inspect.json'), 'utf8'),
    ).options.sourcePath,
    path.join(legacyRoot, 'db', 'database.sqlite'),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(evidenceRoot, 'data-directory-inspect.json'),
        'utf8',
      ),
    ).options.dataRoot,
    legacyRoot,
  );
  assert.match(calls, /--network none/);
  assert.match(calls, /--memory 128m --memory-swap 128m/);
  assert.equal((calls.match(/\/sqlite-inspect\.json/g) ?? []).length, 1);
  assert.equal(
    (calls.match(/\/data-directory-inspect\.json/g) ?? []).length,
    2,
  );
  assert.equal(
    fs
      .readdirSync(path.join(evidenceRoot, 'results'))
      .some((entry) =>
        entry.startsWith('.data-directory-inspect.result.json.'),
      ),
    false,
  );
  assert.doesNotMatch(calls, /adoption\.stage|activation\.prepare|cutover/);
});

test('generated upgrade rehearsal stages and verifies reviewed legacy plans without cutover', (t) => {
  const paths = fixture(t);
  createLocalAlphaTrialKit(createOptions(paths), adapters());
  const fakeBin = path.join(paths.fixtureRoot, 'rehearsal-fake-bin');
  fs.mkdirSync(fakeBin);
  const dockerLog = path.join(paths.fixtureRoot, 'rehearsal-docker.log');
  const fakeDocker = path.join(fakeBin, 'docker');
  fs.writeFileSync(
    fakeDocker,
    `#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1:$2" in
  info:|load:*) exit 0 ;;
  image:inspect)
    printf '%s\n' 'sha256:${'2'.repeat(
      64,
    )}|arm64|65532:65532|${revision}|short-lived|none-by-default'
    exit 0
    ;;
esac
case " $* " in
  *'/sqlite-stage.json'*) printf '%s\n' '{"status":"staged"}'; exit 0 ;;
  *'/sqlite-verify.json'*) printf '%s\n' '{"status":"verified","evidence":{"manifestDigest":"${'c'.repeat(
    64,
  )}"}}'; exit 0 ;;
  *'/sqlite-activation.json'*) printf '%s\n' '{"status":"prepared","evidence":{"activationDigest":"${'d'.repeat(
    64,
  )}"}}'; exit 0 ;;
  *'/data-directory-stage.json'*) printf '%s\n' '{"status":"staged","evidence":{"manifestDigest":"${'e'.repeat(
    64,
  )}"}}'; exit 0 ;;
  *'/data-directory-verify.json'*) printf '%s\n' '{"status":"verified"}'; exit 0 ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
  const legacyRoot = path.join(paths.fixtureRoot, 'rehearsal-legacy-data');
  fs.mkdirSync(path.join(legacyRoot, 'db'), { recursive: true, mode: 0o700 });
  const legacyDatabase = path.join(legacyRoot, 'db', 'database.sqlite');
  fs.writeFileSync(legacyDatabase, 'legacy-unchanged', { mode: 0o600 });
  const rehearsalRoot = path.join(paths.fixtureRoot, 'upgrade-rehearsal');
  const run = spawnSync(
    'sh',
    [
      path.join(paths.outputRoot, 'upgrade-rehearsal.sh'),
      'edge',
      legacyRoot,
      rehearsalRoot,
      'a'.repeat(64),
      'b'.repeat(64),
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DOCKER_LOG: dockerLog,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    },
  );
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stdout, /side-by-side upgrade stage completed/);
  assert.equal(fs.readFileSync(legacyDatabase, 'utf8'), 'legacy-unchanged');
  const summary = JSON.parse(
    fs.readFileSync(path.join(rehearsalRoot, 'stage-summary.json'), 'utf8'),
  );
  assert.equal(summary.status, 'verified');
  assert.equal(summary.legacySource, 'read_only');
  assert.equal(summary.cutover, 'not_authorized');
  assert.equal(summary.sqlite.activationDigest, 'd'.repeat(64));
  assert.equal(summary.dataDirectory.manifestDigest, 'e'.repeat(64));
  const calls = fs.readFileSync(dockerLog, 'utf8');
  assert.match(
    calls,
    new RegExp(`dst=${legacyRoot.replaceAll('/', '\\/')},readonly`),
  );
  assert.match(calls, /--network none/);
  assert.match(calls, /--memory 128m --memory-swap 128m/);
  assert.doesNotMatch(calls, /cutover|target-start|legacy-rollback/);
});

test('create rejects an image reference that could alter the shell journey', (t) => {
  const paths = fixture(t);
  const options = createOptions(paths);
  options.applicationImage = 'qinglong3-local-application:test;unexpected';
  assert.throws(
    () => createLocalAlphaTrialKit(options, adapters()),
    /application image reference is invalid/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('create rejects verification detached from the reviewed workflow', (t) => {
  const paths = fixture(t);
  const evidence = JSON.parse(
    fs.readFileSync(paths.verificationEvidence, 'utf8'),
  );
  evidence.workflow.job = 'unreviewed-job';
  fs.writeFileSync(paths.verificationEvidence, `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => createLocalAlphaTrialKit(createOptions(paths), adapters()),
    /verification evidence is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('create rejects verification without the exact reconciliation capture gate', (t) => {
  const paths = fixture(t);
  const evidence = JSON.parse(
    fs.readFileSync(paths.verificationEvidence, 'utf8'),
  );
  delete evidence.gates.legacyUpgradeReconciliationCapture;
  fs.writeFileSync(paths.verificationEvidence, `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => createLocalAlphaTrialKit(createOptions(paths), adapters()),
    /verification evidence is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('create rejects verification without the reviewed Automation rollback gate', (t) => {
  const paths = fixture(t);
  const evidence = JSON.parse(
    fs.readFileSync(paths.verificationEvidence, 'utf8'),
  );
  delete evidence.gates.legacyUpgradeReconciliationAutomationRollback;
  fs.writeFileSync(paths.verificationEvidence, `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => createLocalAlphaTrialKit(createOptions(paths), adapters()),
    /verification evidence is incompatible/,
  );
  assert.equal(fs.existsSync(paths.outputRoot), false);
});

test('verification recorder rejects non-milestone workflow provenance', (t) => {
  const paths = fixture(t);
  const output = path.join(paths.fixtureRoot, 'unreviewed-verification.json');
  assert.throws(
    () =>
      createLocalAlphaTrialKitVerificationEvidence(
        verificationOptions(paths, { output, eventName: 'push' }),
        adapters(),
      ),
    /verification evidence identity or output is invalid/,
  );
  assert.equal(fs.existsSync(output), false);
});

test('CLI grammar is exact and separates create from offline audit', () => {
  assert.deepEqual(
    parseArguments(['--mode=audit', '--bundle=/tmp/ql3-bundle']),
    { mode: 'audit', bundleRoot: '/tmp/ql3-bundle' },
  );
  assert.throws(
    () =>
      parseArguments([
        '--mode=audit',
        '--bundle=/tmp/ql3-bundle',
        '--allow-extra=true',
      ]),
    /audit arguments are invalid/,
  );
  assert.throws(
    () => parseArguments(['--mode=create', '--output=/tmp/output']),
    /create arguments are invalid/,
  );
  const recorded = parseArguments([
    '--mode=record-verification',
    '--application-image=qinglong3-local-application:test-arm64',
    '--operator-image=qinglong3-local-operator:test-arm64',
    '--architecture=arm64',
    '--variant=headless',
    `--source-revision=${revision}`,
    '--repository=whyour/qinglong',
    '--workflow-ref=whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
    `--workflow-sha=${revision}`,
    '--event=workflow_dispatch',
    '--job=local-image',
    '--run-id=32990652047',
    '--run-attempt=1',
    '--output=/tmp/verification-evidence.json',
  ]);
  assert.equal(recorded.mode, 'record-verification');
  assert.equal(recorded.runId, '32990652047');
});
