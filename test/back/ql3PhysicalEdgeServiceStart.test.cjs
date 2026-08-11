const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  buildServiceStartReport,
  installContract,
  normalizeServiceStartManifest,
  normalizeSession,
  parseArguments,
  parseOpenRcState,
  parseSystemdShow,
  parseWrapperObservations,
  renderEvidenceWrapper,
  validateServiceStartReport,
} = require('../../scripts/ql3-physical-edge-service-start.cjs');
const {
  canonicalDigest,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');

const packages = [
  '@qinglong/local-admin',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-execution',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'croner',
  'semver',
];

function artifact() {
  return {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'b'.repeat(64),
    artifactFiles: 627,
    artifactBytes: 5_045_360,
    entrypointSha256: 'c'.repeat(64),
    packages,
  };
}

function manifest(overrides = {}) {
  return normalizeServiceStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    serviceManager: 'systemd',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    expectedArtifactSha256: 'a'.repeat(64),
    expectedArtifactFiles: 627,
    expectedArtifactBytes: 5_045_360,
    expectedNodeSha256: 'd'.repeat(64),
    maximumBootToActiveMs: 180_000,
    maximumServiceStartBootAgeMs: 60_000,
    maximumServiceStartToActiveMs: 30_000,
    ...overrides,
  });
}

function environment(bootId) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    bootId,
    bootAgeMs: 15_000,
    dataFilesystem: 'ext4',
    nodeExecutable: '/usr/bin/node',
    nodeSha256: 'd'.repeat(64),
    nodeVersion: 'v24.18.0',
    virtualizationIndicators: [],
  };
}

function sessionFixture() {
  const sessionId = '019f0000-0000-4000-8000-000000000020';
  const dataPath = '/mnt/ql3-evidence';
  const deploymentRoot = `${dataPath}/.ql3-service-start-deployment-${sessionId}`;
  const toolRoot = `${deploymentRoot}/physical-service-start`;
  const serviceName = 'qinglong3-physical-019f0000';
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_service_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest()),
    uid: 1000,
    preparedAt: '2026-07-29T08:00:00.000Z',
    artifact: artifact(),
    environment: environment('019f0000-0000-4000-8000-000000000001'),
    paths: {
      dataPath,
      toolRoot,
      deploymentRoot,
      artifactRoot: '/opt/qinglong3-release',
      applicationEntrypoint:
        '/opt/qinglong3-release/node_modules/@qinglong/local-application/dist/cli.js',
      applicationConfig: `${deploymentRoot}/local-application.json`,
      wrapper: `${toolRoot}/boot-probe.sh`,
      wrapperStartRecord: `${toolRoot}/wrapper-start.record`,
      nodeRecord: `${toolRoot}/node.record`,
      activeRecord: `${toolRoot}/active.record`,
      eventLog: `${toolRoot}/events.jsonl`,
      stderrLog: `${toolRoot}/stderr.log`,
      fifo: `${toolRoot}/events.fifo`,
    },
    service: {
      kind: 'systemd',
      serviceName,
      managerExecutable: '/usr/bin/systemctl',
      managerSha256: 'e'.repeat(64),
      enableExecutable: '/usr/bin/systemctl',
      enableSha256: 'e'.repeat(64),
      descriptorSource: `${deploymentRoot}/service/qinglong3.service`,
      descriptorDestination: `/etc/systemd/system/${serviceName}.service`,
      descriptorMode: 0o644,
      descriptorSha256: 'f'.repeat(64),
      wrapperSha256: '1'.repeat(64),
      installArguments: [
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '644',
        `${deploymentRoot}/service/qinglong3.service`,
        `/etc/systemd/system/${serviceName}.service`,
      ],
      enableArguments: ['enable', serviceName],
    },
  };
  return normalizeSession({ ...body, sha256: canonicalDigest(body) });
}

function reportFixture(overrides = {}) {
  const session = sessionFixture();
  const after = environment('019f0000-0000-4000-8000-000000000002');
  return buildServiceStartReport({
    manifest: manifest(),
    session,
    observed: {
      after,
      artifact: artifact(),
      process: {
        bootId: after.bootId,
        wrapperPid: 101,
        wrapperStartTicks: 1200,
        nodePid: 102,
        nodeStartTicks: 1201,
      },
      service: {
        kind: 'systemd',
        serviceName: session.service.serviceName,
        managerExecutable: '/usr/bin/systemctl',
        managerSha256: 'e'.repeat(64),
        descriptorSha256: 'f'.repeat(64),
        mainPid: 101,
      },
    },
    measurements: {
      serviceStartBootAgeMs: 12_000,
      activeBootAgeMs: 13_250,
      bootToActiveMs: 13_250,
      serviceStartToActiveMs: 1_250,
      activeEventOrdinal: 2,
    },
    outcomes: {
      activeEventCount: 1,
      aiStatus: 'deployment_excluded',
      descriptorInstalled: true,
      serviceActive: true,
      serviceEnabled: true,
      wrapperProcessIdentityMatched: true,
      nodeProcessIdentityMatched: true,
      stderrBytes: 0,
    },
    generatedAt: '2026-07-29T08:01:00.000Z',
    ...overrides,
  });
}

