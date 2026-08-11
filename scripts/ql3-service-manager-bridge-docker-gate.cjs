#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class QingLong3ServiceManagerBridgeDockerGateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QingLong3ServiceManagerBridgeDockerGateError';
  }
}

function fail(message) {
  throw new QingLong3ServiceManagerBridgeDockerGateError(message);
}

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal !== null || result.status !== 0) {
    fail(
      `docker ${args.join(' ')} failed: ${String(result.stderr ?? '').slice(
        0,
        2_048,
      )}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function waitReady(name, kind) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      'docker',
      [
        'exec',
        name,
        ...(kind === 'systemd'
          ? ['/usr/bin/systemctl', 'is-system-running']
          : ['/bin/true']),
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );
    if (
      kind === 'systemd'
        ? result.status === 0 ||
          String(result.stdout ?? '').trim() === 'degraded'
        : result.status === 0
    ) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  fail(`${kind} container did not become ready`);
}

function actorReport(name, kind, identityMode) {
  const stdout = run([
    'exec',
    name,
    'node',
    '/workspace/scripts/ql3-service-manager-bridge-live-actor.cjs',
    kind,
    identityMode,
  ]);
  const report = JSON.parse(stdout);
  const requiredGates = [
    'rootCommandFile',
    'descriptorInstalled',
    'enabledAndStarted',
    'exactReplay',
    'stopped',
    'ownerOutcomeVerified',
    'serviceProcessIdentity',
    'adoptedCutoverActive',
    'adoptedCutoverStopped',
  ];
  if (
    report.managerKind !== kind ||
    report.identityMode !== identityMode ||
    report.serviceUid !== (identityMode === 'root' ? 0 : 10001) ||
    !requiredGates.every((gate) => report.gates?.[gate] === true) ||
    (report.gates?.restartRequired === true &&
      report.gates?.restarted !== true) ||
    !/^[0-9a-f]{64}$/.test(report.sha256 ?? '')
  ) {
    fail(`${kind}/${identityMode} actor report is invalid`);
  }
  return report;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const suffix = `${process.pid}-${Date.now()}`;
  const targets = [
    {
      kind: 'systemd',
      image: `ql3-service-manager-systemd-gate:${suffix}`,
      dockerfile:
        'deploy/containers/ql3-service-manager-gate/systemd.Dockerfile',
    },
    {
      kind: 'openrc',
      image: `ql3-service-manager-openrc-gate:${suffix}`,
      dockerfile:
        'deploy/containers/ql3-service-manager-gate/openrc.Dockerfile',
    },
  ];
  const reports = [];
  const containers = [];
  try {
    for (const target of targets) {
      run(['build', '--file', target.dockerfile, '--tag', target.image, '.'], {
        cwd: root,
      });
      for (const identityMode of ['root', 'nonroot']) {
        const name = `ql3-service-manager-${target.kind}-${identityMode}-${suffix}`;
        containers.push(name);
        const common = [
          'run',
          '--detach',
          '--privileged',
          '--name',
          name,
          '--mount',
          `type=bind,src=${root},dst=/workspace,readonly`,
        ];
        run(
          target.kind === 'systemd'
            ? [
                ...common,
                '--cgroupns=host',
                '--tmpfs',
                '/run',
                '--tmpfs',
                '/run/lock',
                '--volume',
                '/sys/fs/cgroup:/sys/fs/cgroup:rw',
                target.image,
              ]
            : [...common, '--tmpfs', '/run', target.image],
        );
        waitReady(name, target.kind);
        reports.push(actorReport(name, target.kind, identityMode));
        run(['rm', '--force', name]);
        containers.splice(containers.indexOf(name), 1);
      }
    }
    const payload = {
      schemaVersion: 1,
      evidenceClass: 'qinglong3_service_manager_bridge_docker_gate',
      reports,
      gates: {
        systemdRoot: reports.some(
          (report) =>
            report.managerKind === 'systemd' && report.identityMode === 'root',
        ),
        systemdNonRoot: reports.some(
          (report) =>
            report.managerKind === 'systemd' &&
            report.identityMode === 'nonroot',
        ),
        openrcRoot: reports.some(
          (report) =>
            report.managerKind === 'openrc' && report.identityMode === 'root',
        ),
        openrcNonRoot: reports.some(
          (report) =>
            report.managerKind === 'openrc' &&
            report.identityMode === 'nonroot',
        ),
        rootCommandFile: reports.every(
          (report) => report.gates.rootCommandFile,
        ),
        exactReplay: reports.every((report) => report.gates.exactReplay),
        ownerOutcomeVerified: reports.every(
          (report) => report.gates.ownerOutcomeVerified,
        ),
        serviceProcessIdentity: reports.every(
          (report) => report.gates.serviceProcessIdentity,
        ),
        adoptedCutoverActive: reports.every(
          (report) => report.gates.adoptedCutoverActive,
        ),
        adoptedCutoverStopped: reports.every(
          (report) => report.gates.adoptedCutoverStopped,
        ),
        systemdRestart: reports.some(
          (report) =>
            report.managerKind === 'systemd' && report.gates.restarted,
        ),
        openrcRestart: reports.some(
          (report) => report.managerKind === 'openrc' && report.gates.restarted,
        ),
      },
    };
    process.stdout.write(
      `${JSON.stringify({
        ...payload,
        sha256: crypto
          .createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex'),
      })}\n`,
    );
  } finally {
    for (const name of containers.reverse()) {
      spawnSync('docker', ['rm', '--force', name], { encoding: 'utf8' });
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      code: 'QL3_SERVICE_MANAGER_BRIDGE_DOCKER_GATE_FAILED',
      name: error?.name ?? 'Error',
      message: error?.message ?? 'Docker gate failed',
    })}\n`,
  );
  process.exitCode = 1;
}
