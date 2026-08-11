const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  runLocalServiceBridge,
} = require('../dist/deployment/service-manager/serviceBridge.js');
const {
  prepareLocalServiceManagerIntent,
  consumeLocalServiceManagerOutcome,
} = require('../dist/deployment/service-manager/serviceManagerIntent.js');

const roots = [];
const destinations = [
  '/etc/systemd/system/qinglong3.service',
  '/etc/init.d/qinglong3',
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
  if (process.getuid?.() === 0) {
    for (const destination of destinations) {
      fs.rmSync(destination, { force: true });
      fs.rmSync(
        path.join(
          path.dirname(destination),
          `.${path.basename(destination)}.ql3-service-bridge-stage`,
        ),
        { force: true },
      );
    }
  }
});

function fixture(kind) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `ql3-service-bridge-${kind}-`)),
  );
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const service = path.join(root, 'service');
  fs.mkdirSync(service, { mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'local-application.json'),
    `${JSON.stringify({
      schema: 'qinglong/local-application-process@v2',
      instanceId: `${kind}-edge-1`,
      profile: 'edge',
      storage: { mode: 'fresh' },
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(
      service,
      kind === 'systemd' ? 'qinglong3.service' : 'qinglong3.openrc',
    ),
    kind === 'systemd'
      ? '[Service]\nExecStart=/usr/bin/node /opt/qinglong3/app.js\n'
      : '#!/sbin/openrc-run\ncommand=/usr/bin/node\n',
    { mode: kind === 'systemd' ? 0o600 : 0o700 },
  );
  const controllerRoot = path.join(root, 'root-controller');
  return { root, controllerRoot };
}

function prepare(root, kind, actionId, action) {
  return prepareLocalServiceManagerIntent({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: { deploymentRoot: root, allowRootService: true },
    request: {
      actionId,
      action,
      serviceKind: kind,
      lineage: { mode: 'fresh' },
      requestedAtMs: 1786416100000,
    },
  });
}

function bridgeCommand(prepared, controllerRoot, kind) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.execute',
    options: {
      controllerRoot,
      allowRootController: true,
      manager:
        kind === 'systemd'
          ? { kind, executable: '/usr/bin/true' }
          : {
              kind,
              serviceExecutable: '/usr/bin/true',
              updateExecutable: '/usr/bin/true',
            },
    },
    request: {
      intentPath: prepared.intentPath,
      expectedIntentDigest: prepared.intentDigest,
    },
  };
}

function result(status, stdout = '', responseLost = false) {
  return { status, signal: null, stdout, stderr: '', responseLost };
}

test(
  'root systemd bridge installs, starts, survives response loss and replays without mutation',
  { skip: process.getuid?.() !== 0 },
  () => {
    const { root, controllerRoot } = fixture('systemd');
    const state = { active: false, enabled: false, pid: 0, loseRestart: false };
    const calls = [];
    const runner = ({ args }) => {
      calls.push([...args]);
      if (args[0] === 'show') {
        return result(
          0,
          [
            'LoadState=loaded',
            `ActiveState=${state.active ? 'active' : 'inactive'}`,
            `SubState=${state.active ? 'running' : 'dead'}`,
            'FragmentPath=/etc/systemd/system/qinglong3.service',
            `MainPID=${state.pid}`,
            `UnitFileState=${state.enabled ? 'enabled' : 'disabled'}`,
            '',
          ].join('\n'),
        );
      }
      if (args[0] === 'enable') state.enabled = true;
      if (args[0] === 'start') {
        state.active = true;
        state.pid = 4101;
      }
      if (args[0] === 'restart') {
        state.active = true;
        state.pid += 1;
        if (state.loseRestart) return result(null, '', true);
      }
      if (args[0] === 'stop') {
        state.active = false;
        state.pid = 0;
      }
      return result(0);
    };
    let now = 1786416100100;
    const dependencies = { runManager: runner, now: () => now++ };

    const first = prepare(
      root,
      'systemd',
      '123e4567-e89b-42d3-a456-426614174021',
      'install-enable-start',
    );
    const firstResult = runLocalServiceBridge(
      bridgeCommand(first, controllerRoot, 'systemd'),
      dependencies,
    );
    assert.equal(firstResult.state, 'active');
    assert.equal(fs.statSync('/etc/systemd/system/qinglong3.service').uid, 0);
    assert.equal(
      fs.statSync('/etc/systemd/system/qinglong3.service').mode & 0o777,
      0o644,
    );
    const callCount = calls.length;
    assert.equal(
      runLocalServiceBridge(
        bridgeCommand(first, controllerRoot, 'systemd'),
        dependencies,
      ).status,
      'existing',
    );
    assert.equal(calls.length, callCount);

    state.loseRestart = true;
    const restart = prepare(
      root,
      'systemd',
      '123e4567-e89b-42d3-a456-426614174022',
      'restart',
    );
    const restarted = runLocalServiceBridge(
      bridgeCommand(restart, controllerRoot, 'systemd'),
      dependencies,
    );
    assert.equal(restarted.state, 'active');
    const outcome = JSON.parse(fs.readFileSync(restart.outcomePath, 'utf8'));
    assert.equal(outcome.mutationDisposition, 'response-loss-inspected');
    assert.equal(outcome.observation.mainPid, 4102);
    assert.equal(
      consumeLocalServiceManagerOutcome({
        schemaVersion: 1,
        operation: 'local.deployment.service-manager.outcome.consume',
        options: { deploymentRoot: root, allowRootService: true },
        request: {
          actionId: restart.actionId,
          expectedIntentDigest: restart.intentDigest,
        },
      }).state,
      'active',
    );
  },
);

test(
  'root bridge rejects Owner descriptor drift before publishing a barrier',
  { skip: process.getuid?.() !== 0 },
  () => {
    const { root, controllerRoot } = fixture('systemd');
    const prepared = prepare(
      root,
      'systemd',
      '123e4567-e89b-42d3-a456-426614174041',
      'install-enable-start',
    );
    fs.writeFileSync(
      path.join(root, 'service', 'qinglong3.service'),
      '[Service]\nExecStart=/usr/bin/false\n',
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        runLocalServiceBridge(
          bridgeCommand(prepared, controllerRoot, 'systemd'),
          { runManager: () => result(0) },
        ),
      /service manager source material drifted/,
    );
    assert.equal(fs.existsSync(controllerRoot), false);
  },
);

test(
  'barrier replay never repeats mutation after a crash and replaced installed unit',
  { skip: process.getuid?.() !== 0 },
  () => {
    const { root, controllerRoot } = fixture('systemd');
    const prepared = prepare(
      root,
      'systemd',
      '123e4567-e89b-42d3-a456-426614174042',
      'install-enable-start',
    );
    let crash = true;
    const calls = [];
    const runner = ({ args }) => {
      calls.push([...args]);
      if (args[0] === 'show') {
        return result(
          0,
          [
            'LoadState=loaded',
            'ActiveState=inactive',
            'SubState=dead',
            'FragmentPath=/etc/systemd/system/qinglong3.service',
            'MainPID=0',
            'UnitFileState=disabled',
            '',
          ].join('\n'),
        );
      }
      if (args[0] === 'enable' && crash) throw new Error('injected crash');
      return result(0);
    };
    assert.throws(
      () =>
        runLocalServiceBridge(
          bridgeCommand(prepared, controllerRoot, 'systemd'),
          { runManager: runner, now: () => 1786416300000 },
        ),
      /injected crash/,
    );
    assert.equal(
      fs.existsSync(
        path.join(controllerRoot, prepared.actionId, 'barrier.json'),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(controllerRoot, prepared.actionId, 'outcome.json'),
      ),
      false,
    );
    fs.writeFileSync(
      '/etc/systemd/system/qinglong3.service',
      '[Service]\nExecStart=/usr/bin/false\n',
      { mode: 0o644 },
    );
    crash = false;
    const mutationsBeforeReplay = calls.filter(
      (args) => args[0] !== 'show',
    ).length;
    const replay = runLocalServiceBridge(
      bridgeCommand(prepared, controllerRoot, 'systemd'),
      { runManager: runner, now: () => 1786416300100 },
    );
    assert.equal(replay.state, 'manual_required');
    const outcome = JSON.parse(fs.readFileSync(prepared.outcomePath, 'utf8'));
    assert.equal(outcome.manualReason, 'descriptor_install_unproved');
    assert.equal(outcome.mutationDisposition, 'replay-inspected');
    assert.equal(
      calls.filter((args) => args[0] !== 'show').length,
      mutationsBeforeReplay,
    );
  },
);

test(
  'root outcome survives Owner outcome preoccupation without overwriting it',
  { skip: process.getuid?.() !== 0 },
  () => {
    const { root, controllerRoot } = fixture('systemd');
    const prepared = prepare(
      root,
      'systemd',
      '123e4567-e89b-42d3-a456-426614174043',
      'install-enable-start',
    );
    fs.writeFileSync(prepared.outcomePath, '{}\n', { mode: 0o600 });
    const state = { active: false, enabled: false, pid: 0 };
    let mutations = 0;
    const runner = ({ args }) => {
      if (args[0] === 'show') {
        return result(
          0,
          [
            'LoadState=loaded',
            `ActiveState=${state.active ? 'active' : 'inactive'}`,
            `SubState=${state.active ? 'running' : 'dead'}`,
            'FragmentPath=/etc/systemd/system/qinglong3.service',
            `MainPID=${state.pid}`,
            `UnitFileState=${state.enabled ? 'enabled' : 'disabled'}`,
            '',
          ].join('\n'),
        );
      }
      mutations += 1;
      if (args[0] === 'enable') state.enabled = true;
      if (args[0] === 'start') {
        state.active = true;
        state.pid = 6101;
      }
      return result(0);
    };
    assert.throws(
      () =>
        runLocalServiceBridge(
          bridgeCommand(prepared, controllerRoot, 'systemd'),
          { runManager: runner, now: () => 1786416400000 },
        ),
      /service bridge Owner outcome drifted/,
    );
    assert.equal(fs.readFileSync(prepared.outcomePath, 'utf8'), '{}\n');
    assert.equal(
      fs.existsSync(
        path.join(controllerRoot, prepared.actionId, 'outcome.json'),
      ),
      true,
    );
    const mutationsAfterFirst = mutations;
    assert.throws(
      () =>
        runLocalServiceBridge(
          bridgeCommand(prepared, controllerRoot, 'systemd'),
          { runManager: runner, now: () => 1786416400100 },
        ),
      /service bridge Owner outcome drifted/,
    );
    assert.equal(mutations, mutationsAfterFirst);
    assert.equal(fs.readFileSync(prepared.outcomePath, 'utf8'), '{}\n');
  },
);

test(
  'root OpenRC bridge uses fixed update/service argv for install and stop',
  { skip: process.getuid?.() !== 0 },
  () => {
    fs.mkdirSync('/etc/init.d', { mode: 0o755, recursive: true });
    const { root, controllerRoot } = fixture('openrc');
    const state = { active: false, enabled: false, loseStart: true };
    const calls = [];
    const runner = ({ args }) => {
      calls.push([...args]);
      if (args[0] === 'show') {
        return result(0, state.enabled ? ' qinglong3 | default\n' : '');
      }
      if (args[1] === 'status') {
        return state.active
          ? result(0, 'status: started\n')
          : result(3, 'status: stopped\n');
      }
      if (args[0] === 'add') state.enabled = true;
      if (args[1] === 'start') {
        state.active = true;
        if (state.loseStart) return result(null, '', true);
      }
      if (args[1] === 'stop') state.active = false;
      return result(0);
    };
    let now = 1786416200000;
    const dependencies = { runManager: runner, now: () => now++ };
    const install = prepare(
      root,
      'openrc',
      '123e4567-e89b-42d3-a456-426614174031',
      'install-enable-start',
    );
    const installed = runLocalServiceBridge(
      bridgeCommand(install, controllerRoot, 'openrc'),
      dependencies,
    );
    assert.equal(installed.state, 'active');
    const installedOutcome = JSON.parse(
      fs.readFileSync(install.outcomePath, 'utf8'),
    );
    assert.equal(
      installedOutcome.mutationDisposition,
      'response-loss-inspected',
    );
    const callCount = calls.length;
    assert.equal(
      runLocalServiceBridge(
        bridgeCommand(install, controllerRoot, 'openrc'),
        dependencies,
      ).status,
      'existing',
    );
    assert.equal(calls.length, callCount);
    state.loseStart = false;
    const stop = prepare(
      root,
      'openrc',
      '123e4567-e89b-42d3-a456-426614174032',
      'stop',
    );
    assert.equal(
      runLocalServiceBridge(
        bridgeCommand(stop, controllerRoot, 'openrc'),
        dependencies,
      ).state,
      'stopped',
    );
    assert.ok(calls.some((args) => args.join(' ') === 'add qinglong3 default'));
    assert.ok(calls.some((args) => args.join(' ') === 'qinglong3 start'));
    assert.ok(calls.some((args) => args.join(' ') === 'qinglong3 stop'));
  },
);