test('normalizes bounded systemd and OpenRC boot budgets', () => {
  assert.equal(manifest().serviceManager, 'systemd');
  assert.equal(manifest({ serviceManager: 'openrc' }).serviceManager, 'openrc');
  assert.throws(
    () => manifest({ maximumBootToActiveMs: 601_000 }),
    /measurement budget/,
  );
  assert.throws(
    () =>
      manifest({
        maximumBootToActiveMs: 20_000,
        maximumServiceStartToActiveMs: 30_000,
      }),
    /measurement budget/,
  );
});

test('requires phase-specific absolute paths', () => {
  assert.deepEqual(
    parseArguments([
      'inspect',
      '--artifact-root=/opt/qinglong3-release',
      '--json',
    ]),
    {
      phase: 'inspect',
      artifactRoot: '/opt/qinglong3-release',
      json: true,
    },
  );
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--artifact-root=/opt/qinglong3-release',
      '--session=/mnt/data/session.json',
    ]).phase,
    'prepare',
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=manifest.json',
        '--session=/mnt/data/session.json',
        '--output=/mnt/data/report.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('renders a pre-Node POSIX anchor without service mutation authority', () => {
  const session = sessionFixture();
  const source = renderEvidenceWrapper({
    applicationEntrypoint: session.paths.applicationEntrypoint,
    nodeExecutable: session.environment.nodeExecutable,
    paths: session.paths,
  });
  assert.ok(
    source.indexOf('read -r service_start_uptime') <
      source.indexOf('"$expected_node" "$entrypoint"'),
  );
  assert.match(source, /set -C/);
  assert.match(source, /event_ordinal/);
  assert.doesNotMatch(
    source,
    /\b(?:reboot|poweroff|shutdown|systemctl|rc-service|rc-update|sudo)\b/,
  );
  assert.deepEqual(
    installContract(
      'systemd',
      session.service.serviceName,
      session.service.descriptorSource,
    ).enableArguments,
    ['enable', session.service.serviceName],
  );
});

test('binds one official active event to wrapper monotonic records', () => {
  const result = parseWrapperObservations({
    startContents:
      'schema=qinglong/physical-edge-service-wrapper-start@v1\n' +
      'boot_id=019f0000-0000-4000-8000-000000000002\n' +
      'service_start_uptime=12.00\n' +
      'wrapper_pid=101\n',
    nodeContents:
      'schema=qinglong/physical-edge-service-node@v1\nnode_pid=102\n',
    activeContents:
      'schema=qinglong/physical-edge-service-active@v1\n' +
      'boot_id=019f0000-0000-4000-8000-000000000002\n' +
      'event_ordinal=2\n' +
      'active_uptime=13.25\n',
    eventContents:
      '{"schemaVersion":1,"component":"qinglong3-local-application","level":"info","event":"starting","profile":"edge"}\n' +
      '{"schemaVersion":1,"component":"qinglong3-local-application","level":"info","event":"active","profile":"edge","aiStatus":"deployment_excluded"}\n',
  });
  assert.equal(result.serviceStartToActiveMs, 1250);
  assert.equal(result.activeEventOrdinal, 2);
  assert.throws(
    () =>
      parseWrapperObservations({
        startContents:
          'schema=qinglong/physical-edge-service-wrapper-start@v1\n' +
          'boot_id=019f0000-0000-4000-8000-000000000002\n' +
          'service_start_uptime=14.00\n' +
          'wrapper_pid=101\n',
        nodeContents:
          'schema=qinglong/physical-edge-service-node@v1\nnode_pid=102\n',
        activeContents:
          'schema=qinglong/physical-edge-service-active@v1\n' +
          'boot_id=019f0000-0000-4000-8000-000000000002\n' +
          'event_ordinal=1\n' +
          'active_uptime=13.25\n',
        eventContents:
          '{"schemaVersion":1,"component":"qinglong3-local-application","level":"info","event":"active","profile":"edge","aiStatus":"deployment_excluded"}\n',
      }),
    /monotonic ordering/,
  );
});

test('parses exact systemd and OpenRC active-enabled state', () => {
  assert.deepEqual(
    parseSystemdShow(
      'LoadState=loaded\n' +
        'ActiveState=active\n' +
        'SubState=running\n' +
        'UnitFileState=enabled\n' +
        'FragmentPath=/etc/systemd/system/qinglong3-physical-019f0000.service\n' +
        'MainPID=101\n',
    ),
    {
      active: true,
      enabled: true,
      fragmentPath: '/etc/systemd/system/qinglong3-physical-019f0000.service',
      mainPid: 101,
    },
  );
  assert.deepEqual(
    parseOpenRcState(
      0,
      ' qinglong3-physical-019f0000 | default\n',
      'qinglong3-physical-019f0000',
    ),
    { active: true, enabled: true, mainPid: null },
  );
  assert.equal(
    parseOpenRcState(
      3,
      ' qinglong3-physical-019f0000 | default\n',
      'qinglong3-physical-019f0000',
    ).active,
    false,
  );
});

test('normalizes a digest-bound install session', () => {
  const session = sessionFixture();
  assert.equal(session.service.descriptorMode, 0o644);
  assert.equal(
    session.service.descriptorDestination,
    '/etc/systemd/system/qinglong3-physical-019f0000.service',
  );
  assert.throws(
    () =>
      normalizeSession({
        ...session,
        service: { ...session.service, descriptorMode: 0o666 },
      }),
    /session is invalid or drifted/,
  );
});

test('accepts a bounded different-boot service report and rejects drift', () => {
  const report = reportFixture();
  assert.equal(report.qualification.passed, true);
  assert.deepEqual(
    validateServiceStartReport(
      report,
      manifest(),
      environment('019f0000-0000-4000-8000-000000000002'),
    ),
    [],
  );
  assert.equal(
    reportFixture({
      measurements: {
        serviceStartBootAgeMs: 12_000,
        activeBootAgeMs: 181_000,
        bootToActiveMs: 181_000,
        serviceStartToActiveMs: 169_000,
        activeEventOrdinal: 2,
      },
    }).qualification.passed,
    false,
  );
  assert.notDeepEqual(
    validateServiceStartReport(
      report,
      manifest(),
      environment('019f0000-0000-4000-8000-000000000099'),
    ),
    [],
  );
});

test('recomputes qualification instead of trusting a digest-valid passed flag', () => {
  const invalid = reportFixture({
    measurements: {
      serviceStartBootAgeMs: 12_000,
      activeBootAgeMs: 181_000,
      bootToActiveMs: 181_000,
      serviceStartToActiveMs: 169_000,
      activeEventOrdinal: 2,
    },
  });
  const { sha256: ignored, ...body } = invalid;
  const widenedBody = {
    ...body,
    qualification: {
      ...body.qualification,
      passed: true,
      violations: [],
    },
  };
  const widened = {
    ...widenedBody,
    sha256: canonicalDigest(widenedBody),
  };
  assert.notDeepEqual(
    validateServiceStartReport(
      widened,
      manifest(),
      environment('019f0000-0000-4000-8000-000000000002'),
    ),
    [],
  );
});

test('renders POSIX shell syntax with order-independent active predicates', () => {
  const session = sessionFixture();
  const source = renderEvidenceWrapper({
    applicationEntrypoint: session.paths.applicationEntrypoint,
    nodeExecutable: session.environment.nodeExecutable,
    paths: session.paths,
  });
  const syntax = spawnSync('/bin/sh', ['-n'], {
    input: source,
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  for (const predicate of [
    '"component":"qinglong3-local-application"',
    '"event":"active"',
    '"profile":"edge"',
    '"aiStatus":"deployment_excluded"',
  ]) {
    assert.ok(source.includes(predicate));
  }
  assert.equal((source.match(/active_candidate=0/g) ?? []).length, 4);
});

test('uses the recorded active uptime while rejecting a forged package closure', () => {
  const baseline = reportFixture();
  const delayed = reportFixture({
    observed: {
      ...baseline.observed,
      after: { ...baseline.observed.after, bootAgeMs: 900_000 },
    },
  });
  assert.equal(delayed.qualification.passed, true);

  const { sha256: ignored, ...body } = baseline;
  const forgedBody = {
    ...body,
    observed: {
      ...body.observed,
      artifact: {
        ...body.observed.artifact,
        packages: [...packages.slice(0, -1), 'unexpected'],
      },
    },
  };
  const forged = { ...forgedBody, sha256: canonicalDigest(forgedBody) };
  assert.notDeepEqual(
    validateServiceStartReport(
      forged,
      manifest(),
      environment('019f0000-0000-4000-8000-000000000002'),
    ),
    [],
  );
});

test('separates OpenRC status and runlevel enable executables', () => {
  const systemd = sessionFixture();
  const descriptorSource = `${systemd.paths.deploymentRoot}/service/qinglong3.openrc`;
  const descriptorDestination = `/etc/init.d/${systemd.service.serviceName}`;
  const { sha256: ignored, ...sessionBody } = systemd;
  const openRcBody = {
    ...sessionBody,
    service: {
      ...systemd.service,
      kind: 'openrc',
      managerExecutable: '/sbin/rc-service',
      managerSha256: '2'.repeat(64),
      enableExecutable: '/sbin/rc-update',
      enableSha256: '3'.repeat(64),
      descriptorSource,
      descriptorDestination,
      descriptorMode: 0o755,
      installArguments: [
        '-o',
        'root',
        '-g',
        'root',
        '-m',
        '755',
        descriptorSource,
        descriptorDestination,
      ],
      enableArguments: ['add', systemd.service.serviceName, 'default'],
    },
  };
  assert.equal(
    normalizeSession({
      ...openRcBody,
      sha256: canonicalDigest(openRcBody),
    }).service.enableExecutable,
    '/sbin/rc-update',
  );
  const invalidBody = {
    ...openRcBody,
    service: {
      ...openRcBody.service,
      enableExecutable: '/sbin/rc-service',
    },
  };
  assert.throws(
    () =>
      normalizeSession({
        ...invalidBody,
        sha256: canonicalDigest(invalidBody),
      }),
    /session is invalid or drifted/,
  );
});

test('rejects container or VM indicators before physical qualification', () => {
  const baseline = reportFixture();
  const virtual = reportFixture({
    observed: {
      ...baseline.observed,
      after: {
        ...baseline.observed.after,
        virtualizationIndicators: ['PID 1 cgroup'],
      },
    },
  });
  assert.equal(virtual.qualification.passed, false);
  assert.match(
    virtual.qualification.violations.join('; '),
    /device, Node or boot environment/,
  );
});

test(
  'runs the POSIX wrapper through a real Linux FIFO and Node child',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-service-wrapper-'));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = {
      applicationConfig: path.join(root, 'local-application.json'),
      fifo: path.join(root, 'events.fifo'),
      wrapper: path.join(root, 'boot-probe.sh'),
      wrapperStartRecord: path.join(root, 'wrapper-start.record'),
      nodeRecord: path.join(root, 'node.record'),
      activeRecord: path.join(root, 'active.record'),
      eventLog: path.join(root, 'events.jsonl'),
      stderrLog: path.join(root, 'stderr.log'),
    };
    const entrypoint = path.join(root, 'application.cjs');
    fs.writeFileSync(paths.applicationConfig, '{}\n', { mode: 0o600 });
    fs.writeFileSync(
      entrypoint,
      `'use strict';
const emit = (event) => process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  component: 'qinglong3-local-application',
  instanceId: 'physical-service-test',
  profile: 'edge',
  level: 'info',
  ...event,
}) + '\\n');
process.once('SIGTERM', () => {
  emit({ event: 'shutdown_requested', signal: 'SIGTERM' });
  emit({ event: 'stopped', stopResult: 'stopped' });
  process.exit(0);
});
emit({ event: 'starting' });
emit({ event: 'active', aiStatus: 'deployment_excluded' });
setInterval(() => {}, 1000);
`,
      { mode: 0o600 },
    );
    const fifo = spawnSync('/usr/bin/mkfifo', ['-m', '600', paths.fifo], {
      encoding: 'utf8',
    });
    assert.equal(fifo.status, 0, fifo.stderr);
    const wrapper = renderEvidenceWrapper({
      applicationEntrypoint: entrypoint,
      nodeExecutable: process.execPath,
      paths,
    });
    fs.writeFileSync(paths.wrapper, wrapper, { mode: 0o700 });
    const child = spawn(
      '/bin/sh',
      [paths.wrapper, process.execPath, '--config', paths.applicationConfig],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let wrapperStderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      wrapperStderr += chunk;
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(paths.activeRecord) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(paths.activeRecord), true);
    const observation = parseWrapperObservations({
      startContents: fs.readFileSync(paths.wrapperStartRecord, 'utf8'),
      nodeContents: fs.readFileSync(paths.nodeRecord, 'utf8'),
      activeContents: fs.readFileSync(paths.activeRecord, 'utf8'),
      eventContents: fs.readFileSync(paths.eventLog, 'utf8'),
    });
    assert.equal(observation.activeEventCount, 1);
    assert.equal(observation.activeEvent.aiStatus, 'deployment_excluded');
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('wrapper did not exit after SIGTERM')),
          5_000,
        );
        timer.unref();
      }),
    ]);
    assert.deepEqual(outcome, { code: 0, signal: null });
    assert.equal(wrapperStderr, '');
    assert.equal(fs.readFileSync(paths.stderrLog, 'utf8'), '');
  },
);
